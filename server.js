/* Düz Okey sunucusu: giriş, oyun kuralları, botlar. Çalıştır: npm install && npm start */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const C = require('./public/okey-core.js');

const PORT = process.env.PORT || 3000;
const SOLO = process.argv.includes('--solo'); // tek başına test: kolpacı girmezse partner bot oynar

// ====== KULLANICILAR ======
// Şifreler koda yazılmaz: users.json dosyasından (git'e gitmez) ya da OKEY_USERS ortam değişkeninden okunur.
// Biçim: {"keremo":{"pass":"...","seat":0},"kolpacı":{"pass":"...","seat":2}}
function loadUsers() {
  try {
    if (process.env.OKEY_USERS) return JSON.parse(process.env.OKEY_USERS);
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));
  } catch (e) {
    console.error('Kullanıcılar okunamadı. users.json dosyasını ya da OKEY_USERS değişkenini ayarla.');
    process.exit(1);
  }
}
const USERS = loadUsers();
const NAMES = ['keremo', 'Kurnaz Bot', 'kolpacı', 'Sinsi Bot']; // koltuk 0 ve 2 gerçek oyuncu (eş), 1 ve 3 bot
const TEAM_NAMES = ['keremo & kolpacı', 'Botlar'];

const scores = [0, 0];
let game = null;
let gidCounter = 0;
const clients = new Map(); // seat -> ws

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const fails = new Map(); // ip -> {n, until}

const isBot = s => s === 1 || s === 3 || (SOLO && s === 2 && !clients.has(2));
const humansReady = () => clients.has(0) && (clients.has(2) || SOLO);

// ====== OYUN ======
function newGame() {
  const deck = C.shuffle(C.makeDeck());
  const dealer = game ? (game.dealer + 1) % 4 : Math.floor(Math.random() * 4);
  const hands = [[], [], [], []];
  for (let s = 0; s < 4; s++) {
    const cnt = s === dealer ? 15 : 14;
    for (let i = 0; i < cnt; i++) hands[s].push(deck.pop());
  }
  const gi = deck.findIndex(t => !t.fake);
  const gosterge = deck.splice(gi, 1)[0];
  game = {
    id: ++gidCounter, phase: 'playing', hands, deck, gosterge,
    okey: C.okeyFromGosterge(gosterge), discards: [[], [], [], []],
    taken: [[], [], [], []], dealer, turn: dealer, hasDrawn: true,
    lastDrawn: null, log: [NAMES[dealer] + ' eli dağıttı ve başlıyor.'], over: null,
  };
  broadcast();
  botTurn();
}

function pushLog(m) { game.log.push(m); if (game.log.length > 30) game.log.shift(); }

function doDraw(seat, from) {
  const g = game;
  if (!g || g.phase !== 'playing' || g.turn !== seat || g.hasDrawn) return 'Sıra sende değil.';
  if (from === 'deck') {
    if (!g.deck.length) return endDraw();
    const t = g.deck.pop();
    g.hands[seat].push(t);
    g.lastDrawn = { seat, id: t.id, from };
    pushLog(NAMES[seat] + ' ortadan taş çekti.');
  } else {
    const prev = (seat + 3) % 4;
    const t = g.discards[prev].pop();
    if (!t) return 'Yanda alınacak taş yok.';
    g.hands[seat].push(t);
    g.taken[seat].push(t);
    g.lastDrawn = { seat, id: t.id, from };
    pushLog(NAMES[seat] + ' yandan taş aldı.');
  }
  g.hasDrawn = true;
  broadcast();
  return null;
}

function endDraw() {
  const g = game;
  g.phase = 'over';
  g.over = { draw: true, text: 'Ortadaki taşlar bitti, el berabere.' };
  pushLog(g.over.text);
  broadcast();
  return null;
}

function doDiscard(seat, id) {
  const g = game;
  if (!g || g.phase !== 'playing' || g.turn !== seat || !g.hasDrawn) return 'Önce taş çekmelisin.';
  const i = g.hands[seat].findIndex(t => t.id === id);
  if (i < 0) return 'Bu taş elinde yok.';
  const [t] = g.hands[seat].splice(i, 1);
  g.discards[seat].push(t);
  g.hasDrawn = false;
  g.turn = (seat + 1) % 4;
  pushLog(NAMES[seat] + ' taş attı.');
  if (!g.deck.length) { endDraw(); return null; }
  broadcast();
  botTurn();
  return null;
}

function finishGame(seat, tile, type) {
  const g = game;
  const rest = g.hands[seat].filter(x => x.id !== tile.id);
  let pts = 2, notes = [];
  if (type === 'cift') { pts *= 2; notes.push('çiftle'); }
  if (C.isJoker(tile, g.okey)) { pts *= 2; notes.push('okey atarak'); }
  const arr = type === 'cift' ? C.arrangeCift(rest, g.okey) : C.arrangeSeri(rest, g.okey);
  const team = seat % 2;
  scores[team] += pts;
  g.phase = 'over';
  g.over = {
    seat, type, points: pts, team,
    text: NAMES[seat] + ' ' + (notes.length ? notes.join(' ') + ' ' : '') + 'bitirdi! ' + TEAM_NAMES[team] + ' +' + pts,
    hand: arr.groups.concat(arr.rest.map(t => [t])), finishTile: tile,
  };
  pushLog(g.over.text);
  broadcast();
}

function doFinish(seat, id) {
  const g = game;
  if (!g || g.phase !== 'playing' || g.turn !== seat || !g.hasDrawn) return 'Önce taş çekmelisin.';
  const tile = g.hands[seat].find(t => t.id === id);
  if (!tile) return 'Bu taş elinde yok.';
  const type = C.canFinishWith(g.hands[seat], tile, g.okey);
  if (!type) return 'Elin bu taşla bitmiyor.';
  finishGame(seat, tile, type);
  return null;
}

// Yandaki taşı alıp aynı anda bitirme (taşı BİTİR alanına sürükle)
function doFinishSide(seat) {
  const g = game;
  if (!g || g.phase !== 'playing' || g.turn !== seat || g.hasDrawn) return 'Şu an yandan alıp bitiremezsin.';
  const prev = (seat + 3) % 4;
  const side = g.discards[prev][g.discards[prev].length - 1];
  if (!side) return 'Yanda taş yok.';
  const h15 = g.hands[seat].concat([side]);
  const opts = C.finishOptions(h15, g.okey);
  if (!opts.length) return 'Yandaki taşla elin bitmiyor.';
  opts.sort((a, b) => (C.isJoker(b.tile, g.okey) - C.isJoker(a.tile, g.okey)) || ((b.type === 'cift') - (a.type === 'cift')));
  g.discards[prev].pop();
  g.hands[seat] = h15;
  g.hasDrawn = true;
  g.lastDrawn = { seat, id: side.id, from: 'side' };
  finishGame(seat, opts[0].tile, opts[0].type);
  return null;
}

// ====== BOT ======
function botTurn() {
  const g = game;
  if (!g || g.phase !== 'playing' || !isBot(g.turn)) return;
  const gid = g.id, seat = g.turn;
  setTimeout(() => {
    if (!game || game.id !== gid || game.phase !== 'playing' || game.turn !== seat) return;
    if (!game.hasDrawn) {
      const prev = (seat + 3) % 4;
      const side = game.discards[prev][game.discards[prev].length - 1];
      if (side && C.shouldTakeSide(game.hands[seat], side, game.okey)) {
        const h15 = game.hands[seat].concat([side]);
        if (C.finishOptions(h15, game.okey).length) { doFinishSide(seat); return; }
        doDraw(seat, 'side');
      } else {
        doDraw(seat, 'deck');
      }
      if (!game || game.phase !== 'playing') return;
    }
    setTimeout(() => {
      if (!game || game.id !== gid || game.phase !== 'playing' || game.turn !== seat || !game.hasDrawn) return;
      const hand = game.hands[seat];
      const opts = C.finishOptions(hand, game.okey);
      if (opts.length) {
        opts.sort((a, b) => (C.isJoker(b.tile, game.okey) - C.isJoker(a.tile, game.okey)));
        finishGame(seat, opts[0].tile, opts[0].type);
        return;
      }
      const next = (seat + 1) % 4;
      const tile = C.bestDiscard(hand, game.okey, game.taken[next]);
      doDiscard(seat, tile.id);
    }, 900);
  }, 1100);
}

// ====== YAYIN ======
function stateFor(seat) {
  const g = game;
  const st = {
    t: 'state', you: seat, names: NAMES, teamNames: TEAM_NAMES, scores,
    online: [clients.has(0), true, clients.has(2) || (SOLO), true], solo: SOLO,
    phase: g ? g.phase : 'waiting',
  };
  if (g) {
    Object.assign(st, {
      gid: g.id, hand: g.hands[seat], counts: g.hands.map(h => h.length), deckCount: g.deck.length,
      gosterge: g.gosterge, okey: g.okey,
      discards: g.discards.map(d => d[d.length - 1] || null),
      turn: g.turn, hasDrawn: g.hasDrawn, dealer: g.dealer, lastDrawn: g.lastDrawn,
      log: g.log.slice(-6), over: g.over,
    });
  }
  return st;
}
function broadcast() {
  for (const [seat, ws] of clients) if (ws.readyState === 1) ws.send(JSON.stringify(stateFor(seat)));
}
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

// ====== HTTP + WS ======
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUB = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  ws.seat = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'login') {
      const f = fails.get(ip);
      if (f && f.until > Date.now()) return send(ws, { t: 'loginfail', text: 'Çok fazla hatalı deneme. 1 dakika bekle.' });
      const name = String(m.u || '').trim().toLocaleLowerCase('tr');
      const u = Object.prototype.hasOwnProperty.call(USERS, name) ? USERS[name] : null;
      if (!u || !safeEq(u.pass, m.p || '')) {
        const n = ((f && f.n) || 0) + 1;
        fails.set(ip, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
        return send(ws, { t: 'loginfail', text: 'Kullanıcı adı veya şifre hatalı.' });
      }
      fails.delete(ip);
      const old = clients.get(u.seat);
      if (old && old !== ws) { send(old, { t: 'kicked' }); old.seat = null; old.close(); }
      ws.seat = u.seat;
      clients.set(u.seat, ws);
      send(ws, { t: 'loginok', seat: u.seat, name: NAMES[u.seat] });
      if (!game && humansReady()) newGame();
      else broadcast();
      return;
    }
    if (ws.seat === null) return;
    let err = null;
    if (m.t === 'draw') err = doDraw(ws.seat, m.from === 'side' ? 'side' : 'deck');
    else if (m.t === 'discard') err = doDiscard(ws.seat, m.id);
    else if (m.t === 'finish') err = doFinish(ws.seat, m.id);
    else if (m.t === 'finishSide') err = doFinishSide(ws.seat);
    else if (m.t === 'newgame') { if (game && game.phase === 'over' && humansReady()) newGame(); }
    if (err) send(ws, { t: 'msg', text: err });
  });

  ws.on('close', () => {
    if (ws.seat !== null && clients.get(ws.seat) === ws) {
      clients.delete(ws.seat);
      broadcast();
    }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Düz Okey çalışıyor: http://localhost:' + PORT + (SOLO ? '  (solo test modu)' : ''));
});

/* Düz Okey v3: masalar, botlar, Kastamonu usulü puan tablosu. Çalıştır: npm install && npm start */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const C = require('./public/okey-core.js');

const PORT = process.env.PORT || 3000;
const ROUNDS = 13;
const DELAY = process.env.FAST ? [5, 5] : [1100, 900]; // bot bekleme süreleri (ms)
const KINDS = { b2: { seats: [0, 2] }, b1: { seats: [0, 1, 2] }, h4: { seats: [0, 1, 2, 3] } };
const BOT_NAMES = ['Cin Bot', 'Kurnaz Bot', 'Usta Bot', 'Sinsi Bot'];

const tables = new Map();
const people = new Map(); // cid -> {cid, name, ws, tableId}
let tidCounter = 0, gidCounter = 0;

const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const seatOnline = s => !!s && (s.type === 'bot' || !!(people.get(s.cid) && people.get(s.cid).ws));
const humanSeats = t => [0, 1, 2, 3].filter(i => t.seats[i] && t.seats[i].type === 'human');
const needSeats = t => KINDS[t.kind].seats;
const openSeat = t => needSeats(t).find(i => !t.seats[i]);
const mySeat = (t, p) => t.seats.findIndex(s => s && s.type === 'human' && s.cid === p.cid);
const tableOf = p => (p.tableId && tables.get(p.tableId)) || null;
const isAuto = (t, i) => {
  const s = t.seats[i];
  if (!s) return false;
  if (s.type === 'bot') return true;
  return !seatOnline(s) && Date.now() - (s.offlineSince || Date.now()) > 30000;
};

function colsOf(t) {
  const lists = t.mode === 'esli' ? [[0, 2], [1, 3]] : [[0], [1], [2], [3]];
  return lists.map(seats => ({ seats, label: seats.map(i => (t.seats[i] ? t.seats[i].name : '')).join(' & ') }));
}
function totalsOf(t) {
  return colsOf(t).map((_, ci) => t.rows.reduce((a, r) => a + (r.cells[ci].line ? -100 : r.cells[ci].v), 0));
}

/* ===== yayın ===== */
function lobbyList() {
  return [...tables.values()].filter(t => t.phase === 'lobby' && openSeat(t) !== undefined).map(t => ({
    id: t.id, kind: t.kind, mode: t.mode,
    seats: t.seats.map((s, i) => (!needSeats(t).includes(i) ? 'bot' : s ? s.name : null)),
  }));
}
function sendLobby(p) { if (p.ws && !tableOf(p)) send(p.ws, { t: 'lobby', tables: lobbyList() }); }
function broadcastLobby() { for (const p of people.values()) sendLobby(p); }

function stateFor(t, seat) {
  const g = t.g;
  const st = {
    t: 'table', id: t.id, kind: t.kind, mode: t.mode, you: seat, phase: t.phase,
    creator: !!t.seats[seat] && t.creatorCid === t.seats[seat].cid,
    names: t.seats.map(s => (s ? s.name : null)),
    bots: t.seats.map((s, i) => !needSeats(t).includes(i) || (!!s && s.type === 'bot')),
    online: t.seats.map(s => seatOnline(s)),
    round: t.round, rounds: ROUNDS, cols: colsOf(t), rows: t.rows, totals: totalsOf(t), drawn: !!t.drawn,
  };
  if (g && t.phase !== 'lobby') {
    const me = t.seats[seat];
    Object.assign(st, {
      gid: g.id, hand: g.hands[seat], counts: g.hands.map(h => h.length), deckCount: g.deck.length,
      gosterge: g.gosterge, okey: g.okey, discards: g.discards.map(d => d[d.length - 1] || null),
      turn: g.turn, hasDrawn: g.hasDrawn, dealer: g.dealer, lastDrawn: g.lastDrawn,
      iReady: !!me && t.ready.has(me.cid), readyCount: t.ready.size,
    });
  }
  return st;
}
function broadcastTable(t) {
  for (const i of humanSeats(t)) {
    const p = people.get(t.seats[i].cid);
    if (p && p.ws) send(p.ws, stateFor(t, i));
  }
}

/* ===== masa yönetimi ===== */
function createTable(p, kind) {
  if (!KINDS[kind] || tableOf(p) || tables.size >= 30) return;
  const t = {
    id: ++tidCounter, kind, mode: null, creatorCid: p.cid, seats: [null, null, null, null], phase: 'lobby',
    g: null, round: 0, rows: [], ready: new Set(), dealer: -1, drawn: false, emptySince: null,
  };
  for (let i = 0; i < 4; i++) if (!needSeats(t).includes(i)) t.seats[i] = { type: 'bot', name: BOT_NAMES[i] };
  tables.set(t.id, t);
  sit(t, p, needSeats(t)[0]);
  broadcastTable(t); broadcastLobby();
}
function sit(t, p, i) {
  t.seats[i] = { type: 'human', cid: p.cid, name: p.name, offlineSince: null };
  p.tableId = t.id;
}
function maybeStart(t) {
  if (t.phase !== 'lobby' || !t.mode || openSeat(t) !== undefined) return;
  t.round = 1; t.rows = []; t.phase = 'playing';
  startRound(t);
}
function leaveTable(p) {
  const t = tableOf(p);
  if (!t) return;
  const i = mySeat(t, p);
  p.tableId = null;
  if (i >= 0) {
    if (t.phase === 'lobby') t.seats[i] = null;
    else t.seats[i] = { type: 'bot', name: p.name + ' (Bot)' };
  }
  if (!humanSeats(t).length) { destroyTable(t); }
  else {
    if (t.creatorCid === p.cid) t.creatorCid = t.seats[humanSeats(t)[0]].cid;
    if (t.phase === 'roundover') checkReady(t);
    broadcastTable(t);
    if (t.phase === 'playing') botTurn(t);
  }
  if (!people.get(p.cid) || !p.ws) people.delete(p.cid);
  sendLobby(p); broadcastLobby();
}
function destroyTable(t) {
  tables.delete(t.id);
  for (const i of humanSeats(t)) {
    const p = people.get(t.seats[i].cid);
    if (p) { p.tableId = null; if (!p.ws) people.delete(p.cid); else send(p.ws, { t: 'left' }); }
  }
  broadcastLobby();
}

/* ===== oyun ===== */
function startRound(t) {
  const deck = C.shuffle(C.makeDeck());
  t.dealer = t.dealer < 0 ? Math.floor(Math.random() * 4) : (t.dealer + 1) % 4;
  const hands = [[], [], [], []];
  for (let s = 0; s < 4; s++) for (let k = 0; k < (s === t.dealer ? 15 : 14); k++) hands[s].push(deck.pop());
  const gosterge = deck.splice(deck.findIndex(x => !x.fake), 1)[0];
  t.g = {
    id: ++gidCounter, hands, deck, gosterge, okey: C.okeyFromGosterge(gosterge), discards: [[], [], [], []],
    taken: [[], [], [], []], dealer: t.dealer, turn: t.dealer, hasDrawn: true, lastDrawn: null, botBusy: false,
  };
  t.phase = 'playing'; t.ready = new Set(); t.drawn = false;
  broadcastTable(t); botTurn(t);
}
const after = t => { broadcastTable(t); botTurn(t); };

function doDraw(t, seat, from) {
  const g = t.g;
  if (!g || t.phase !== 'playing' || g.turn !== seat || g.hasDrawn) return 'Sıra sende değil';
  if (from === 'deck') {
    if (!g.deck.length) return endDraw(t);
    const x = g.deck.pop();
    g.hands[seat].push(x);
    g.lastDrawn = { seat, id: x.id, from };
  } else {
    const prev = (seat + 3) % 4;
    const x = g.discards[prev].pop();
    if (!x) return 'Yanda taş yok';
    g.hands[seat].push(x); g.taken[seat].push(x);
    g.lastDrawn = { seat, id: x.id, from };
  }
  g.hasDrawn = true;
  after(t);
  return null;
}
function endDraw(t) {
  t.phase = 'roundover'; t.drawn = true; t.ready = new Set();
  broadcastTable(t);
  return null;
}
function doDiscard(t, seat, id) {
  const g = t.g;
  if (!g || t.phase !== 'playing' || g.turn !== seat || !g.hasDrawn) return 'Önce taş çek';
  const i = g.hands[seat].findIndex(x => x.id === id);
  if (i < 0) return 'Bu taş yok';
  g.discards[seat].push(g.hands[seat].splice(i, 1)[0]);
  g.hasDrawn = false;
  g.turn = (seat + 1) % 4;
  if (!g.deck.length) return endDraw(t);
  after(t);
  return null;
}

// Kastamonu usulü puan: kaybedenin per olmayan taşları x10 (gösterge mavi ise x20), okey ile bitiş +2000 (mavide +4000), kazanan çizgi (-100)
function finishRound(t, seat, tile) {
  const g = t.g;
  const blue = g.gosterge.c === 1;
  const mult = blue ? 20 : 10;
  const bonus = C.isJoker(tile, g.okey) ? (blue ? 4000 : 2000) : 0;
  const cols = colsOf(t);
  const win = cols.findIndex(c => c.seats.includes(seat));
  const cells = cols.map((c, ci) => {
    if (ci === win) return { line: true };
    let sum = 0;
    for (const s of c.seats) sum += C.leftoverSum(g.hands[s], g.okey);
    return { v: sum * mult + bonus };
  });
  t.rows.push({ cells });
  t.phase = t.round >= ROUNDS ? 'finished' : 'roundover';
  t.ready = new Set();
  broadcastTable(t);
}
function doFinish(t, seat, id) {
  const g = t.g;
  if (!g || t.phase !== 'playing' || g.turn !== seat || !g.hasDrawn) return 'Önce taş çek';
  const tile = g.hands[seat].find(x => x.id === id);
  if (!tile) return 'Bu taş yok';
  if (!C.canFinishWith(g.hands[seat], tile, g.okey)) return 'Bitmiyor';
  finishRound(t, seat, tile);
  return null;
}
function doFinishSide(t, seat) {
  const g = t.g;
  if (!g || t.phase !== 'playing' || g.turn !== seat || g.hasDrawn) return 'Sıra sende değil';
  const prev = (seat + 3) % 4;
  const side = g.discards[prev][g.discards[prev].length - 1];
  if (!side) return 'Yanda taş yok';
  const h15 = g.hands[seat].concat([side]);
  const opts = C.finishOptions(h15, g.okey);
  if (!opts.length) return 'Bitmiyor';
  opts.sort((a, b) => C.isJoker(b.tile, g.okey) - C.isJoker(a.tile, g.okey));
  g.discards[prev].pop();
  g.hands[seat] = h15; g.hasDrawn = true; g.lastDrawn = { seat, id: side.id, from: 'side' };
  finishRound(t, seat, opts[0].tile);
  return null;
}
function checkReady(t) {
  if (t.phase !== 'roundover') return;
  const need = humanSeats(t).filter(i => seatOnline(t.seats[i])).map(i => t.seats[i].cid);
  if (need.length && need.every(c => t.ready.has(c))) {
    if (!t.drawn) t.round++;
    startRound(t);
  }
}

/* ===== bot ===== */
function botTurn(t) {
  const g = t.g;
  if (!g || t.phase !== 'playing' || g.botBusy) return;
  const seat = g.turn;
  if (!isAuto(t, seat)) return;
  g.botBusy = true;
  const gid = g.id;
  const alive = () => tables.has(t.id) && t.g && t.g.id === gid && t.phase === 'playing' && t.g.turn === seat;
  setTimeout(() => {
    if (!alive()) { g.botBusy = false; return; }
    if (!g.hasDrawn) {
      const prev = (seat + 3) % 4;
      const side = g.discards[prev][g.discards[prev].length - 1];
      if (side && C.shouldTakeSide(g.hands[seat], side, g.okey)) {
        if (C.finishOptions(g.hands[seat].concat([side]), g.okey).length) { g.botBusy = false; doFinishSide(t, seat); return; }
        doDraw(t, seat, 'side');
      } else doDraw(t, seat, 'deck');
      if (!alive()) { g.botBusy = false; return; }
    }
    setTimeout(() => {
      if (!alive()) { g.botBusy = false; return; }
      g.botBusy = false;
      const hand = g.hands[seat];
      const opts = C.finishOptions(hand, g.okey);
      if (opts.length) {
        opts.sort((a, b) => C.isJoker(b.tile, g.okey) - C.isJoker(a.tile, g.okey));
        finishRound(t, seat, opts[0].tile);
        return;
      }
      doDiscard(t, seat, C.bestDiscard(hand, g.okey, g.taken[(seat + 1) % 4]).id);
    }, DELAY[1]);
  }, DELAY[0]);
}

/* ===== bağlantılar ===== */
function hello(ws, m) {
  const name = String(m.name || '').trim().replace(/\s+/g, ' ');
  const cid = String(m.cid || '').slice(0, 64);
  if (!cid || name.length < 2 || name.length > 16 || !/^[\p{L}\p{N} _.\-]+$/u.test(name)) return send(ws, { t: 'denied', text: 'Geçersiz isim' });
  const lower = name.toLocaleLowerCase('tr');
  for (const q of people.values()) if (q.cid !== cid && q.name.toLocaleLowerCase('tr') === lower) return send(ws, { t: 'denied', text: 'Bu isim kullanımda' });
  let p = people.get(cid);
  if (p) {
    if (p.ws && p.ws !== ws) { send(p.ws, { t: 'kicked' }); p.ws.person = null; p.ws.close(); }
    p.ws = ws;
    if (!p.tableId) p.name = name;
  } else { p = { cid, name, ws, tableId: null }; people.set(cid, p); }
  ws.person = p;
  send(ws, { t: 'welcome', name: p.name });
  const t = tableOf(p);
  if (t) {
    const i = mySeat(t, p);
    if (i >= 0) t.seats[i].offlineSince = null;
    broadcastTable(t);
    if (t.phase === 'playing') botTurn(t);
  } else { p.tableId = null; sendLobby(p); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUB = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.person = null; ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello') return hello(ws, m);
    const p = ws.person;
    if (!p) return;
    const t = tableOf(p);
    let err = null;
    switch (m.t) {
      case 'create': createTable(p, m.kind); break;
      case 'join': {
        const tt = tables.get(m.id);
        if (!tt || tableOf(p) || tt.phase !== 'lobby') break;
        const i = openSeat(tt);
        if (i === undefined) break;
        sit(tt, p, i); maybeStart(tt); broadcastTable(tt); broadcastLobby();
        break;
      }
      case 'mode':
        if (t && t.phase === 'lobby' && t.creatorCid === p.cid && !t.mode && (m.mode === 'esli' || m.mode === 'essiz')) {
          t.mode = m.mode; maybeStart(t); broadcastTable(t); broadcastLobby();
        }
        break;
      case 'leave': leaveTable(p); break;
      case 'next': if (t && t.phase === 'roundover') { t.ready.add(p.cid); checkReady(t); if (t.phase === 'roundover') broadcastTable(t); } break;
      case 'draw': if (t) err = doDraw(t, mySeat(t, p), m.from === 'side' ? 'side' : 'deck'); break;
      case 'discard': if (t) err = doDiscard(t, mySeat(t, p), m.id); break;
      case 'finish': if (t) err = doFinish(t, mySeat(t, p), m.id); break;
      case 'finishSide': if (t) err = doFinishSide(t, mySeat(t, p)); break;
    }
    if (err) send(ws, { t: 'msg', text: err });
  });
  ws.on('close', () => {
    const p = ws.person;
    if (!p || p.ws !== ws) return;
    p.ws = null;
    const t = tableOf(p);
    if (!t) { people.delete(p.cid); return; }
    const i = mySeat(t, p);
    if (i >= 0) t.seats[i].offlineSince = Date.now();
    broadcastTable(t);
  });
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  for (const t of [...tables.values()]) {
    const anyOnline = humanSeats(t).some(i => seatOnline(t.seats[i]));
    if (anyOnline) t.emptySince = null;
    else {
      t.emptySince = t.emptySince || now;
      if (now - t.emptySince > (t.phase === 'lobby' ? 120000 : 900000)) { destroyTable(t); continue; }
    }
    if (t.phase === 'playing') botTurn(t); // çevrimdışı oyuncunun yerine geçici bot
  }
}, 5000);

server.listen(PORT, '0.0.0.0', () => console.log('Düz Okey çalışıyor: http://localhost:' + PORT));

/* Düz Okey çekirdek mantığı - hem Node (sunucu) hem tarayıcı kullanır */
(function (root) {
  'use strict';

  // Renkler: 0 sarı, 1 mavi, 2 siyah, 3 kırmızı. Taş: {id, c, n, fake}
  function makeDeck() {
    const d = [];
    for (let c = 0; c < 4; c++)
      for (let n = 1; n <= 13; n++)
        for (let k = 0; k < 2; k++) d.push({ id: c * 26 + (n - 1) * 2 + k, c, n, fake: false });
    d.push({ id: 104, c: -1, n: 0, fake: true });
    d.push({ id: 105, c: -1, n: 0, fake: true });
    return d;
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // Gösterge'nin bir fazlası okey'dir (13'ün fazlası 1)
  function okeyFromGosterge(g) { return { c: g.c, n: g.n === 13 ? 1 : g.n + 1 }; }
  function isJoker(t, ok) { return !t.fake && t.c === ok.c && t.n === ok.n; } // gerçek okey = joker
  function eff(t, ok) { return t.fake ? ok : t; } // sahte okey, okey taşının yerini tutar

  function combos(arr, m) {
    if (m === 0) return [[]];
    if (arr.length < m) return [];
    const out = [];
    (function go(start, cur) {
      if (cur.length === m) { out.push(cur.slice()); return; }
      for (let i = start; i < arr.length; i++) { cur.push(arr[i]); go(i + 1, cur); cur.pop(); }
    })(0, []);
    return out;
  }

  /* Eli en iyi şekilde per/ikili/tek olarak böler.
     leftover: kullanılmayan jokerin değeri. Tam per = taş başına 10, ikili = taş başına 4. */
  function decompose(tiles, ok, leftover) {
    const jokers = [], items = [];
    for (const t of tiles) {
      if (isJoker(t, ok)) jokers.push(t);
      else { const e = eff(t, ok); items.push({ t, c: e.c, n: e.n }); }
    }
    items.sort((a, b) => a.c - b.c || a.n - b.n || a.t.id - b.t.id);
    const memo = new Map();

    function rec(rem, jk) {
      if (!rem.length) return { v: jk * leftover, plan: null, left: jk };
      const key = rem.map(x => x.t.id).join(',') + '|' + jk;
      const hit = memo.get(key);
      if (hit) return hit;
      const t = rem[0];
      const rest0 = rem.slice(1);

      let r = rec(rest0, jk);
      let best = { v: r.v, plan: { type: 'single', slots: [t], next: r.plan }, left: r.left };

      // Seri (aynı renk ardışık). 1, 13'ten sonra gelebilir (12-13-1) ama 13-1-2 olmaz.
      const tps = t.n === 1 ? [1, 14] : [t.n];
      for (const tp of tps) {
        for (let s = Math.max(1, tp - 4); s <= tp; s++) {
          for (let e = Math.max(s + 2, tp); e <= Math.min(14, s + 12); e++) {
            const used = new Set([t]);
            const slots = [];
            let need = 0;
            for (let pos = s; pos <= e; pos++) {
              if (pos === tp) { slots.push(t); continue; }
              const num = pos > 13 ? 1 : pos;
              let f = null;
              for (const x of rem) if (!used.has(x) && x.c === t.c && x.n === num) { f = x; break; }
              if (f) { used.add(f); slots.push(f); } else { need++; slots.push(null); }
            }
            if (need > jk) continue;
            const rest = rem.filter(x => !used.has(x));
            const r2 = rec(rest, jk - need);
            const v = r2.v + 10 * (e - s + 1);
            if (v > best.v) best = { v, plan: { type: 'run', slots, next: r2.plan }, left: r2.left };
          }
        }
      }

      // Grup (aynı sayı, farklı renkler; 3 veya 4 taş)
      const present = [];
      for (let c = 0; c < 4; c++) {
        if (c === t.c) continue;
        const f = rem.find(x => x !== t && x.c === c && x.n === t.n);
        if (f) present.push(f);
      }
      for (let k = 3; k <= 4; k++) {
        const need = k - 1;
        for (let m = Math.max(0, need - jk); m <= Math.min(present.length, need); m++) {
          const jn = need - m;
          for (const cb of combos(present, m)) {
            const used = new Set([t, ...cb]);
            const rest = rem.filter(x => !used.has(x));
            const r2 = rec(rest, jk - jn);
            const v = r2.v + 10 * k;
            if (v > best.v) {
              const slots = [t, ...cb];
              for (let i = 0; i < jn; i++) slots.push(null);
              best = { v, plan: { type: 'group', slots, next: r2.plan }, left: r2.left };
            }
          }
        }
      }

      // Yarım per (ikili) - bot için değerlendirme ve diz düzeni için
      const seen = new Set();
      for (const u of rest0) {
        let good = false;
        if (u.c === t.c && (u.n - t.n === 1 || u.n - t.n === 2)) good = true;
        else if (u.n === t.n && u.c !== t.c) good = true;
        if (!good) continue;
        const k = u.c * 20 + u.n;
        if (seen.has(k)) continue;
        seen.add(k);
        const rest = rem.filter(x => x !== t && x !== u);
        const r2 = rec(rest, jk);
        const v = r2.v + 8;
        if (v > best.v) best = { v, plan: { type: 'partial', slots: [t, u], next: r2.plan }, left: r2.left };
      }

      memo.set(key, best);
      return best;
    }

    const res = rec(items, jokers.length);
    const melds = [], partials = [], singles = [];
    const jq = jokers.slice();
    for (let p = res.plan; p; p = p.next) {
      const slots = p.slots.map(x => (x === null ? jq.pop() : x.t));
      if (p.type === 'run' || p.type === 'group') melds.push({ type: p.type, tiles: slots });
      else if (p.type === 'partial') partials.push(slots);
      else singles.push(slots[0]);
    }
    return { value: res.v, melds, partials, singles, leftJokers: jq, jkLeft: res.left };
  }

  // 14 taşlık el seri (per) olarak bitiyor mu?
  function seriWin(tiles, ok) {
    const d = decompose(tiles, ok, 0);
    if (d.value !== (tiles.length - d.jkLeft) * 10) return false;
    if (d.jkLeft === 0) return true;
    return d.melds.some(m => m.type === 'run' || m.tiles.length === 3); // artan joker bir pere eklenebilir
  }
  // 7 çift ile bitiyor mu?
  function ciftWin(tiles, ok) {
    if (tiles.length !== 14) return false;
    let jk = 0;
    const cnt = {};
    for (const t of tiles) {
      if (isJoker(t, ok)) { jk++; continue; }
      const e = eff(t, ok);
      const k = e.c * 20 + e.n;
      cnt[k] = (cnt[k] || 0) + 1;
    }
    let odd = 0;
    for (const k in cnt) if (cnt[k] % 2) odd++;
    return odd <= jk;
  }
  // 15 taşlık elde hangi taşı atarak bitilir?
  function finishOptions(hand15, ok) {
    const res = [];
    for (const d of hand15) {
      const rest = hand15.filter(x => x !== d);
      if (seriWin(rest, ok)) res.push({ tile: d, type: 'seri' });
      else if (ciftWin(rest, ok)) res.push({ tile: d, type: 'cift' });
    }
    return res;
  }
  function canFinishWith(hand15, tile, ok) {
    const rest = hand15.filter(x => x.id !== tile.id);
    if (rest.length !== 14) return null;
    if (seriWin(rest, ok)) return 'seri';
    if (ciftWin(rest, ok)) return 'cift';
    return null;
  }

  /* ---------- Bot zekası ---------- */
  function evalHand(tiles, ok) { return decompose(tiles, ok, 6).value; }

  function neighbours(t, rest, ok) {
    const e = eff(t, ok);
    let n = 0;
    for (const x of rest) {
      const f = eff(x, ok);
      if (f.c === e.c && Math.abs(f.n - e.n) <= 2 && f.n !== e.n) n++;
      else if (f.n === e.n && f.c !== e.c) n++;
    }
    return n;
  }
  function related(t, wanted, ok) {
    const e = eff(t, ok);
    let n = 0;
    for (const w of wanted) {
      const f = eff(w, ok);
      if (f.c === e.c && Math.abs(f.n - e.n) <= 2) n++;
      else if (f.n === e.n) n++;
    }
    return n;
  }
  // avoid: rakibin yandan aldığı taşlar (ona yaramasın diye benzerini atma)
  function bestDiscard(hand15, ok, avoid) {
    let best = null;
    for (const d of hand15) {
      const rest = hand15.filter(x => x !== d);
      let v = decompose(rest, ok, 6).value;
      v -= 0.01 * neighbours(d, rest, ok);
      if (avoid && avoid.length) v -= 0.3 * Math.min(2, related(d, avoid, ok));
      if (isJoker(d, ok)) v -= 50;
      if (!best || v > best.v) best = { tile: d, v };
    }
    return best.tile;
  }
  // Yandaki taşı almalı mı?
  function shouldTakeSide(hand14, sideTile, ok) {
    if (isJoker(sideTile, ok)) return true;
    const h15 = hand14.concat([sideTile]);
    if (finishOptions(h15, ok).length) return true;
    const cur = evalHand(hand14, ok);
    let bestNew = -1e9;
    for (const d of h15) {
      if (d === sideTile) continue; // aldığı taşı hemen geri atmasın
      const v = evalHand(h15.filter(x => x !== d), ok);
      if (v > bestNew) bestNew = v;
    }
    return bestNew > cur + 1;
  }

  /* ---------- Istaka dizme ---------- */
  function sortTiles(arr) { return arr.slice().sort((a, b) => a.c - b.c || a.n - b.n || a.id - b.id); }

  function arrangeSeri(hand, ok) {
    const d = decompose(hand, ok, 0);
    const runs = d.melds.filter(m => m.type === 'run').map(m => m.tiles);
    const groups = d.melds.filter(m => m.type === 'group').map(m => m.tiles);
    const key = g => { const f = g.find(t => !isJoker(t, ok)) || g[0]; const e = eff(f, ok); return e.c * 20 + e.n; };
    runs.sort((a, b) => key(a) - key(b));
    groups.sort((a, b) => key(a) - key(b));
    const partials = d.partials.slice().sort((a, b) => key(a) - key(b));
    const rest = sortTiles(d.singles).concat(d.leftJokers);
    return { groups: runs.concat(groups, partials), rest };
  }

  function arrangeCift(hand, ok) {
    const jokers = hand.filter(t => isJoker(t, ok));
    const by = {};
    for (const t of hand) {
      if (isJoker(t, ok)) continue;
      const e = eff(t, ok);
      (by[e.c * 20 + e.n] = by[e.c * 20 + e.n] || []).push(t);
    }
    const pairs = [], singles = [];
    Object.keys(by).map(Number).sort((a, b) => a - b).forEach(k => {
      const l = by[k];
      while (l.length >= 2) pairs.push([l.shift(), l.shift()]);
      if (l.length) singles.push(l[0]);
    });
    const rest = [];
    for (const s of singles) {
      if (jokers.length) pairs.push([s, jokers.pop()]);
      else rest.push(s);
    }
    while (jokers.length >= 2) pairs.push([jokers.pop(), jokers.pop()]);
    while (jokers.length) rest.push(jokers.pop());
    return { groups: pairs, rest };
  }

  const api = {
    makeDeck, shuffle, okeyFromGosterge, isJoker, eff, decompose, seriWin, ciftWin,
    finishOptions, canFinishWith, evalHand, bestDiscard, shouldTakeSide, arrangeSeri, arrangeCift, sortTiles
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OkeyCore = api;
})(typeof self !== 'undefined' ? self : this);

/* ============================================================
   Mahjong Arena — computer opponent (電腦補位)
   Heuristic play: always win when possible, discard the least
   "connected" tile, claim melds when they clearly help.
   difficulty: 'easy' | 'normal' | 'hard' tunes aggression/greed.
   ============================================================ */
(function (root) {
  'use strict';
  const MJ = (typeof require !== 'undefined') ? require('./engine.js') : root.MJ;

  const LEVELS = {
    easy: { claim: 0.25, chow: 0.15, keepSmart: 0.6 },
    normal: { claim: 0.45, chow: 0.30, keepSmart: 0.85 },
    hard: { claim: 0.6, chow: 0.4, keepSmart: 1.0 },
  };

  // how "useful" is each tile to the hand it sits in (higher = keep)
  function tileValue(hand, t) {
    const c = hand.filter((x) => x === t).length;
    let v = 0;
    if (c >= 3) v += 100;         // triplet — never toss
    else if (c === 2) v += 40;    // pair
    if (MJ.isSuited(t)) {
      const s = MJ.suitOf(t), n = MJ.numOf(t);
      const has = (k) => hand.includes(s + k) ? 1 : 0;
      v += (has(n - 1) + has(n + 1)) * 12; // adjacent → run potential
      v += (has(n - 2) + has(n + 2)) * 5;  // gap → kanchan
      v += (n >= 3 && n <= 7) ? 3 : 0;      // middle tiles more flexible
    } else {
      v += 2; // lone honor: low base
    }
    return v;
  }

  // 危險度:對手可能胡這張的風險(越高越不該打)
  function danger(game, seat, t) {
    // 現物:已被任一家打過的牌,相對安全
    const inRiver = game.players.some((p, i) => i !== seat && p.discards.includes(t));
    if (inRiver) return 4;
    if (MJ.isHonor(t)) {
      // 場上已見越多張的字牌越安全
      let seen = 0; game.players.forEach((p) => { seen += p.discards.filter((x) => x === t).length; p.melds.forEach((m) => { seen += m.tiles.filter((x) => x === t).length; }); });
      return seen >= 2 ? 6 : 22;
    }
    const n = MJ.numOf(t);
    return (n === 1 || n === 9) ? 24 : (n === 2 || n === 8) ? 40 : 58; // 中張最危險
  }
  // 威脅度:對手副露數 + 牌牆將盡 → 該防守
  function threat(game, seat) {
    let t = 0;
    for (let p = 0; p < 4; p++) { if (p === seat) continue; t += game.players[p].melds.filter((m) => !m.concealed).length; }
    if (game.wallCount() < 24) t += 2;
    return t;
  }
  function chooseDiscard(game, seat, level) {
    const L = LEVELS[level] || LEVELS.normal;
    const hand = game.players[seat].hand;
    const th = threat(game, seat);
    // 防守權重:賭神(hard)較早開始防、權重高;老手(normal)威脅大才防;菜鳥(easy)不太防
    let dw = 0;
    if (level === 'hard') dw = th >= 2 ? 1.3 : 0.2;
    else if (level === 'normal') dw = th >= 3 ? 0.7 : 0;
    const uniq = [...new Set(hand)];
    let worst = null, worstV = Infinity;
    for (const t of uniq) {
      // 丟分數 = 留牌價值 + 危險度×防守權重(越低越該丟:沒用又安全)
      let v = tileValue(hand, t) + dw * danger(game, seat, t);
      if (Math.random() > L.keepSmart) v += (Math.random() - 0.5) * 30; // 菜鳥手感雜訊
      if (v < worstV) { worstV = v; worst = t; }
    }
    return worst;
  }

  // decide the action in phase 'act'
  function act(game, seat) {
    const acts = game.actActions(seat);
    const pl = game.players[seat];
    const tsumo = acts.find((a) => a.type === 'tsumo');
    if (tsumo) return tsumo;
    // kong a dragon/seat-wind readily; otherwise only if it doesn't wreck a wait
    const kong = acts.find((a) => a.type === 'ankong' || a.type === 'addkong');
    const myWind = MJ.SEAT_WIND[((seat - game.dealerIndex) + 4) % 4];
    if (kong) {
      const t = kong.tile;
      const valuable = MJ.DRAGON_NAMES[t] || t === myWind;
      if (valuable || !MJ.isTenpai(pl.hand.filter((x) => x !== t), pl.melds)) {
        // only kong if we're not already tenpai on that tile group
        if (valuable || Math.random() < 0.4) return kong;
      }
    }
    return { type: 'discard', tile: chooseDiscard(game, seat, game._aiLevel || 'normal') };
  }

  // decide the claim for `seat` given the open claim options
  function claim(game, seat) {
    const opts = game.claimActions(seat);
    if (!opts.length) return { type: 'pass' };
    const L = LEVELS[game._aiLevel || 'normal'] || LEVELS.normal;
    const pl = game.players[seat];
    const tile = game.pendingClaims.tile;
    const myWind = MJ.SEAT_WIND[((seat - game.dealerIndex) + 4) % 4];

    const hu = opts.find((o) => o.type === 'hu');
    if (hu) return hu;

    const kong = opts.find((o) => o.type === 'kong');
    if (kong) {
      const valuable = MJ.DRAGON_NAMES[tile] || tile === myWind;
      if (valuable || Math.random() < L.claim) return kong;
    }
    const pung = opts.find((o) => o.type === 'pung');
    if (pung) {
      const valuable = MJ.DRAGON_NAMES[tile] || tile === myWind ||
        tile === game.roundWind;
      const leaning = pl.melds.length >= 1; // already opened → keep opening
      if (valuable || leaning || Math.random() < L.claim) return pung;
    }
    const chow = opts.find((o) => o.type === 'chow');
    if (chow && Math.random() < L.chow) return chow;

    return { type: 'pass' };
  }

  const AI = { chooseDiscard, tileValue, act, claim, LEVELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
  root.MJAI = AI;
})(typeof window !== 'undefined' ? window : globalThis);

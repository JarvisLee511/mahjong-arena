/* ============================================================
   Mahjong Arena — Taiwanese 16-tile engine (pure logic)
   Works in browser (window.MJ) and Node (module.exports).

   Tile encoding (string):
     m1..m9  萬 (characters)
     p1..p9  筒 (dots)
     s1..s9  條 (bamboo)
     z1..z7  字: 東南西北 中發白  (z1 東 z2 南 z3 西 z4 北 z5 中 z6 發 z7 白)
     f1..f8  花: 春夏秋冬(1-4) 梅蘭竹菊(5-8)

   Hand size: 16 concealed; dealer draws to 17 to start.
   A win = 5 melds (sets of 3) + 1 pair = 17 tiles.
   ============================================================ */

(function (root) {
  'use strict';

  // ---- tile universe ---------------------------------------
  const SUITS = ['m', 'p', 's'];
  const HONORS = ['z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7'];
  const FLOWERS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];

  const WIND_NAMES = { z1: '東', z2: '南', z3: '西', z4: '北' };
  const DRAGON_NAMES = { z5: '中', z6: '發', z7: '白' };

  // seat index 0/1/2/3 → seat wind tile
  const SEAT_WIND = ['z1', 'z2', 'z3', 'z4']; // 東南西北

  function tileName(t) {
    if (!t) return '';
    const s = t[0], n = t[1];
    if (s === 'm') return n + '萬';
    if (s === 'p') return n + '筒';
    if (s === 's') return n + '條';
    if (s === 'z') return { 1: '東', 2: '南', 3: '西', 4: '北', 5: '中', 6: '發', 7: '白' }[n];
    if (s === 'f') return { 1: '春', 2: '夏', 3: '秋', 4: '冬', 5: '梅', 6: '蘭', 7: '竹', 8: '菊' }[n];
    return t;
  }

  const isSuited = (t) => t && SUITS.includes(t[0]);
  const isHonor = (t) => t && t[0] === 'z';
  const isFlower = (t) => t && t[0] === 'f';
  const suitOf = (t) => t[0];
  const numOf = (t) => +t[1];

  // build the full 144-tile wall
  function buildWall() {
    const w = [];
    for (const s of SUITS) for (let n = 1; n <= 9; n++) for (let k = 0; k < 4; k++) w.push(s + n);
    for (const z of HONORS) for (let k = 0; k < 4; k++) w.push(z);
    for (const f of FLOWERS) w.push(f); // one each
    return w;
  }

  // Fisher–Yates using an injectable RNG (for reproducible stress tests)
  function shuffle(arr, rng) {
    rng = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // seeded RNG (mulberry32) so stress tests are reproducible
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- counts helpers --------------------------------------
  // index: m1..m9=0..8, p=9..17, s=18..26, z1..z7=27..33
  function tileIndex(t) {
    const s = t[0], n = +t[1];
    if (s === 'm') return n - 1;
    if (s === 'p') return 9 + n - 1;
    if (s === 's') return 18 + n - 1;
    if (s === 'z') return 27 + n - 1;
    return -1; // flowers excluded from melds
  }
  function indexToTile(i) {
    if (i < 9) return 'm' + (i + 1);
    if (i < 18) return 'p' + (i - 9 + 1);
    if (i < 27) return 's' + (i - 18 + 1);
    return 'z' + (i - 27 + 1);
  }
  function toCounts(tiles) {
    const c = new Array(34).fill(0);
    for (const t of tiles) { const i = tileIndex(t); if (i >= 0) c[i]++; }
    return c;
  }

  // ---- win decomposition -----------------------------------
  // Enumerate every way `counts` (concealed tiles) splits into
  // `needMelds` melds (pung/chow) + exactly one pair.
  // Returns array of decompositions; each = { melds:[{type,tiles}], pair:tile }.
  function enumerate(counts, needMelds) {
    const results = [];

    function firstNonZero(c) {
      for (let i = 0; i < 34; i++) if (c[i] > 0) return i;
      return -1;
    }

    // decompose remaining into exactly `melds` melds, no pair left
    function melds(c, need, acc) {
      if (need === 0) {
        for (let i = 0; i < 34; i++) if (c[i] !== 0) return;
        results.push(acc.slice());
        return;
      }
      const i = firstNonZero(c);
      if (i < 0) return;
      // triplet
      if (c[i] >= 3) {
        c[i] -= 3;
        acc.push({ type: 'pung', tiles: [indexToTile(i), indexToTile(i), indexToTile(i)] });
        melds(c, need - 1, acc);
        acc.pop();
        c[i] += 3;
      }
      // sequence (only suited, i not honor, and not crossing suit/9-boundary)
      if (i < 27) {
        const n = i % 9;
        if (n <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
          c[i]--; c[i + 1]--; c[i + 2]--;
          acc.push({ type: 'chow', tiles: [indexToTile(i), indexToTile(i + 1), indexToTile(i + 2)] });
          melds(c, need - 1, acc);
          acc.pop();
          c[i]++; c[i + 1]++; c[i + 2]++;
        }
      }
    }

    // try each tile as the pair
    for (let p = 0; p < 34; p++) {
      if (counts[p] >= 2) {
        counts[p] -= 2;
        const before = results.length;
        melds(counts, needMelds, []);
        // tag pair onto each new decomposition
        for (let k = before; k < results.length; k++) {
          results[k] = { melds: results[k], pair: indexToTile(p) };
        }
        counts[p] += 2;
      }
    }
    return results;
  }

  // Can the concealed tiles + given number of exposed melds form a win?
  // concealed: array of tile strings (no flowers). exposedMeldCount: 0..4
  function decompositions(concealed, exposedMeldCount) {
    const need = 5 - exposedMeldCount;
    if (concealed.length !== need * 3 + 2) return [];
    return enumerate(toCounts(concealed), need);
  }
  function canWin(concealed, exposedMeldCount) {
    return decompositions(concealed, exposedMeldCount).length > 0;
  }

  // Given a hand (concealed tiles) + exposed melds, list which tiles,
  // if drawn/claimed, complete a win. (聽牌 / waits)
  function winningTiles(concealed, exposedMelds) {
    const exposedCount = exposedMelds.length;
    const waits = [];
    for (let i = 0; i < 34; i++) {
      const t = indexToTile(i);
      // can't wait on a tile already 4-used across concealed+exposed
      const used = concealed.filter((x) => x === t).length +
        exposedMelds.reduce((a, m) => a + m.tiles.filter((x) => x === t).length, 0);
      if (used >= 4) continue;
      if (canWin(concealed.concat([t]), exposedCount)) waits.push(t);
    }
    return waits;
  }
  const isTenpai = (concealed, exposedMelds) => winningTiles(concealed, exposedMelds).length > 0;

  // =====================================================================
  //  SCORING — Taiwanese 台 (fan). Returns { tai, breakdown:[{name,tai}] }
  //  ctx: {
  //    seatIndex, dealerIndex, roundWind ('z1'..'z4'),
  //    selfDraw(bool), byRobKong(bool), byKongDraw(bool),
  //    byLastTile(bool 海底/河底), flowers:[tiles], exposedMelds:[{type,tiles,concealed}],
  //    winTile, isFirstDraw(bool 天/地/人胡), streak(連莊數)
  //  }
  // =====================================================================
  // 判定胡的那張牌在此拆解中的聽牌型:pair(單吊)/kanchan(嵌張)/edge(邊張)/open(兩面)/pung(雙碰)
  function classifyWait(dec, winTile) {
    if (!winTile) return 'other';
    if (winTile === dec.pair) return 'pair';
    for (const m of dec.melds) {
      const idx = m.tiles.indexOf(winTile);
      if (idx < 0) continue;
      if (m.type === 'pung') return 'pung';
      if (m.type === 'chow') {
        if (idx === 1) return 'kanchan';
        const a = numOf(m.tiles[0]);
        if (idx === 2 && a === 1) return 'edge';   // 1-2 聽 3
        if (idx === 0 && a === 7) return 'edge';   // 8-9 聽 7
        return 'open';                              // 兩面
      }
    }
    return 'other';
  }

  function scoreWin(concealed, ctx) {
    ctx = ctx || {};
    const exposed = ctx.exposedMelds || [];
    const decs = decompositions(concealed, exposed.length);
    if (!decs.length) return null;

    let best = null;
    for (const dec of decs) {
      const s = scoreDecomposition(dec, exposed, concealed, ctx);
      if (!best || s.tai > best.tai) best = s;
    }
    return best;
  }

  function add(bd, name, tai) { if (tai) bd.push({ name, tai }); }

  function scoreDecomposition(dec, exposed, concealed, ctx) {
    const bd = [];
    // full meld list (exposed + concealed decomposition), pair separate
    const allMelds = exposed.map((m) => ({
      type: m.type, tiles: m.tiles.slice(), concealed: !!m.concealed,
    })).concat(dec.melds.map((m) => ({ type: m.type, tiles: m.tiles, concealed: true })));
    const pair = dec.pair;

    const menClean = exposed.every((m) => m.concealed); // no claimed (吃碰明槓) melds
    const selfDraw = !!ctx.selfDraw;

    // 自摸
    if (selfDraw) add(bd, '自摸', 1);
    // 門前清 (all concealed) — 放槍胡才算純門清；門清自摸另計不求人
    if (menClean && !selfDraw) add(bd, '門前清', 1);
    if (menClean && selfDraw) add(bd, '不求人', 1); // 門清自摸 → 自摸1 + 不求人1

    // 花牌:每花 1 台;正花(對應座位)不額外,但花槓 +2
    const flowers = ctx.flowers || [];
    if (flowers.length) add(bd, `花牌x${flowers.length}`, flowers.length);
    const seasons = flowers.filter((f) => +f[1] <= 4).length;
    const gents = flowers.filter((f) => +f[1] >= 5).length;
    if (seasons === 4) add(bd, '四季(花槓)', 2);
    if (gents === 4) add(bd, '四君子(花槓)', 2);
    if (flowers.length === 0) add(bd, '無花', 1);

    // meld-composition based
    const pungs = allMelds.filter((m) => m.type === 'pung' || m.type === 'kong');
    const chows = allMelds.filter((m) => m.type === 'chow');
    const allPung = pungs.length === 5;
    const allChow = chows.length === 5;

    // 碰碰胡
    if (allPung) add(bd, '碰碰胡', 4);

    // 聽牌型(依胡的那張在此拆解中的位置):單吊/嵌張/邊張/兩面/雙碰
    const wait = classifyWait(dec, ctx.winTile);
    if (wait === 'pair') add(bd, '單吊', 1);
    else if (wait === 'kanchan') add(bd, '嵌張', 1);
    else if (wait === 'edge') add(bd, '邊張', 1);

    // 平胡(嚴格):放槍胡 + 全順 + 對子非字 + 兩面聽
    if (!selfDraw && allChow && !isHonor(pair) && wait === 'open') add(bd, '平胡', 2);

    // 暗刻數 (concealed pung/kong, 自摸的門清刻或原本暗刻)
    const concealedPungs = pungs.filter((m) => m.concealed).length;
    if (concealedPungs === 3) add(bd, '三暗刻', 2);
    else if (concealedPungs === 4) add(bd, '四暗刻', 5);
    else if (concealedPungs === 5) add(bd, '五暗刻', 8);

    // 花色 (清/混一色) — consider suited tiles only
    const suitsUsed = new Set();
    let hasHonor = false;
    const scanTiles = allMelds.flatMap((m) => m.tiles).concat([pair, pair]);
    for (const t of scanTiles) {
      if (isHonor(t)) hasHonor = true;
      else if (isSuited(t)) suitsUsed.add(suitOf(t));
    }
    if (suitsUsed.size === 1 && !hasHonor) add(bd, '清一色', 8);
    else if (suitsUsed.size === 1 && hasHonor) add(bd, '混一色', 4);
    else if (suitsUsed.size === 0 && hasHonor) add(bd, '字一色', 16);
    else if (suitsUsed.size === 2) add(bd, '缺一門', 1);   // 少一種花色

    // 三元牌 (中發白):大/小三元「取代」個別三元刻,不重複計
    const dragonPungs = pungs.filter((m) => DRAGON_NAMES[m.tiles[0]]);
    const dragonPair = DRAGON_NAMES[pair] ? 1 : 0;
    if (dragonPungs.length === 3) add(bd, '大三元', 8);
    else if (dragonPungs.length === 2 && dragonPair) add(bd, '小三元', 4);
    else for (const d of dragonPungs) add(bd, DRAGON_NAMES[d.tiles[0]] + '(三元刻)', 1);

    // 風牌:大/小四喜「取代」個別自風/場風刻,不重複計。自風相對莊家(莊=東)
    const seatWind = SEAT_WIND[(((ctx.seatIndex || 0) - (ctx.dealerIndex || 0)) + 4) % 4];
    const roundWind = ctx.roundWind || 'z1';
    const windPungs = pungs.filter((m) => WIND_NAMES[m.tiles[0]]);
    const windPairIsWind = WIND_NAMES[pair] ? 1 : 0;
    if (windPungs.length === 4) add(bd, '大四喜', 16);
    else if (windPungs.length === 3 && windPairIsWind) add(bd, '小四喜', 8);
    else for (const w of windPungs) {
      if (w.tiles[0] === seatWind) add(bd, '自風' + WIND_NAMES[w.tiles[0]], 1);
      if (w.tiles[0] === roundWind) add(bd, '場風' + WIND_NAMES[w.tiles[0]], 1);
    }

    // 莊家 / 連莊拉莊
    if ((ctx.seatIndex || 0) === (ctx.dealerIndex)) add(bd, '莊家', 1);
    if (ctx.streak && ctx.streak > 0) add(bd, `連${ctx.streak}拉${ctx.streak}`, ctx.streak * 2);

    // 特殊得牌方式
    if (ctx.byRobKong) add(bd, '搶槓', 1);
    if (ctx.byKongDraw) add(bd, '槓上開花', 1);
    if (ctx.byLastTile && selfDraw) add(bd, '海底撈月', 1);
    if (ctx.byLastTile && !selfDraw) add(bd, '河底撈魚', 1);

    // 天/地/人胡(起手即胡)
    if (ctx.isFirstDraw) {
      if ((ctx.seatIndex || 0) === ctx.dealerIndex && selfDraw) add(bd, '天胡', 24);
      else if (selfDraw) add(bd, '地胡', 16);
      else add(bd, '人胡', 8);
    }
    // 天聽/地聽(第一巡打完即宣告聽牌,之後胡)
    if (ctx.ready === 'tian') add(bd, '天聽', 8);
    else if (ctx.ready === 'di') add(bd, '地聽', 4);

    const tai = bd.reduce((a, x) => a + x.tai, 0);
    return { tai, breakdown: bd, decomposition: dec };
  }

  // ---- exports ---------------------------------------------
  const MJ = {
    SUITS, HONORS, FLOWERS, SEAT_WIND, WIND_NAMES, DRAGON_NAMES,
    tileName, isSuited, isHonor, isFlower, suitOf, numOf,
    buildWall, shuffle, makeRng,
    tileIndex, indexToTile, toCounts,
    enumerate, decompositions, canWin, winningTiles, isTenpai,
    scoreWin,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MJ;
  root.MJ = MJ;
})(typeof window !== 'undefined' ? window : globalThis);

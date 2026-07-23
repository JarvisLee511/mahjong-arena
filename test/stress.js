/* ============================================================
   Stress + correctness harness for the Mahjong engine.
   Run:  node test/stress.js [games] [seed]
   ============================================================ */
const MJ = require('../js/engine.js');
const { Game } = require('../js/game.js');

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.error('  ✗ ' + msg); } }
function ok(msg) { console.log('  ✓ ' + msg); }

// ---------------------------------------------------------------
// 1. Win-detection unit tests (positive + negative)
// ---------------------------------------------------------------
console.log('\n[1] 胡牌判定單元測試');
function hand(str) { return str.trim().split(/\s+/); }

// a clean 16-tile win: 5 chows + pair (all concealed, 0 exposed melds)
assert(MJ.canWin(hand('m1 m2 m3 m4 m5 m6 m7 m8 m9 p1 p2 p3 s1 s2 s3 z1 z1'), 0),
  '5順+對(全門清) 應可胡');

// 碰碰胡: 5 pungs + pair
assert(MJ.canWin(hand('m1 m1 m1 p2 p2 p2 s3 s3 s3 z1 z1 z1 z5 z5 z5 m9 m9'), 0),
  '5刻+對(碰碰) 應可胡');

// with exposed melds (2 melds exposed → 3 concealed melds + pair = 11 tiles)
assert(MJ.canWin(hand('m1 m2 m3 p4 p5 p6 s7 s8 s9 z2 z2'), 2),
  '2副露+3順+對 應可胡');

// negatives
assert(!MJ.canWin(hand('m1 m2 m3 m4 m5 m6 m7 m8 m9 p1 p2 p3 s1 s2 s4 z1 z1'), 0),
  's1s2s4 缺張 不應胡');
assert(!MJ.canWin(hand('m1 m1 m2 m2 m3 m3 m4 m4 m5 m5 m6 m6 m7 m7 z1 z1 z2'), 0),
  '亂七對牌型 不應胡(台麻無七對)');
assert(!MJ.canWin(hand('m1 m2 m3 m4 m5 m6 m7 m8 m9 p1 p2 p3 s1 s2 s3 z1'), 0),
  '只有16張(缺對) 不應胡');

// 聽牌 / waits
const waits = MJ.winningTiles(hand('m1 m2 m3 m4 m5 m6 m7 m8 m9 p1 p2 p3 s1 s2 s3 z1'), []);
assert(waits.length === 1 && waits[0] === 'z1', `單吊z1 聽牌正確 (得 ${waits.map(MJ.tileName).join(',')})`);

const waits2 = MJ.winningTiles(hand('m1 m2 m3 m4 m5 m6 m7 m8 m9 p1 p2 p3 s2 s3 z1 z1'), []);
assert(waits2.length === 2 && waits2.includes('s1') && waits2.includes('s4'),
  `兩面聽 s1/s4  → ${waits2.map(MJ.tileName).join(',')}`);

if (failures === 0) ok('所有胡牌判定單元測試通過');

// ---------------------------------------------------------------
// 2. Scoring smoke tests
// ---------------------------------------------------------------
console.log('\n[2] 台數計算煙霧測試');
const s1 = MJ.scoreWin(hand('m1 m1 m1 m2 m3 m4 m5 m6 m7 m8 m9 m9 m9 m5 m5 m4 m4'), // build a 清一色-ish
  { seatIndex: 1, dealerIndex: 0, roundWind: 'z1', selfDraw: false, flowers: [], exposedMelds: [] });
if (s1) ok(`範例台數: ${s1.tai}台 (${s1.breakdown.map(b => b.name + b.tai).join(' ')})`);

const s2 = MJ.scoreWin(hand('m1 m1 m1 p2 p2 p2 s3 s3 s3 z5 z5 z5 z6 z6 z6 m9 m9'),
  { seatIndex: 0, dealerIndex: 0, roundWind: 'z1', selfDraw: true, flowers: ['f1'], exposedMelds: [] });
if (s2) ok(`碰碰+雙元自摸莊: ${s2.tai}台 (${s2.breakdown.map(b => b.name + b.tai).join(' ')})`);

// ---------------------------------------------------------------
// 3. Full-game stress with a greedy AI + invariant checks
// ---------------------------------------------------------------
const N = parseInt(process.argv[2] || '20000', 10);
const SEED = parseInt(process.argv[3] || '12345', 10);
console.log(`\n[3] 全局壓力測試: ${N} 局 (seed ${SEED})`);

function checkInvariants(g) {
  let total = 0;
  for (const p of g.players) {
    total += p.hand.length + p.flowers.length + p.discards.length;
    for (const m of p.melds) total += m.tiles.length;
  }
  total += g.wallCount();
  if (g.result && g.result.type === 'win' && !g.result.selfDraw) {
    // ron winning tile still sits in the discarder's river → already counted
  }
  assert(total === 144, `牌數守恆失敗: ${total} != 144 (phase ${g.phase})`);

  if (g.phase === 'act') {
    for (const p of g.players) {
      const exp = (5 - p.melds.length) * 3 + (p.seat === g.turn ? 2 : 1);
      assert(p.hand.length === exp,
        `手牌數異常 seat${p.seat}: ${p.hand.length} != ${exp} (melds ${p.melds.length})`);
    }
  }
  // no tile used more than 4 times overall
  const cnt = {};
  for (const p of g.players) {
    for (const t of p.hand) cnt[t] = (cnt[t] || 0) + 1;
    for (const m of p.melds) for (const t of m.tiles) cnt[t] = (cnt[t] || 0) + 1;
    for (const t of p.discards) cnt[t] = (cnt[t] || 0) + 1;
  }
  for (let i = g.front; i <= g.back; i++) { const t = g.wall[i]; cnt[t] = (cnt[t] || 0) + 1; }
  for (const t in cnt) {
    const cap = t[0] === 'f' ? 1 : 4;
    assert(cnt[t] <= cap, `牌 ${t} 出現 ${cnt[t]} 次 > ${cap}`);
  }
}

// greedy-ish policy: win when possible, sometimes claim, discard least-connected
function pickDiscard(pl) {
  const c = {};
  for (const t of pl.hand) c[t] = (c[t] || 0) + 1;
  // score each tile: honors/isolated worst → discard first
  let worst = null, worstScore = Infinity;
  for (const t of pl.hand) {
    let sc = c[t] * 2;
    if (MJ.isSuited(t)) {
      const s = MJ.suitOf(t), n = MJ.numOf(t);
      if (pl.hand.includes(s + (n - 1)) || pl.hand.includes(s + (n + 1))) sc += 2;
      if (pl.hand.includes(s + (n - 2)) || pl.hand.includes(s + (n + 2))) sc += 1;
    }
    if (sc < worstScore) { worstScore = sc; worst = t; }
  }
  return worst;
}

const rng = MJ.makeRng(SEED);
let wins = 0, draws = 0, multiHu = 0, maxTai = 0, taiSum = 0, taiCount = 0, steps = 0;
const winTypes = {};

let swapGames = 0;
for (let gi = 0; gi < N; gi++) {
  const swapMode = (gi % 3 === 0);   // 每 3 局有 1 局跑換三張,涵蓋 swap 流程
  if (swapMode) swapGames++;
  const g = new Game({ rng, dealerIndex: gi & 3, roundWind: 'z1', swapMode });
  let guard = 0;
  try {
    while (g.phase !== 'over') {
      if (++guard > 2000) throw new Error('局面未收斂(可能死迴圈)');
      steps++;
      checkInvariants(g);

      if (g.phase === 'swap') {
        for (const p of [0, 1, 2, 3]) {
          if (!g.swapReady(p)) g.selectSwap(p, g.players[p].hand.slice(0, 3));
        }
        continue;
      }
      if (g.phase === 'act') {
        const pl = g.players[g.turn];
        const acts = g.actActions(g.turn);
        const tsumo = acts.find((a) => a.type === 'tsumo');
        if (tsumo) { g.applyAct(g.turn, tsumo); continue; }
        // occasionally kong to exercise those paths
        const kong = acts.find((a) => a.type === 'ankong' || a.type === 'addkong');
        if (kong && rng() < 0.5) { g.applyAct(g.turn, kong); continue; }
        g.applyAct(g.turn, { type: 'discard', tile: pickDiscard(pl) });
        continue;
      }

      if (g.phase === 'claim') {
        const pc = g.pendingClaims;
        for (const key of Object.keys(pc.options)) {
          const p = +key;
          const opts = pc.options[p];
          const hu = opts.find((o) => o.type === 'hu');
          if (hu) { g.declareClaim(p, hu); continue; }
          // sometimes claim pung/kong/chow to keep melds flowing
          const claimable = opts.find((o) => o.type === 'kong' || o.type === 'pung' || o.type === 'chow');
          if (claimable && rng() < 0.35) g.declareClaim(p, claimable);
          else g.declareClaim(p, { type: 'pass' });
        }
      }
    }

    checkInvariants(g);
    // validate result
    if (g.result.type === 'draw') draws++;
    else {
      wins++;
      if (g.result.winners.length > 1) multiHu++;
      for (const w of g.result.winners) {
        // re-verify the winning hand actually forms a legal win(花牌大胡例外:靠花不靠牌型)
        if (!g.result.flowerWin) {
          const pl = g.players[w.player];
          const concealed = g.result.selfDraw ? pl.hand : pl.hand.concat([g.result.winTile]);
          assert(MJ.canWin(concealed, pl.melds.length),
            `宣告胡牌但引擎複驗不過 (局 ${gi}, seat ${w.player})`);
        }
        taiSum += w.tai; taiCount++; maxTai = Math.max(maxTai, w.tai);
        for (const b of w.breakdown) winTypes[b.name] = (winTypes[b.name] || 0) + 1;
      }
    }
  } catch (e) {
    failures++;
    console.error(`  ✗ 局 ${gi} 例外: ${e.message}`);
    if (failures > 10) { console.error('  失敗過多,中止'); break; }
  }
}

console.log(`\n  局數 ${N} | 步數 ${steps}`);
console.log(`  胡牌 ${wins} (${(wins / N * 100).toFixed(1)}%) | 流局 ${draws} (${(draws / N * 100).toFixed(1)}%) | 一炮多響 ${multiHu}`);
if (taiCount) console.log(`  平均 ${(taiSum / taiCount).toFixed(2)} 台 | 最大 ${maxTai} 台`);
const top = Object.entries(winTypes).sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('  台型分布:', top.map(([k, v]) => `${k}:${v}`).join('  '));

console.log(`\n${failures === 0 ? '✅ 全部通過' : '❌ 有 ' + failures + ' 項失敗'}`);
process.exit(failures === 0 ? 0 : 1);

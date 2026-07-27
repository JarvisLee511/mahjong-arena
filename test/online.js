/* ============================================================
   Online multiplayer stress / freeze test.
   Runs the REAL js/online.js as three independent clients
   (host seat 0 + two guests seats 1,2 + one AI seat 3) wired
   through a simulated message bus on a virtual clock, so we can
   inject packet loss / staleness and detect a player who can no
   longer act (buttons disabled, guestOnlineReady stuck false).

   Run: node test/online.js
   ============================================================ */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MJ = require('../js/engine.js');
const { Game } = require('../js/game.js');
const MJAI = require('../js/ai.js');

const ONLINE_SRC = (() => {
  const p = path.join(__dirname, '../js/online.js');
  let src = fs.readFileSync(p, 'utf8');
  const close = src.lastIndexOf('\n})();');
  if (close < 0) throw new Error('online.js closure marker not found');
  // Expose the internals we need to drive a client from the harness.
  const hook = `
  window.__t = {
    createHost: async () => {
      mode = 'host';
      seats = [{ seat: 0, cid: window.MJNet.clientId, token: playerToken, name: '房主', ai: false }];
      await window.MJNet.create(hostOnMsg);
      window.__onlineEmote = onlineEmote;
    },
    joinGuest: async (roomCode) => {
      mode = 'guest'; mySeat = null; myName = '玩家'; guestOnlineReady = false; joinRejected = false;
      await window.MJNet.join(roomCode, guestOnMsg);
      window.__onlineEmote = onlineEmote;
      joinStatus = 'connecting';
      startJoinHandshake();
    },
    startHost: () => hostStartGame(),
    state: () => ({ mode, mySeat, started, guestReady: guestOnlineReady, phase: G && G.phase, turn: G && G.turn, over: !!(G && G.phase === 'over') }),
    hostSeats: () => (seats || []).map((s) => (s ? { seat: s.seat, cid: s.cid || null, ai: !!s.ai } : null)),
  };
`;
  return src.slice(0, close) + hook + src.slice(close);
})();

// ---------------------------------------------------------------
// Virtual clock (shared across all client contexts)
// ---------------------------------------------------------------
let now = 0, timerSeq = 0, timers = [];
let harnessError = null;
function vSetTimeout(fn, delay) {
  const t = { time: now + (Number(delay) || 0), id: ++timerSeq, fn, dead: false };
  timers.push(t);
  return t.id;
}
function vClearTimeout(id) {
  if (id == null) return;
  const t = timers.find((x) => x.id === id);
  if (t) t.dead = true;
}
async function drain(budgetMs) {
  const deadline = now + budgetMs;
  let steps = 0;
  while (true) {
    let best = -1;
    for (let i = 0; i < timers.length; i++) {
      const t = timers[i];
      if (t.dead) continue;
      if (best < 0 || t.time < timers[best].time || (t.time === timers[best].time && t.id < timers[best].id)) best = i;
    }
    if (best < 0) break;
    const t = timers[best];
    timers.splice(best, 1);
    if (t.dead) continue;
    now = Math.max(now, t.time);
    if (now > deadline) break;
    try { t.fn(); } catch (e) { harnessError = harnessError || e; }
    // flush microtasks (online.js awaits MJNet.send) before the next timer
    await new Promise((r) => setImmediate(r));
    if (++steps > 5_000_000) throw new Error('runaway virtual clock');
  }
}

// ---------------------------------------------------------------
// Message bus (shared)
// ---------------------------------------------------------------
const LATENCY = 20;    // ms each message spends in flight
const REACT = 30;      // ms a bot waits before responding to a view
let clientsInRun = [];
let dropFn = () => false;   // (fromClient, toClient, msg) => boolean
const stats = () => runStats;
let runStats = null;

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function busSend(fromClient, msg) {
  for (const c of clientsInRun) {
    if (c === fromClient) continue;
    if (!c.code || c.code !== fromClient.code) continue;
    if (msg.to && msg.to !== c.clientId) continue;
    if (dropFn(fromClient, c, msg)) { runStats.dropped++; continue; }
    const delivered = { type: msg.type, payload: clone(msg.payload), from: msg.from };
    vSetTimeout(() => { if (c.onMsg) { try { c.onMsg(delivered.type, delivered.payload, delivered.from); } catch (e) { harnessError = harnessError || e; } } }, LATENCY);
  }
  return Promise.resolve(true);   // sender always believes it succeeded (the realistic, dangerous case)
}

// ---------------------------------------------------------------
// One simulated client running the real online.js
// ---------------------------------------------------------------
let cidSeq = 0;
const ROOM = 'TEST42';

function mkEl() {
  const cls = new Set();
  return {
    classList: {
      add: (x) => cls.add(x), remove: (x) => cls.delete(x), contains: (x) => cls.has(x),
      toggle: (x, f) => { const on = f == null ? !cls.has(x) : !!f; on ? cls.add(x) : cls.delete(x); return on; },
    },
    style: {}, dataset: {}, value: '', disabled: false, textContent: '',
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
    querySelector() { return mkEl(); }, querySelectorAll() { return []; },
    focus() {}, blur() {}, getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
  };
}

function makeMJView(client) {
  function scheduleBot(v, handlers) {
    if (!v || !handlers || v.phase === 'over') return;
    let move = null;
    if (v.swap && !v.swap.done) {
      const pick = (v.myHand || []).slice(0, 3);
      if (pick.length === 3) move = () => handlers.onSwap(pick);
    } else if (v.myActions && v.myActions.length) {
      const tsumo = v.myActions.find((a) => a.type === 'tsumo');
      if (tsumo) move = () => handlers.onAct({ type: 'tsumo' });
      else {
        const discs = v.myActions.filter((a) => a.type === 'discard');
        const kong = v.myActions.find((a) => a.type === 'ankong' || a.type === 'addkong');
        if (discs.length) { const d = discs[(Math.random() * discs.length) | 0]; move = () => handlers.onAct({ type: 'discard', tile: d.tile }); }
        else if (kong) move = () => handlers.onAct({ type: kong.type, tile: kong.tile });
      }
    } else if (v.myClaims && v.myClaims.length) {
      const hu = v.myClaims.find((o) => o.type === 'hu');
      if (hu) move = () => handlers.onClaim({ type: 'hu' });
      else if (Math.random() < 0.3) {
        const o = v.myClaims[(Math.random() * v.myClaims.length) | 0];
        move = () => (o.type === 'chow' ? handlers.onClaim({ type: 'chow', tiles: o.tiles.slice() }) : handlers.onClaim({ type: o.type }));
      } else move = () => handlers.onClaim({ type: 'pass' });
    }
    if (!move) return;
    const gen = (client.moveGen = (client.moveGen || 0) + 1);
    vSetTimeout(() => { if (client.moveGen !== gen) return; try { move(); } catch (e) { harnessError = harnessError || e; } }, REACT);
  }
  return {
    WIND: { z1: '東', z2: '南', z3: '西', z4: '北' },
    maskMelds: (m) => m,
    nicknames: () => [],
    renderView(v, handlers) {
      client.lastView = v;
      const bar = [];
      if (v && v.phase && v.phase !== 'over') {
        if (v.swap && !v.swap.done) bar.push({ label: 'swap', disabled: false });
        else if (v.myActions && v.myActions.length) v.myActions.forEach((a) => bar.push({ label: a.type, disabled: false }));
        else if (v.myClaims && v.myClaims.length) { v.myClaims.forEach((o) => bar.push({ label: o.type, disabled: false })); bar.push({ label: 'pass', disabled: false }); }
      }
      client.actionBar = bar;
      scheduleBot(v, handlers);
    },
    rollDealer: (name, cb) => { if (cb) cb(); },
    drawWinds: (names, perm, dealer, cb) => { if (cb) cb(); },
    rollDice: () => {},
    dealAnim: (cb) => { if (cb) cb(); },
    clearSelection: () => {},
    hideResult: () => {},
    prepareTableLayout: () => {},
    showResult: () => {},
    playWinAnim: (kind, cb) => { if (cb) cb(); },
    toast: () => {}, actionFX: () => {}, showBubble: () => {}, burst: () => {}, refitTable: () => {},
  };
}

function wrapAI(client) {
  return {
    tileValue: MJAI.tileValue,
    claim: MJAI.claim,
    chooseDiscard: MJAI.chooseDiscard,
    LEVELS: MJAI.LEVELS,
    act(game, seat) {
      // On the host, MJAI.act for a guest seat (1/2) only happens in the
      // ACT_TIMEOUT fallback — i.e. that human got locked out of a turn.
      if (client.kind === 'host' && (seat === 1 || seat === 2)) {
        runStats.actLockouts++;
        runStats.lockoutSeat[seat] = (runStats.lockoutSeat[seat] || 0) + 1;
      }
      return MJAI.act(game, seat);
    },
  };
}

function makeClient(kind) {
  const clientId = kind + '#' + (++cidSeq);
  const client = { kind, clientId, code: null, onMsg: null, lastView: null, actionBar: [], moveGen: 0 };
  const els = new Map();
  const appEl = mkEl();
  const q = (sel) => {
    if (sel === '#app') return appEl;
    if (!els.has(sel)) els.set(sel, mkEl());
    return els.get(sel);
  };
  const documentStub = {
    querySelector: q,
    querySelectorAll: (sel) => (sel && sel.indexOf('act-btn') >= 0 ? client.actionBar : []),
    createElement: () => mkEl(),
    addEventListener() {}, removeEventListener() {},
    get hidden() { return false; },
    body: mkEl(),
  };
  const net = {
    clientId,
    get code() { return client.code; },
    get role() { return kind === 'host' ? 'host' : 'guest'; },
    usingSupabase: false,
    normalizeRoomCode: (v) => String(v == null ? '' : v).toUpperCase(),
    create: async (handler) => { client.onMsg = handler; client.code = ROOM; return ROOM; },
    join: async (room, handler) => { client.onMsg = handler; client.code = room; return room; },
    restore: async (room, r, handler) => { client.onMsg = handler; client.code = room; return room; },
    send: (type, payload, to) => busSend(client, { type, payload, from: clientId, to: to || null }),
    to: (cid, type, payload) => busSend(client, { type, payload, from: clientId, to: cid }),
    leave: () => { client.code = null; },
  };
  client.MJNet = net;
  const win = {
    MJGame: { Game }, MJ, MJAI: wrapAI(client),
    MJView: makeMJView(client),
    MJSound: new Proxy({}, { get: () => () => {} }),
    MJNet: net,
    MJSolo: { cfg: { rule: 'std', lvl: 'normal', len: 'round', stake: '30/10' } },
    MJSession: { load: () => null, save() {}, setScene() {}, token: () => clientId, clear() {} },
    addEventListener() {}, removeEventListener() {},
  };
  const sandbox = {
    window: win,
    document: documentStub,
    MJSound: win.MJSound,          // online.js uses a BARE global MJSound
    setTimeout: vSetTimeout,
    clearTimeout: vClearTimeout,
    alert() {},
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(ONLINE_SRC, sandbox, { filename: 'online.js' });
  client.win = win;
  client.t = win.__t;
  return client;
}

// ---------------------------------------------------------------
// Scenario runner: one hand, host + 2 guests + AI seat 3
// ---------------------------------------------------------------
async function playHand(drop) {
  now = 0; timers = []; timerSeq = 0; harnessError = null;
  runStats = { dropped: 0, actLockouts: 0, lockoutSeat: {} };
  dropFn = drop || (() => false);

  const host = makeClient('host');
  const g1 = makeClient('guest');
  const g2 = makeClient('guest');
  clientsInRun = [host, g1, g2];

  await host.t.createHost();
  await g1.t.joinGuest(ROOM);
  await g2.t.joinGuest(ROOM);
  await drain(50_000);   // let join handshakes settle

  const seatInfo = host.t.hostSeats();
  const g1Seated = seatInfo.some((s) => s && s.cid === g1.clientId);
  const g2Seated = seatInfo.some((s) => s && s.cid === g2.clientId);

  host.t.startHost();
  await drain(3_000_000);

  if (harnessError) throw harnessError;
  return { host, g1, g2, g1Seated, g2Seated, stats: runStats };
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------
(async () => {
  let failures = 0;
  const ok = (c, m) => { if (c) console.log(`[PASS] ${m}`); else { failures++; console.error(`[FAIL] ${m}`); } };

  // --- Part A: baseline, perfect network -------------------------------
  console.log('\n[A] Baseline (no packet loss) — 60 hands');
  let doneA = 0, lockoutsA = 0;
  for (let i = 0; i < 60; i++) {
    const r = await playHand(() => false);
    if (r.host.t.state().over) doneA++;
    lockoutsA += r.stats.actLockouts;
    if (!r.g1Seated || !r.g2Seated) { console.error('  guest failed to seat in baseline'); }
  }
  console.log(`    hands completed: ${doneA}/60 | guest turns auto-played by host (lockouts): ${lockoutsA}`);
  ok(doneA === 60, 'A1 every baseline hand reaches a result');
  ok(lockoutsA === 0, 'A2 with a reliable network no guest is ever locked out');

  // --- Part B: realistic mobile packet loss ----------------------------
  console.log('\n[B] Lossy channel (~6% loss on in-game data) — 60 hands');
  const IN_GAME = new Set(['view', 'result', 'act', 'claim', 'swap']);
  let doneB = 0, lockoutsB = 0, handsWithLockout = 0, deadlocks = 0, frozenAtEndB = 0;
  for (let i = 0; i < 60; i++) {
    const r = await playHand((from, to, msg) => IN_GAME.has(msg.type) && Math.random() < 0.06);
    const over = r.host.t.state().over;
    if (over) doneB++; else deadlocks++;
    lockoutsB += r.stats.actLockouts;
    if (r.stats.actLockouts > 0) handsWithLockout++;
    for (const g of [r.g1, r.g2]) if (g.t.state().guestReady === false) frozenAtEndB++;
  }
  console.log(`    hands completed: ${doneB}/60 | hard deadlocks: ${deadlocks}`);
  console.log(`    guest turns the host had to auto-play: ${lockoutsB} across ${handsWithLockout} hands (pre-fix baseline was 221 / 56 hands)`);
  console.log(`    guests still frozen at hand end: ${frozenAtEndB}`);
  ok(doneB === 60, 'B1 every lossy hand still completes');
  ok(frozenAtEndB === 0, 'B2 no guest is left frozen at the end of a hand (watchdog/re-sync recovers them)');
  ok(lockoutsB < 60, 'B3 lockouts are sharply reduced vs the pre-fix baseline (players recover and play their own turns)');

  // --- Part C: targeted — one guest's downlink dies mid-hand then heals ---
  console.log('\n[C] Targeted: a guest loses ALL views for a window, then the link heals');
  let recoveredCount = 0, testedC = 0;
  for (let attempt = 0; attempt < 30 && testedC < 8; attempt++) {
    const targeted = { cid: null, healAt: null };
    const r = await playHand((from, to, msg) => {
      if (!targeted.cid && msg.type === 'act' && from.kind === 'guest') { targeted.cid = from.clientId; targeted.healAt = now + 12000; }
      // kill that guest's downlink for a 12s window, then let it heal
      return targeted.cid && to.clientId === targeted.cid && now < targeted.healAt
        && (msg.type === 'view' || msg.type === 'result');
    });
    const targetGuest = [r.g1, r.g2].find((g) => g.clientId === targeted.cid);
    if (!targetGuest) continue;
    testedC++;
    const st = targetGuest.t.state();
    if (r.host.t.state().over && st.guestReady === true) recoveredCount++;
  }
  console.log(`    guests whose link died then healed and RECOVERED (guestReady=true by end): ${recoveredCount}/${testedC}`);
  ok(testedC > 0 && recoveredCount === testedC, 'C1 a guest whose link drops then recovers is auto-re-synced (no permanent freeze)');

  console.log(`\n${failures ? failures + ' check(s) FAILED' : 'all checks passed'}`);
  if (harnessError) { console.error('harness error:', harnessError); process.exitCode = 1; }
  if (failures) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });

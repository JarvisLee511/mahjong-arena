/* ============================================================
   Claim/action regression tests.
   Run: node test/claims.js
   ============================================================ */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MJ = require('../js/engine.js');
const { Game } = require('../js/game.js');

function tiles(value) {
  return value.trim() ? value.trim().split(/\s+/) : [];
}

function rigGame({ hands = {}, melds = {}, discards = {}, flowers = {}, turn = 0 } = {}) {
  const game = new Game({ rng: () => 0.5 });
  const wall = MJ.buildWall();

  function reserve(tile) {
    const index = wall.indexOf(tile);
    assert.notEqual(index, -1, `fixture uses too many copies of ${tile}`);
    wall.splice(index, 1);
  }

  game.players = [0, 1, 2, 3].map((seat) => {
    const playerMelds = (melds[seat] || []).map((meld) => ({
      ...meld,
      tiles: meld.tiles.slice(),
    }));
    const player = {
      seat,
      hand: (hands[seat] || []).slice(),
      melds: playerMelds,
      flowers: (flowers[seat] || []).slice(),
      discards: (discards[seat] || []).slice(),
      _drawn: null,
    };
    player.hand.forEach(reserve);
    player.melds.forEach((meld) => meld.tiles.forEach(reserve));
    player.flowers.forEach(reserve);
    player.discards.forEach(reserve);
    return player;
  });

  // Keep flowers away from both draw ends so a replacement draw cannot
  // accidentally turn a focused kong test into an eight-flower win.
  const ordinary = wall.filter((tile) => !MJ.isFlower(tile));
  const looseFlowers = wall.filter(MJ.isFlower);
  const middle = Math.floor(ordinary.length / 2);
  game.wall = ordinary.slice(0, middle).concat(looseFlowers, ordinary.slice(middle));
  game.front = 0;
  game.back = game.wall.length - 1;
  game.wallStartFront = 0;
  game.wallStartBack = 0;
  game.wallStart = game.wall.length;
  game.turn = turn;
  game.phase = 'act';
  game.lastDiscard = null;
  game.pendingClaims = null;
  game.pendingAddKong = null;
  game.mustDiscardAfterClaim = false;
  game.result = null;
  game.firstGoAround = false;
  game.kongPending = false;
  game.furiten = [false, false, false, false];
  game.ready = [null, null, null, null];
  return game;
}

function assertInventory(game, message) {
  let total = game.wallCount();
  const counts = {};
  const count = (tile) => { counts[tile] = (counts[tile] || 0) + 1; };

  for (const player of game.players) {
    total += player.hand.length + player.flowers.length + player.discards.length;
    player.hand.forEach(count);
    player.flowers.forEach(count);
    player.discards.forEach(count);
    for (const meld of player.melds) {
      total += meld.tiles.length;
      meld.tiles.forEach(count);
    }
  }
  for (let index = game.front; index <= game.back; index++) count(game.wall[index]);

  assert.equal(total, 144, `${message}: expected 144 owned tiles, got ${total}`);
  for (const [tile, amount] of Object.entries(counts)) {
    assert.ok(amount <= (MJ.isFlower(tile) ? 1 : 4), `${message}: ${tile} appears ${amount} times`);
  }
}

function snapshot(game) {
  return JSON.stringify(game, (key, value) => (typeof value === 'function' ? undefined : value));
}

function openDiscardClaim(game, from, tile) {
  game.phase = 'act';
  game.lastDiscard = { from, tile };
  game._openClaims(from, tile);
  assert.equal(game.phase, 'claim');
}

function addKongFixture() {
  return rigGame({
    hands: {
      0: tiles('m5 m1 m2 m3 p4 p5 p6 s2 s3 s4 z1 z1 z2 z2'),
      1: tiles('p1 p1 p1 p2 p2 p2 p3 p3 p3 s1 s1 s1 m3 m4 p9 p9'),
    },
    melds: {
      0: [{ type: 'pung', tiles: ['m5', 'm5', 'm5'], concealed: false, from: 3 }],
    },
  });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('illegal turn actions are rejected without mutation', () => {
  const game = rigGame({
    hands: { 0: tiles('m1 m2 m3 m4 m5 m6 m7 m8 m9 p1 p2 p3 p4 p5 p6 z1 z2') },
  });
  const before = snapshot(game);

  assert.throws(() => game.applyAct(0, { type: 'tsumo' }), /illegal action/);
  assert.throws(() => game.applyAct(0, { type: 'ankong', tile: 'm1' }), /illegal action/);
  assert.throws(() => game.applyAct(0, { type: 'addkong', tile: 'm1' }), /illegal action/);
  assert.throws(() => game.applyAct(0, { type: 'discard', tile: 'f1' }), /illegal action/);
  assert.throws(() => game.applyAct(1, { type: 'discard', tile: 'm1' }), /not your turn/);

  assert.equal(snapshot(game), before);
  assertInventory(game, 'illegal actions');
});

test('forged claims are rejected and an exact chow is accepted', () => {
  const game = rigGame({
    hands: {
      2: tiles('m3 m4 p1 p2 p4 p5 p7 p8 s1 s2 s4 s5 s7 s8 z1 z2'),
    },
    discards: { 1: ['m5'] },
  });
  openDiscardClaim(game, 1, 'm5');
  assert.deepEqual(game.claimActions(2), [{ type: 'chow', tiles: ['m3', 'm4', 'm5'] }]);

  for (const forged of [
    { type: 'hu' },
    { type: 'pung' },
    { type: 'kong' },
    { type: 'chow', tiles: ['m4', 'm3', 'm5'] },
    { type: 'chow', tiles: ['m3', 'm5', 'm6'] },
  ]) {
    const before = snapshot(game);
    assert.throws(() => game.declareClaim(2, forged), /illegal claim/);
    assert.equal(snapshot(game), before);
  }
  const beforeIneligible = snapshot(game);
  assert.equal(game.declareClaim(0, { type: 'hu' }), false);
  assert.equal(snapshot(game), beforeIneligible);

  assert.equal(game.declareClaim(2, { type: 'chow', tiles: ['m3', 'm4', 'm5'] }), true);
  assert.equal(game.phase, 'act');
  assert.equal(game.turn, 2);
  assertInventory(game, 'accepted chow');
});

test('pung forces a discard even when the remaining hand can self-win', () => {
  const game = rigGame({
    hands: {
      2: tiles('m5 m5 p1 p1 p1 p2 p2 p2 p3 p3 p3 s1 s1 s1 z1 z1'),
    },
    discards: { 1: ['m5'] },
  });
  openDiscardClaim(game, 1, 'm5');
  assert.ok(game.claimActions(2).some((action) => action.type === 'hu'));
  assert.ok(game.claimActions(2).some((action) => action.type === 'pung'));
  game.ready[2] = 'di';

  game.declareClaim(2, { type: 'pung' });
  assert.equal(game.mustDiscardAfterClaim, true);
  assert.equal(game.ready[2], null);
  assert.equal(game.lastDiscard, null);
  assert.ok(game.actActions(2).length > 0);
  assert.ok(game.actActions(2).every((action) => action.type === 'discard'));

  game.applyAct(2, { type: 'discard', tile: 'p1' });
  assert.equal(game.mustDiscardAfterClaim, false);
  assertInventory(game, 'pung then discard');
});

test('chow forces a discard even when a concealed kong is present', () => {
  const game = rigGame({
    hands: {
      2: tiles('m3 m4 p1 p1 p1 p1 p2 p3 p4 s2 s3 s4 z1 z1 z2 z2'),
    },
    discards: { 1: ['m5'] },
  });
  openDiscardClaim(game, 1, 'm5');
  game.ready[2] = 'di';
  game.declareClaim(2, { type: 'chow', tiles: ['m3', 'm4', 'm5'] });

  assert.equal(game.mustDiscardAfterClaim, true);
  assert.equal(game.ready[2], null);
  assert.equal(game.players[2].hand.filter((tile) => tile === 'p1').length, 4);
  assert.ok(game.actActions(2).every((action) => action.type === 'discard'));
  assert.ok(!game.actActions(2).some((action) => action.type === 'ankong'));

  game.applyAct(2, { type: 'discard', tile: 'p1' });
  assert.equal(game.mustDiscardAfterClaim, false);
  assertInventory(game, 'chow then discard');
});

test('passing a rob-kong claim commits the added kong and preserves all tiles', () => {
  const game = addKongFixture();
  assertInventory(game, 'before add-kong');

  game.applyAct(0, { type: 'addkong', tile: 'm5' });
  assert.equal(game.phase, 'claim');
  assert.deepEqual(game.claimActions(1), [{ type: 'hu' }]);
  assert.equal(game.players[0].melds[0].type, 'pung');
  assert.equal(game.players[0].hand.filter((tile) => tile === 'm5').length, 1);
  assertInventory(game, 'pending add-kong');

  game.declareClaim(1, { type: 'pass' });
  const meld = game.players[0].melds[0];
  assert.equal(game.phase, 'act');
  assert.equal(game.pendingClaims, null);
  assert.equal(game.pendingAddKong, null);
  assert.equal(meld.type, 'kong');
  assert.equal(meld.subtype, 'add');
  assert.deepEqual(meld.tiles, ['m5', 'm5', 'm5', 'm5']);
  assert.equal(game.players[0].hand.filter((tile) => tile === 'm5').length, 0);
  assert.equal(game.players[0].hand.length, 14);
  assert.equal(game.furiten[1], true);
  assertInventory(game, 'committed add-kong');
});

test('rob-kong rolls the pending upgrade back and preserves all tiles', () => {
  const game = addKongFixture();
  game.applyAct(0, { type: 'addkong', tile: 'm5' });
  assertInventory(game, 'pending robbed kong');

  game.declareClaim(1, { type: 'hu' });
  const meld = game.players[0].melds[0];
  assert.equal(game.phase, 'over');
  assert.equal(game.pendingClaims, null);
  assert.equal(game.pendingAddKong, null);
  assert.equal(meld.type, 'pung');
  assert.deepEqual(meld.tiles, ['m5', 'm5', 'm5']);
  assert.equal(game.players[0].hand.filter((tile) => tile === 'm5').length, 0);
  assert.equal(game.players[0].discards.at(-1), 'm5');
  assert.equal(game.result.selfDraw, false);
  assert.equal(game.result.loser, 0);
  assert.equal(game.result.winTile, 'm5');
  assert.equal(game.result.winners[0].player, 1);
  assert.ok(game.result.winners[0].breakdown.some((item) => item.name === '搶槓'));
  assertInventory(game, 'completed rob-kong');
});

test('online claim timeout passes remaining seats without stale-state access', () => {
  const game = rigGame({
    hands: {
      0: tiles('m3 m4 p1 p2 p4 p5 p7 p8 s1 s2 s4 s5 s7 s8 z1 z2'),
      2: tiles('m5 m5 p1 p2 p4 p5 p7 p8 s1 s2 s4 s5 s7 s8 z1 z2'),
    },
    discards: { 3: ['m5'] },
  });
  openDiscardClaim(game, 3, 'm5');
  assert.deepEqual(Object.keys(game.pendingClaims.options), ['0', '2']);
  assert.equal(game.declareClaim(2, { type: 'pass' }), true);
  assert.equal(game.declareClaim(2, { type: 'pung' }), false);
  assert.equal(game.pendingClaims.declared[2].type, 'pass');

  const onlinePath = path.join(__dirname, '../js/online.js');
  let source = fs.readFileSync(onlinePath, 'utf8');
  const closeIndex = source.lastIndexOf('\n})();');
  assert.ok(closeIndex >= 0, 'online.js closure marker not found');
  source = source.slice(0, closeIndex) + `
  window.__onlineClaimTest = {
    hostClaims,
    setGame(value) { G = value; },
    setSeats(value) { seats = value; },
  };
` + source.slice(closeIndex);

  const timers = [];
  const elements = new Map();
  const makeElement = () => ({
    addEventListener() {},
    appendChild() {},
    classList: { add() {}, remove() {} },
    dataset: {},
    style: {},
    value: '',
  });
  const windowStub = {
    MJGame: { Game },
    MJ,
    MJSolo: { cfg: { len: 'round', rule: 'classic', stake: 1 } },
    MJView: { renderView() {}, WIND: {}, maskMelds: (melds) => melds },
    MJNet: { send() {}, to() {} },
    MJAI: {},
  };
  const context = {
    window: windowStub,
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, makeElement());
        return elements.get(selector);
      },
      querySelectorAll() { return []; },
      createElement() { return makeElement(); },
    },
    setTimeout(fn, delay) {
      const timer = { fn, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout() {},
    console,
  };
  vm.runInNewContext(source, context, { filename: onlinePath });

  windowStub.__onlineClaimTest.setGame(game);
  windowStub.__onlineClaimTest.setSeats([0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, ai: false })));
  windowStub.__onlineClaimTest.hostClaims();
  const timeout = timers.find((timer) => timer.delay === 9000);
  assert.ok(timeout, 'claim timeout was not scheduled');
  assert.doesNotThrow(() => timeout.fn());

  assert.equal(game.phase, 'act');
  assert.equal(game.pendingClaims, null);
  assert.equal(game.players[3].discards.at(-1), 'm5');
  assertInventory(game, 'online timeout resolution');
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures++;
    console.error(`[FAIL] ${name}`);
    console.error(error.stack || error);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} claim regression tests passed.`);
if (failures) process.exitCode = 1;

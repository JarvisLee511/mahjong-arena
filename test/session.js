/* Game-state persistence regression tests. Run: node test/session.js */
const assert = require('node:assert/strict');
const { Game } = require('../js/game.js');

function fixedRng() { return 0.314159; }

function restore(game) {
  return Game.fromState(game.exportState(), { rng: fixedRng });
}

let passed = 0;

const actGame = new Game({ rng: fixedRng });
const actRestored = restore(actGame);
assert.deepEqual(actRestored.exportState(), actGame.exportState());
const discard = actGame.actActions(actGame.turn).find((action) => action.type === 'discard');
assert.ok(discard);
actGame.applyAct(actGame.turn, discard);
actRestored.applyAct(actRestored.turn, discard);
assert.deepEqual(actRestored.exportState(), actGame.exportState());
passed++;

const swapGame = new Game({ rng: fixedRng, swapMode: true });
swapGame.selectSwap(0, swapGame.players[0].hand.slice(0, 3));
swapGame.selectSwap(2, swapGame.players[2].hand.slice(0, 3));
const swapRestored = restore(swapGame);
assert.deepEqual(swapRestored.exportState(), swapGame.exportState());
for (const seat of [1, 3]) {
  const originalTiles = swapGame.players[seat].hand.slice(0, 3);
  const restoredTiles = swapRestored.players[seat].hand.slice(0, 3);
  swapGame.selectSwap(seat, originalTiles);
  swapRestored.selectSwap(seat, restoredTiles);
}
assert.deepEqual(swapRestored.exportState(), swapGame.exportState());
passed++;

const kongGame = new Game({ rng: fixedRng });
kongGame.players[0].melds = [{ type: 'pung', tiles: ['m5', 'm5', 'm5'], from: 3 }];
kongGame.pendingAddKong = { player: 0, tile: 'm5', meld: kongGame.players[0].melds[0] };
kongGame.phase = 'claim';
kongGame.pendingClaims = { from: 0, tile: 'm5', options: { 1: [{ type: 'hu' }] }, declared: {} };
const kongRestored = restore(kongGame);
assert.strictEqual(kongRestored.pendingAddKong.meld, kongRestored.players[0].melds[0]);
assert.deepEqual(kongRestored.exportState(), kongGame.exportState());
passed++;

const overGame = new Game({ rng: fixedRng });
overGame.phase = 'over';
overGame.result = { type: 'draw' };
overGame._finishHandled = true;
const overRestored = restore(overGame);
assert.equal(overRestored._finishHandled, true);
assert.deepEqual(overRestored.exportState(), overGame.exportState());
passed++;

console.log(`session: ${passed}/4 passed`);

/* ============================================================
   Mahjong Arena — game state machine (Taiwanese 16-tile)
   Drives turn flow so BOTH the AI stress-test and the UI can
   poll legal actions and apply them. Deterministic given a seed.

   Turn model:
     phase 'act'   : current player has drawn; must choose an action
                     (discard / tsumo / ankong / addkong)
     phase 'claim' : someone discarded; other players may claim
                     (hu / pung / kong / chow) — resolved by priority
     phase 'over'  : hand finished (win or draw 流局)

   Sit order is counter-clockwise: seat 0→1→2→3→0 (下家 = +1).
   ============================================================ */

(function (root) {
  'use strict';
  const MJ = (typeof require !== 'undefined') ? require('./engine.js') : root.MJ;

  const NEXT = (i) => (i + 1) & 3;

  function sortHand(h) {
    const order = (t) => ({ m: 0, p: 1, s: 2, z: 3, f: 4 }[t[0]]) * 10 + (+t[1]);
    return h.sort((a, b) => order(a) - order(b));
  }

  class Game {
    constructor(opts = {}) {
      this.rng = opts.rng || Math.random;
      this.dealerIndex = opts.dealerIndex ?? 0;
      this.roundWind = opts.roundWind || 'z1';
      this.streak = opts.streak || 0;        // 連莊數
      this.allowMultiHu = opts.allowMultiHu ?? true; // 一炮多響
      this.swapMode = opts.swapMode || false;        // 換三張(美麻)
      this.deadWall = opts.deadWall ?? 16;           // 王牌:牌牆留最後16張不摸=流局
      this.onEvent = opts.onEvent || null;
      this._aiLevel = opts.aiLevel || 'normal';
      this.reset();
    }

    _emit(type, payload) { if (this.onEvent) this.onEvent(type, payload); }

    reset() {
      this.wall = MJ.shuffle(MJ.buildWall(), this.rng);
      this.front = 0;
      this.back = this.wall.length - 1;
      this.players = [0, 1, 2, 3].map((i) => ({
        seat: i, hand: [], melds: [], flowers: [], discards: [],
      }));
      this.turn = this.dealerIndex;
      this.phase = 'act';
      this.lastDiscard = null;      // { tile, from }
      this.pendingClaims = null;
      this.pendingAddKong = null;
      this.mustDiscardAfterClaim = false;
      this.result = null;
      this.log = [];
      this.firstGoAround = true;    // for 天/地/人胡
      this.kongPending = false;     // next draw is a replacement (槓上開花)
      this.furiten = [false, false, false, false];   // 過水:放棄可胡後不能再放槍胡,到自己摸牌才解
      this.ready = [null, null, null, null];          // 天聽/地聽:'tian'|'di'
      this._deal();
      // The visible wall starts after the initial deal. From here on the UI can
      // remove normal draws from one end and replacement draws from the other.
      this.wallStartFront = this.front;
      this.wallStartBack = this.wall.length - 1 - this.back;
      this.wallStart = this.wallCount();
    }

    // draw from front (normal) or back (replacement)。
    // 王牌:剩最後16張不摸(發牌階段最少也剩72張,不會誤觸)→ null=流局
    _draw(fromBack) {
      if (this.wallCount() <= this.deadWall) return null; // 流局
      return fromBack ? this.wall[this.back--] : this.wall[this.front++];
    }
    wallCount() { return Math.max(0, this.back - this.front + 1); }
    liveWallCount() { return Math.max(0, this.wallCount() - this.deadWall); }

    _deal() {
      // 16 each, dealer 17 (dealer's extra is the opening draw)
      for (let r = 0; r < 16; r++) {
        for (let k = 0; k < 4; k++) {
          const p = (this.dealerIndex + k) & 3;
          this.players[p].hand.push(this._draw(false));
        }
      }
      // replace flowers dealt into hands (補花), dealer first
      for (let k = 0; k < 4; k++) {
        const p = (this.dealerIndex + k) & 3;
        this._replaceFlowers(p);
      }
      if (this.swapMode) {
        // 換三張:先讓四家各挑 3 張互傳(兩輪、都傳下家),再開打
        this.phase = 'swap'; this.swapRound = 1; this.swapSel = {};
      } else {
        // dealer's opening draw (→ 17 tiles, must act)
        this._drawForTurn(false);
      }
    }

    // ---- 換三張 (swap phase) ---------------------------------
    // seat commits exactly 3 tiles to pass to 下家; when all 4 in, resolve.
    selectSwap(seat, tiles) {
      if (this.phase !== 'swap' || this.swapSel[seat]) return;
      if (!Array.isArray(tiles) || tiles.length !== 3) return;
      const check = this.players[seat].hand.slice();
      for (const t of tiles) { const i = check.indexOf(t); if (i < 0) return; check.splice(i, 1); }
      this.swapSel[seat] = tiles.slice();
      if ([0, 1, 2, 3].every((s) => this.swapSel[s])) this._executeSwap();
    }
    swapReady(seat) { return !!this.swapSel[seat]; }

    _executeSwap() {
      const passing = {};
      for (let s = 0; s < 4; s++) {
        passing[s] = this.swapSel[s];
        for (const t of passing[s]) this.players[s].hand.splice(this.players[s].hand.indexOf(t), 1);
      }
      for (let s = 0; s < 4; s++) { const dest = (s + 1) & 3; passing[s].forEach((t) => this.players[dest].hand.push(t)); }
      for (let s = 0; s < 4; s++) sortHand(this.players[s].hand);
      this.swapSel = {};
      this._emit('swap', { round: this.swapRound });
      if (this.swapRound < 2) this.swapRound++;
      else this._drawForTurn(false);   // 兩輪換完 → 莊家起手摸牌,phase 'act'
    }

    // move any flowers out of a hand, drawing replacements from back
    _replaceFlowers(p) {
      const pl = this.players[p];
      let moved = true;
      while (moved) {
        moved = false;
        for (let i = 0; i < pl.hand.length; i++) {
          if (MJ.isFlower(pl.hand[i])) {
            pl.flowers.push(pl.hand[i]);
            pl.hand.splice(i, 1);
            const rep = this._draw(true);
            if (rep != null) pl.hand.push(rep);
            moved = true;
            break;
          }
        }
      }
      sortHand(pl.hand);
    }

    // current player draws (front unless replacement), auto-replacing flowers
    _drawForTurn(fromBack) {
      const pl = this.players[this.turn];
      const t = this._draw(fromBack);
      if (t == null) { this._drawGame(); return; }
      if (MJ.isFlower(t)) {
        pl.flowers.push(t);
        // 八仙過海:自己湊滿 8 花 → 自摸大胡
        if (pl.flowers.length === 8) { this._flowerWin(this.turn, 'baxian', null); return; }
        // 七搶一:別家已有 7 花,這第 8 張被我摸到 → 對方搶花胡(我放銃)
        const robber = this.players.findIndex((q, i) => i !== this.turn && q.flowers.length === 7);
        if (robber >= 0) { this._flowerWin(robber, 'qiqiang', this.turn); return; }
        this._drawForTurn(true); // 補花:從牌尾補一張(不設槓旗標,補花自摸≠槓上開花)
        return;
      }
      pl.hand.push(t);
      pl._drawn = t;
      this.mustDiscardAfterClaim = false;
      this.furiten[this.turn] = false;   // 自己摸牌 → 解除過水
      sortHand(pl.hand);
      this.phase = 'act';
    }

    // ---- concealed-part helpers for a player -----------------
    _concealed(p) { return this.players[p].hand; }
    _exposedCount(p) { return this.players[p].melds.length; }

    // ---------- actions available in phase 'act' --------------
    actActions(p = this.turn) {
      if (this.phase !== 'act' || p !== this.turn) return [];
      const pl = this.players[p];
      const acts = [];
      // discard any tile
      for (const t of new Set(pl.hand)) acts.push({ type: 'discard', tile: t });
      if (this.mustDiscardAfterClaim) return acts;
      // self win (自摸)
      if (MJ.canWin(pl.hand, pl.melds.length)) acts.push({ type: 'tsumo' });
      // 暗槓 (4 concealed identical)
      const cnt = {};
      for (const t of pl.hand) cnt[t] = (cnt[t] || 0) + 1;
      for (const t in cnt) if (cnt[t] === 4) acts.push({ type: 'ankong', tile: t });
      // 加槓 (draw matches an existing pung)
      for (const m of pl.melds) {
        if (m.type === 'pung' && pl.hand.includes(m.tiles[0])) {
          acts.push({ type: 'addkong', tile: m.tiles[0] });
        }
      }
      return acts;
    }

    applyAct(p, action) {
      if (this.phase !== 'act' || p !== this.turn) throw new Error('not your turn');
      if (!action || typeof action.type !== 'string') throw new Error('invalid action');
      const allowed = this.actActions(p).find((candidate) => (
        candidate.type === action.type &&
        (candidate.tile == null || candidate.tile === action.tile)
      ));
      if (!allowed) throw new Error('illegal action');
      action = allowed;
      const pl = this.players[p];
      if (action.type === 'discard') {
        const idx = pl.hand.indexOf(action.tile);
        if (idx < 0) throw new Error('no such tile');
        if (this.ready[p] && pl._drawn && action.tile !== pl._drawn) this.ready[p] = null;
        pl.hand.splice(idx, 1);
        pl._drawn = null;
        this.mustDiscardAfterClaim = false;
        this.lastDiscard = { tile: action.tile, from: p };
        pl.discards.push(action.tile);
        this.kongPending = false;
        // 天聽/地聽:第一巡未被吃碰打斷、打完即聽(莊=天聽,閒=地聽)
        if (this.firstGoAround && !this.ready[p] && MJ.isTenpai(pl.hand, pl.melds)) {
          this.ready[p] = (p === this.dealerIndex) ? 'tian' : 'di';
          this._emit('ready', { player: p, kind: this.ready[p] });
        }
        this._emit('discard', { player: p, tile: action.tile });
        this._openClaims(p, action.tile);
        return;
      }
      if (action.type === 'tsumo') {
        this._win([p], true);
        return;
      }
      if (action.type === 'ankong') {
        this.ready[p] = null;
        for (let k = 0; k < 4; k++) pl.hand.splice(pl.hand.indexOf(action.tile), 1);
        pl.melds.push({ type: 'kong', subtype: 'an', tiles: Array(4).fill(action.tile), concealed: true });
        this.kongPending = true;
        this._emit('kong', { player: p, subtype: 'an', tile: action.tile });
        this._drawForTurn(true);
        return;
      }
      if (action.type === 'addkong') {
        this.ready[p] = null;
        // robbable: give others a 搶槓 chance before completing
        const m = pl.melds.find((x) => x.type === 'pung' && x.tiles[0] === action.tile);
        this.pendingAddKong = { player: p, tile: action.tile, meld: m };
        this.lastDiscard = { tile: action.tile, from: p, robKong: true };
        this._openClaims(p, action.tile, true);
        return;
      }
      throw new Error('unknown action');
    }

    // ---------- claims after a discard (phase 'claim') --------
    _openClaims(from, tile, robKong = false) {
      const options = {};
      let any = false;
      for (let d = 1; d <= 3; d++) {
        const p = (from + d) & 3;
        const pl = this.players[p];
        const list = [];
        // 胡 (ron) — 搶槓 only allows hu;過水中不能放槍胡
        if (!this.furiten[p] && MJ.canWin(pl.hand.concat([tile]), pl.melds.length)) list.push({ type: 'hu' });
        if (!robKong) {
          const same = pl.hand.filter((t) => t === tile).length;
          if (same >= 2) list.push({ type: 'pung' });
          if (same >= 3) list.push({ type: 'kong' }); // 大明槓
          // 吃 — only from 上家 (the player just before p, i.e. from === prev of p)
          if (((from + 1) & 3) === p && MJ.isSuited(tile)) {
            for (const seq of chowOptions(pl.hand, tile)) list.push({ type: 'chow', tiles: seq });
          }
        }
        if (list.length) { options[p] = list; any = true; }
      }
      if (!any) {
        if (robKong) { this._afterKongNoRob(from); return; } // complete the 加槓
        this._advanceAfterDiscard(from);
        return;
      }
      this.phase = 'claim';
      this.pendingClaims = { from, tile, robKong, options, declared: {} };
    }

    claimActions(p) {
      if (this.phase !== 'claim' || !this.pendingClaims) return [];
      return this.pendingClaims.options[p] || [];
    }

    // each eligible player declares a choice (or {type:'pass'}); when all in, resolve
    declareClaim(p, action) {
      if (this.phase !== 'claim') throw new Error('no claim open');
      const options = this.pendingClaims.options[p];
      if (!options || this.pendingClaims.declared[p]) return false;
      const requested = action || { type: 'pass' };
      let choice = null;
      if (requested.type === 'pass') {
        choice = { type: 'pass' };
      } else {
        choice = options.find((option) => (
          option.type === requested.type &&
          (option.type !== 'chow' || (
            Array.isArray(requested.tiles) &&
            option.tiles.length === requested.tiles.length &&
            option.tiles.every((tile, index) => tile === requested.tiles[index])
          ))
        ));
      }
      if (!choice) throw new Error('illegal claim');
      this.pendingClaims.declared[p] = choice;
      const eligible = Object.keys(this.pendingClaims.options);
      if (eligible.every((k) => this.pendingClaims.declared[k])) this._resolveClaims();
      return true;
    }

    _resolveClaims() {
      const pc = this.pendingClaims;
      const decl = pc.declared;
      const from = pc.from, tile = pc.tile;
      // 過水:被開放可胡卻沒宣告胡的家 → 進入過水,到自己摸牌前不能再放槍胡
      for (const k of Object.keys(pc.options)) {
        if (pc.options[k].some((o) => o.type === 'hu') && decl[k] && decl[k].type !== 'hu') this.furiten[+k] = true;
      }
      // priority: hu > kong/pung > chow;胡家依離放槍者的近到遠排序(一炮一響取最近)
      const winners = Object.keys(decl).filter((k) => decl[k].type === 'hu').map(Number)
        .sort((a, b) => (((a - from) + 4) & 3) - (((b - from) + 4) & 3));
      if (winners.length) {
        this.pendingClaims = null;
        if (pc.robKong) {
          const robbed = this.pendingAddKong;
          if (robbed) {
            const robbedPlayer = this.players[robbed.player];
            robbedPlayer.hand.splice(robbedPlayer.hand.indexOf(robbed.tile), 1);
            robbedPlayer.discards.push(robbed.tile);
          }
          this.pendingAddKong = null;
        }
        const list = this.allowMultiHu ? winners : [winners[0]];
        this._win(list, false, tile, from, pc.robKong);
        return;
      }
      if (pc.robKong) { // nobody robbed → complete the 加槓
        this.pendingClaims = null;
        this._afterKongNoRob(from);
        return;
      }
      const sameTileClaim = Object.keys(decl)
        .filter((k) => decl[k].type === 'kong' || decl[k].type === 'pung')
        .map(Number)
        .sort((a, b) => (((a - from) + 4) & 3) - (((b - from) + 4) & 3))[0];
      const chow = Object.keys(decl).find((k) => decl[k].type === 'chow');
      this.pendingClaims = null;
      if (sameTileClaim != null && decl[sameTileClaim].type === 'kong') return this._doKongClaim(sameTileClaim, tile, from);
      if (sameTileClaim != null) return this._doPung(sameTileClaim, tile, from);
      if (chow != null) return this._doChow(+chow, decl[chow].tiles, tile, from);
      this._advanceAfterDiscard(from);
    }

    _removeFromHand(pl, tile, n) { for (let k = 0; k < n; k++) pl.hand.splice(pl.hand.indexOf(tile), 1); }

    // the claimed tile leaves the discarder's river and becomes part of the meld
    _takeDiscard(from) {
      this.players[from].discards.pop();
      this.lastDiscard = null;
    }

    _doPung(p, tile, from) {
      const pl = this.players[p];
      this._takeDiscard(from);
      this._removeFromHand(pl, tile, 2);
      pl.melds.push({ type: 'pung', tiles: [tile, tile, tile], concealed: false, from });
      this.turn = p; this.phase = 'act';
      pl._drawn = null;
      this.mustDiscardAfterClaim = true;
      this.ready[p] = null;
      this.firstGoAround = false;
      this._emit('pung', { player: p, from, tile });
      // pung → must discard (no draw)
    }
    _doKongClaim(p, tile, from) { // 大明槓
      const pl = this.players[p];
      this._takeDiscard(from);
      this._removeFromHand(pl, tile, 3);
      pl.melds.push({ type: 'kong', subtype: 'big', tiles: Array(4).fill(tile), concealed: false, from });
      this.turn = p; this.kongPending = true;
      this.firstGoAround = false;
      this.ready[p] = null;
      this._emit('kong', { player: p, from, tile, subtype: 'big' });
      this._drawForTurn(true); // draw replacement then act
    }
    _doChow(p, seq, tile, from) {
      const pl = this.players[p];
      this._takeDiscard(from);
      for (const t of seq) if (t !== tile) this._removeFromHand(pl, t, 1);
      pl.melds.push({ type: 'chow', tiles: seq.slice().sort(), concealed: false, from });
      this.turn = p; this.phase = 'act';
      pl._drawn = null;
      this.mustDiscardAfterClaim = true;
      this.ready[p] = null;
      this.firstGoAround = false;
      this._emit('chow', { player: p, from, tiles: seq });
    }
    _afterKongNoRob(p) {
      if (this.pendingAddKong && this.pendingAddKong.player === p) {
        const pending = this.pendingAddKong;
        const player = this.players[p];
        player.hand.splice(player.hand.indexOf(pending.tile), 1);
        pending.meld.type = 'kong';
        pending.meld.subtype = 'add';
        pending.meld.tiles = Array(4).fill(pending.tile);
        pending.meld.concealed = false;
        this.pendingAddKong = null;
        this._emit('kong', { player: p, tile: pending.tile, subtype: 'add' });
      }
      this.lastDiscard = null;
      this.turn = p; this.kongPending = true;
      this._drawForTurn(true);
    }

    _advanceAfterDiscard(from) {
      this.firstGoAround = this.firstGoAround && (((from + 1) & 3) !== this.dealerIndex ? true : false);
      // (天/地/人胡 only valid on the very first uninterrupted go-around)
      if (this.liveWallCount() <= 0) { this._drawGame(); return; }
      this.turn = NEXT(from);
      this._drawForTurn(false);
    }

    // 花牌大胡:八仙過海(自摸集滿8花)/ 七搶一(搶別人摸到的第8花)
    _flowerWin(p, kind, from) {
      const pl = this.players[p];
      const self = (kind === 'baxian');
      const tai = self ? 16 : 8;
      const bd = [{ name: self ? '八仙過海' : '七搶一', tai }];
      this.phase = 'over';
      this.result = {
        type: 'win', selfDraw: self,
        winners: [{ player: p, tai, breakdown: bd, winHand: { melds: pl.melds, hand: pl.hand.slice(), flowers: pl.flowers } }],
        loser: self ? null : from, winTile: null, flowerWin: kind,
      };
      this._emit('win', this.result);
    }

    // ---------- endings ---------------------------------------
    _win(winners, selfDraw, winTile, from, robKong) {
      const scores = winners.map((p) => {
        const pl = this.players[p];
        const concealed = selfDraw ? pl.hand.slice() : pl.hand.concat([winTile]);
        const ctx = {
          seatIndex: p, dealerIndex: this.dealerIndex, roundWind: this.roundWind,
          selfDraw, byRobKong: !!robKong, byKongDraw: this.kongPending && selfDraw,
          byLastTile: this.liveWallCount() <= 0,   // 摸走最後一張活牌=海底/河底
          flowers: pl.flowers, exposedMelds: pl.melds,
          winTile: selfDraw ? pl._drawn : winTile,
          isFirstDraw: this.firstGoAround, streak: this.streak,
          ready: this.ready[p],   // 天聽/地聽
        };
        const s = MJ.scoreWin(concealed, ctx) || { tai: 0, breakdown: [] };
        return { player: p, ...s };
      });
      this.phase = 'over';
      this.result = {
        type: 'win', selfDraw, winners: scores, loser: selfDraw ? null : from, winTile,
      };
      this._emit('win', this.result);
    }
    _drawGame() {
      this.phase = 'over';
      this.result = { type: 'draw' }; // 流局
    }

    exportState() {
      const pendingAddKong = this.pendingAddKong ? {
        player: this.pendingAddKong.player,
        tile: this.pendingAddKong.tile,
        meldIndex: this.players[this.pendingAddKong.player].melds.indexOf(this.pendingAddKong.meld),
      } : null;
      return JSON.parse(JSON.stringify({
        version: 1,
        dealerIndex: this.dealerIndex,
        roundWind: this.roundWind,
        streak: this.streak,
        allowMultiHu: this.allowMultiHu,
        swapMode: this.swapMode,
        deadWall: this.deadWall,
        aiLevel: this._aiLevel,
        wall: this.wall,
        front: this.front,
        back: this.back,
        players: this.players,
        turn: this.turn,
        phase: this.phase,
        lastDiscard: this.lastDiscard,
        pendingClaims: this.pendingClaims,
        pendingAddKong,
        mustDiscardAfterClaim: this.mustDiscardAfterClaim,
        result: this.result,
        log: this.log,
        firstGoAround: this.firstGoAround,
        kongPending: this.kongPending,
        furiten: this.furiten,
        ready: this.ready,
        wallStartFront: this.wallStartFront,
        wallStartBack: this.wallStartBack,
        wallStart: this.wallStart,
        swapRound: this.swapRound,
        swapSel: this.swapSel || {},
        finishHandled: !!this._finishHandled,
      }));
    }

    static fromState(raw, opts = {}) {
      const state = JSON.parse(JSON.stringify(raw || null));
      if (!state || state.version !== 1 || !Array.isArray(state.wall) || state.wall.length !== 144 ||
          !Array.isArray(state.players) || state.players.length !== 4 ||
          !['act', 'claim', 'swap', 'over'].includes(state.phase)) {
        throw new Error('invalid saved game');
      }
      const game = Object.create(Game.prototype);
      game.rng = opts.rng || Math.random;
      game.onEvent = opts.onEvent || null;
      game.dealerIndex = state.dealerIndex;
      game.roundWind = state.roundWind;
      game.streak = state.streak;
      game.allowMultiHu = state.allowMultiHu !== false;
      game.swapMode = !!state.swapMode;
      game.deadWall = Number.isFinite(state.deadWall) ? state.deadWall : 16;
      game._aiLevel = state.aiLevel || 'normal';
      game.wall = state.wall;
      game.front = state.front;
      game.back = state.back;
      game.players = state.players;
      game.turn = state.turn;
      game.phase = state.phase;
      game.lastDiscard = state.lastDiscard || null;
      game.pendingClaims = state.pendingClaims || null;
      game.mustDiscardAfterClaim = !!state.mustDiscardAfterClaim;
      game.result = state.result || null;
      game.log = state.log || [];
      game.firstGoAround = !!state.firstGoAround;
      game.kongPending = !!state.kongPending;
      game.furiten = state.furiten || [false, false, false, false];
      game.ready = state.ready || [null, null, null, null];
      game.wallStartFront = state.wallStartFront;
      game.wallStartBack = state.wallStartBack;
      game.wallStart = state.wallStart;
      game.swapRound = state.swapRound;
      game.swapSel = state.swapSel || {};
      game._finishHandled = !!state.finishHandled;
      game.pendingAddKong = null;
      if (state.pendingAddKong) {
        const player = game.players[state.pendingAddKong.player];
        const meld = player && player.melds[state.pendingAddKong.meldIndex];
        if (!meld) throw new Error('invalid saved kong');
        game.pendingAddKong = { player: state.pendingAddKong.player, tile: state.pendingAddKong.tile, meld };
      }
      return game;
    }

    // snapshot for UI / networking (host-authoritative)
    snapshot() {
      return {
        phase: this.phase, turn: this.turn, dealerIndex: this.dealerIndex,
        swapRound: this.swapRound,
        roundWind: this.roundWind, wall: this.wallCount(),
        wallLive: this.liveWallCount(),   // 可摸張數(扣王牌16),UI 顯示用
        wallStart: this.wallStart,
        wallDrawnFront: Math.max(0, this.front - this.wallStartFront),
        wallDrawnBack: Math.max(0, (this.wall.length - 1 - this.back) - this.wallStartBack),
        lastDiscard: this.lastDiscard, result: this.result,
        players: this.players.map((p) => ({
          seat: p.seat, melds: p.melds, flowers: p.flowers,
          discards: p.discards, handCount: p.hand.length,
        })),
      };
    }
  }

  // 吃 combinations for `tile` using tiles in hand
  function chowOptions(hand, tile) {
    if (!MJ.isSuited(tile)) return [];
    const s = MJ.suitOf(tile), n = MJ.numOf(tile);
    const has = (k) => hand.includes(s + k);
    const out = [];
    if (n - 2 >= 1 && has(n - 1) && has(n - 2)) out.push([s + (n - 2), s + (n - 1), tile]);
    if (n - 1 >= 1 && n + 1 <= 9 && has(n - 1) && has(n + 1)) out.push([s + (n - 1), tile, s + (n + 1)]);
    if (n + 2 <= 9 && has(n + 1) && has(n + 2)) out.push([tile, s + (n + 1), s + (n + 2)]);
    return out;
  }

  const API = { Game, sortHand, chowOptions, NEXT };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.MJGame = API;
})(typeof window !== 'undefined' ? window : globalThis);

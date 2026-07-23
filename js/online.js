/* ============================================================
   Mahjong Arena — online room (房號連線).
   Host is authoritative: it owns the Game, runs AI for empty
   seats, collects remote actions, and pushes a per-seat VIEW to
   each guest. Guests are thin: render the view, send intents.
   ============================================================ */
(function () {
  'use strict';
  const { Game } = window.MJGame;
  const $ = (s) => document.querySelector(s);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const NAMES_AI = ['—', '阿明', '秀蓮', '土豆伯'];
  const CLAIM_TIMEOUT = 9000;   // auto-pass a slow human claimer
  const ACT_TIMEOUT = 20000;    // remote fallback prevents a disconnected seat freezing the hand
  const SWAP_TIMEOUT = 15000;
  const savedOnline = window.MJSession && window.MJSession.load();

  let mode = null;              // 'host' | 'guest'
  let G = null;
  let scores = [0, 0, 0, 0], dealerIndex = 0, streak = 0, roundWind = 'z1';
  let sessionStats = [0, 1, 2, 3].map(() => ({ hu: 0, tsumo: 0, dealIn: 0 }));
  let dealerPasses = 0;   // 換莊次數;滿 4 = 打完一圈
  const aiDelay = 1250;   // slower pace — let voices finish before next discard

  // host: seat roster
  let seats = [];               // [{seat,name,cid,ai,connected}]
  let started = false;
  let claimTimer = null;

  // guest
  let mySeat = null, myName = '';
  let joinStatus = null, joinTimer = null;   // 'connecting' | 'seated' | 'failed'
  let joinFailureReason = '', joinRejected = false, rejoinTimer = null, rejoinGeneration = 0, lastGuestView = null;
  let restoringSession = false, guestOnlineReady = false;
  let playerToken = savedOnline && savedOnline.kind === 'online' && savedOnline.playerToken
    ? savedOnline.playerToken
    : (window.MJSession ? window.MJSession.token() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  const cfg = () => window.MJSolo.cfg;
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

  function saveOnlineSession() {
    if (!mode || !window.MJSession || !window.MJNet.code) return;
    window.MJSession.save({
      kind: 'online', role: mode, room: window.MJNet.code, playerToken,
      mySeat, myName, started, inTable: !!($('#app') && $('#app').classList.contains('on')),
      cfg: Object.assign({}, cfg()), lastView: mode === 'guest' ? clone(lastGuestView) : null,
      scores: scores.slice(), dealerIndex, streak, roundWind, dealerPasses,
      sessionStats: clone(sessionStats), seats: mode === 'host' ? clone(seats) : null,
      game: mode === 'host' && G ? G.exportState() : null,
    });
  }

  function leaveOnline() {
    clearTimeout(joinTimer); clearTimeout(rejoinTimer); clearTimeout(claimTimer);
    if (window.MJLeaveGame) window.MJLeaveGame();
    else {
      if (window.MJSession) { window.MJSession.clear(); window.MJSession.setScene('lobby'); }
      window.MJNet.leave(); location.reload();
    }
  }

  function startGameAudio() {
    MJSound.bgmStop();
    if (window.__lobbyFX) window.__lobbyFX.stop();
    const mb = $('#btnMusic');
    if (!mb || mb.dataset.on !== '0') MJSound.bgmStart('game');
  }

  // ============================================================
  //  ROOM (waiting) overlay
  // ============================================================
  function roomOverlay() {
    let o = $('#room');
    if (!o) {
      o = el('div', 'room-overlay'); o.id = 'room';
      document.body.appendChild(o);
    }
    o.style.display = 'flex';
    return o;
  }
  function hideRoom() { const o = $('#room'); if (o) o.style.display = 'none'; }
  function enterTable() {
    hideRoom();
    $('#lobby').style.display = 'none';
    $('#app').classList.add('on');
    if (window.MJSession) window.MJSession.setScene('game');
    window.MJView.prepareTableLayout();
    $('#btnAuto').style.display = 'none';
  }

  function renderRoom() {
    const o = roomOverlay(); o.innerHTML = '';
    const card = el('div', 'lobby-card room-card');
    card.appendChild(el('h1', 'neon room-title', '房號'));
    const codeBox = el('div', 'room-code');
    codeBox.textContent = window.MJNet.code; card.appendChild(codeBox);
    if (mode === 'host') {
      const cp = el('div', 'hint room-copy', window.MJNet.usingSupabase ? '把房號給朋友,他們輸入就能入座' : '本機測試模式(多分頁):同房號開分頁即可');
      card.appendChild(cp);
      const c = cfg();
      const set = el('div', 'hint room-summary', `${c.rule === 'swap' ? '換三張' : '十六張'} · ${c.len === 'game' ? '一將' : '一圈'} · 底注 ${c.stake}`);
      card.appendChild(set);
    }
    // roster
    const list = el('div', 'room-roster');
    const roster = (mode === 'host') ? seats : (window._guestRoster || []);
    [0, 1, 2, 3].forEach((i) => {
      const s = roster[i] || {};
      const row = el('div', 'room-seat');
      const wind = window.MJView.WIND[window.MJ.SEAT_WIND[i]];
      const badge = el('div', 'room-wind', wind);
      row.appendChild(badge);
      const nm = el('div', 'room-name' + (s.name ? '' : ' empty'), s.name || '（空位 → 電腦補位）');
      if (i === 0) nm.textContent = (s.name || '房主') + (mode === 'host' ? '(你)' : '');
      row.appendChild(nm);
      if (mySeat === i && mode === 'guest') row.appendChild(el('div', 'room-you', '你'));
      list.appendChild(row);
    });
    card.appendChild(list);

    if (mode === 'host') {
      const start = el('button', 'btn room-start', '開始牌局(空位由電腦補位)');
      start.addEventListener('click', hostStartGame);
      card.appendChild(start);
    } else {
      if (mySeat != null) {
        card.appendChild(el('div', 'hint room-state', '已入座,等待房主開始…'));
      } else if (joinStatus === 'failed') {
        const w = el('div', 'hint room-state error', joinFailureReason || ('暫時找不到房主(房號 ' + window.MJNet.code + ')，系統仍會自動重試。請確認:①房號輸入正確 ②房主已按「建立房間」並停留在房間畫面 ③雙方網路正常。'));
        card.appendChild(w);
        const retry = el('button', 'btn room-start', '重新嘗試加入');
        retry.addEventListener('click', () => { joinRejected = false; joinFailureReason = ''; joinStatus = 'connecting'; renderRoom(); startJoinHandshake(); });
        card.appendChild(retry);
      } else {
        card.appendChild(el('div', 'hint room-state', '連線中… 正在尋找房主(房號 ' + window.MJNet.code + ')'));
      }
    }
    const leave = el('button', 'btn ghost room-leave', '離開房間');
    leave.addEventListener('click', leaveOnline);
    card.appendChild(leave);
    o.appendChild(card);
    saveOnlineSession();
  }

  // ============================================================
  //  VIEW builder (host)
  // ============================================================
  function nameOf(p) { const s = seats[p]; return (s && s.name) || NAMES_AI[p] || ('玩家' + p); }
  function isAI(p) { return !!(seats[p] && seats[p].ai); }
  function cidOf(p) { return seats[p] && seats[p].cid; }
  function seatOfCid(cid) { return seats.findIndex((s) => s && s.cid === cid); }
  function seatOfToken(token) { return token ? seats.findIndex((s) => s && s.token === token) : -1; }

  function buildView(forSeat) {
    const snap = G.snapshot();
    const v = {
      mySeat: forSeat, phase: G.phase, turn: G.turn, dealerIndex: snap.dealerIndex,
      roundWind, wall: snap.wall, streak, lastDiscard: snap.lastDiscard,
      wallStart: snap.wallStart,
      wallDrawnFront: snap.wallDrawnFront,
      wallDrawnBack: snap.wallDrawnBack,
      furiten: G.furiten[forSeat],
      players: [0, 1, 2, 3].map((p) => ({
        seat: p, name: nameOf(p), ai: isAI(p), score: scores[p],
        handCount: G.players[p].hand.length, melds: G.players[p].melds, flowers: G.players[p].flowers,
        discards: G.players[p].discards,
      })),
      myHand: G.players[forSeat].hand.slice(),
      myActions: (G.phase === 'act' && G.turn === forSeat) ? G.actActions(forSeat) : null,
      myDrawn: (G.phase === 'act' && G.turn === forSeat) ? G.players[forSeat]._drawn : null,
      myClaims: (G.phase === 'claim' && G.pendingClaims && G.pendingClaims.options[forSeat] &&
        !G.pendingClaims.declared[forSeat]) ? G.pendingClaims.options[forSeat] : null,
      claimSubmitted: !!(G.phase === 'claim' && G.pendingClaims && G.pendingClaims.declared[forSeat]),
      claimTile: (G.phase === 'claim' && G.pendingClaims) ? G.pendingClaims.tile : null,
      waits: (function () {
        if (G.phase !== 'act' || G.turn !== forSeat) return null;
        const pl = G.players[forSeat]; const w = new Set();
        for (const t of new Set(pl.hand)) { const rest = pl.hand.slice(); rest.splice(rest.indexOf(t), 1); window.MJ.winningTiles(rest, pl.melds).forEach((x) => w.add(x)); }
        return w.size ? [...w] : null;
      })(),
      swap: (G.phase === 'swap') ? { round: G.swapRound, done: G.swapReady(forSeat) } : null,
    };
    if (G.phase === 'over') {
      v.result = G.result;
      v.nicks = window.MJView.nicknames(sessionStats, scores, [0, 1, 2, 3].map(nameOf));
      v.review = [0, 1, 2, 3].map((p) => ({ name: nameOf(p), hand: G.players[p].hand.slice(), melds: G.players[p].melds, flowers: G.players[p].flowers }));
      const target = cfg().len === 'game' ? 16 : 4;
      v.roundOver = dealerPasses >= target;
      v.progress = (cfg().len === 'game' ? '一將 · ' : '一圈 · ') + `${window.MJView.WIND[roundWind]}風圈 · 莊家 ${Math.min(dealerPasses, target)}/${target}`;
      if (v.roundOver) v.ranking = [0, 1, 2, 3].map((p) => ({ name: nameOf(p), score: scores[p] })).sort((a, b) => b.score - a.score);
    }
    return v;
  }
  function aiPickSwap(p) {
    const hand = G.players[p].hand.slice();
    return hand.map((t) => ({ t, v: window.MJAI.tileValue(hand, t) }))
      .sort((a, b) => a.v - b.v).slice(0, 3).map((x) => x.t);
  }

  function pushViews() {
    // host renders its own seat
    window.MJView.renderView(buildView(0), hostHandlers);
    // send each connected guest their personalised view
    for (let p = 1; p <= 3; p++) {
      if (cidOf(p)) window.MJNet.to(cidOf(p), G.phase === 'over' ? 'result' : 'view', buildView(p));
    }
    saveOnlineSession();
  }

  // ============================================================
  //  HOST driving
  // ============================================================
  const hostHandlers = {
    onAct(action) { applyActFor(0, action); },
    onClaim(action) { declareFor(0, action); },
    onSwap(tiles) { swapFor(0, tiles); },
  };

  function hostStartGame() {
    if (started) return;
    started = true;
    for (let p = 1; p <= 3; p++) if (!seats[p] || !seats[p].cid) seats[p] = { seat: p, ai: true, name: NAMES_AI[p] + ' 🤖' };
    // tell guests we begin
    window.MJNet.send('begin', { roster: seats.map((s) => ({ seat: s.seat, name: s.name, ai: !!s.ai })) });
    startGameAudio();
    enterTable();
    scores = [0, 0, 0, 0]; dealerIndex = 0; streak = 0; roundWind = 'z1'; dealerPasses = 0;
    sessionStats = [0, 1, 2, 3].map(() => ({ hu: 0, tsumo: 0, dealIn: 0 }));
    saveOnlineSession();
    window.MJNet.send('dice', { name: nameOf(dealerIndex) });   // ⑧ 擲骰決莊(客人同步)
    window.MJView.rollDealer(nameOf(dealerIndex), hostStartHand);
  }

  function hostStartHand() {
    window.MJView.clearSelection(); window.MJView.hideResult();
    roundWind = (cfg().len === 'game') ? window.MJ.SEAT_WIND[Math.min(3, Math.floor(dealerPasses / 4))] : 'z1';
    G = new Game({ dealerIndex, roundWind, streak, aiLevel: cfg().lvl, swapMode: cfg().rule === 'swap', allowMultiHu: true, onEvent: hostEvent });
    window.MJView.rollDice();
    window.MJNet.send('flash', { fx: 'deal' });
    MJSound.fx('deal');
    saveOnlineSession();
    setTimeout(hostAdvance, 480);
  }

  function hostEvent(type, p) {
    if (type === 'discard') {
      const nm = window.MJ.tileName(p.tile);
      MJSound.tile(p.tile, nm);
      window.MJNet.send('flash', { fx: 'discard', tile: p.tile, tileName: nm });
      return;
    }
    let text = null, voice = null, fx = null;
    if (type === 'pung') { text = nameOf(p.player) + ' 碰!'; fx = 'pung'; voice = 'pung'; }
    else if (type === 'kong') { text = nameOf(p.player) + ' 槓!'; fx = 'kong'; voice = 'kong'; }
    else if (type === 'chow') { text = nameOf(p.player) + ' 吃'; fx = 'chow'; voice = 'chow'; }
    else if (type === 'swap') { text = '換牌 · 第' + p.round + '輪'; fx = 'chow'; }
    else if (type === 'ready') { text = nameOf(p.player) + (p.kind === 'tian' ? ' 天聽!' : ' 地聽!'); fx = 'tick'; }
    else if (type === 'win') { fx = 'hu'; voice = p.selfDraw ? 'tsumo' : 'hu'; }
    if (text) window.MJView.toast(text);
    if (fx) MJSound.fx(fx); if (voice) MJSound.voice(voice);
    window.MJNet.send('flash', { text, fx, voice });
  }

  function hostAdvance() {
    clearTimeout(claimTimer);
    if (!G) return;
    if (G.phase === 'over') return hostFinish();
    pushViews();
    if (G.phase === 'swap') return hostSwap();
    if (G.phase === 'act') {
      const seat = G.turn;
      if (isAI(seat)) setTimeout(() => hostAI(seat), aiDelay);
      else if (seat !== 0) {
        claimTimer = setTimeout(() => {
          if (!G || G.phase !== 'act' || G.turn !== seat) return;
          try {
            const action = window.MJAI.act(G, seat);
            if (action.type === 'discard') MJSound.fx('discard');
            G.applyAct(seat, action);
          } catch (e) { return; }
          hostAdvance();
        }, ACT_TIMEOUT);
      }
      // The local host has no forced timer; remote seats fall back to AI.
    } else if (G.phase === 'claim') hostClaims();
  }

  function hostSwap() {
    // AI seats commit their 3 worst tiles immediately
    for (let p = 0; p < 4; p++) if (isAI(p) && !G.swapReady(p)) G.selectSwap(p, aiPickSwap(p));
    if (G.phase !== 'swap') { setTimeout(hostAdvance, 300); return; }
    pushViews();
    clearTimeout(claimTimer);
    claimTimer = setTimeout(() => {         // auto-pick for anyone too slow
      if (!G || G.phase !== 'swap') return;
      const before = G.swapRound;
      for (let p = 0; p < 4; p++) if (!G.swapReady(p)) G.selectSwap(p, aiPickSwap(p));
      if (G.phase !== 'swap' || G.swapRound !== before) hostAdvance();
    }, SWAP_TIMEOUT);
  }

  function swapFor(seat, tiles) {
    if (!G || G.phase !== 'swap' || G.swapReady(seat)) return;
    const before = G.swapRound;
    G.selectSwap(seat, tiles);
    clearTimeout(claimTimer);
    if (G.phase !== 'swap' || G.swapRound !== before) hostAdvance();  // round resolved → drive on
    else hostSwap();                                                  // still collecting → re-arm timeout
  }

  function hostAI(seat) {
    if (!G || G.phase !== 'act' || G.turn !== seat || !isAI(seat)) return;
    const a = window.MJAI.act(G, seat);
    if (a.type === 'discard') MJSound.fx('discard');
    G.applyAct(seat, a); hostAdvance();
  }

  function applyActFor(seat, action) {
    if (!G || G.phase !== 'act' || G.turn !== seat) return;
    try {
      if (action.type === 'discard') MJSound.fx('discard');
      if (action.type === 'ankong' || action.type === 'addkong') MJSound.fx('kong');
      G.applyAct(seat, action);
      hostAdvance();
    } catch (e) { /* illegal/stale intent — ignore */ }
  }

  function hostClaims() {
    const pc = G.pendingClaims; const elig = Object.keys(pc.options).map(Number);
    // AI declare immediately
    elig.filter((p) => isAI(p)).forEach((p) => { if (G.phase === 'claim') G.declareClaim(p, window.MJAI.claim(G, p)); });
    if (G.phase !== 'claim') { setTimeout(hostAdvance, aiDelay * 0.5); return; }
    // humans (local + remote) — push views so they see buttons, arm auto-pass
    pushViews();
    clearTimeout(claimTimer);
    claimTimer = setTimeout(() => {
      if (!G || G.phase !== 'claim') return;
      const pendingSeats = Object.keys(G.pendingClaims.options).map(Number);
      for (const p of pendingSeats) {
        if (!G || G.phase !== 'claim' || !G.pendingClaims) break;
        if (!G.pendingClaims.declared[p]) G.declareClaim(p, { type: 'pass' });
      }
      if (G.phase !== 'claim') hostAdvance();
    }, CLAIM_TIMEOUT);
  }

  function declareFor(seat, action) {
    if (!G || G.phase !== 'claim' || !G.pendingClaims.options[seat]) return;
    try {
      G.declareClaim(seat, action);
    } catch (e) {
      pushViews();
      return;
    }
    if (G.phase !== 'claim') { clearTimeout(claimTimer); hostAdvance(); }
    else pushViews();
  }

  function showHostResult(playAnimation) {
    const r = G.result;
    const target = cfg().len === 'game' ? 16 : 4;
    const cont = dealerPasses >= target ? hostNewRound : hostStartHand;
    const show = () => window.MJView.showResult(buildView(0), cont, true);
    if (playAnimation && r.type === 'win') window.MJView.playWinAnim(r.selfDraw ? 'tsumo' : 'hu', show);
    else show();
  }

  function hostFinish() {
    if (!G || !G.result) return;
    clearTimeout(claimTimer);
    window.MJView.clearSelection();
    const r = G.result;
    if (G._finishHandled) {
      saveOnlineSession();
      for (let p = 1; p <= 3; p++) if (cidOf(p)) window.MJNet.to(cidOf(p), 'result', buildView(p));
      showHostResult(false);
      return;
    }
    G._finishHandled = true;
    if (r.type === 'draw') { MJSound.fx('lose'); MJSound.voice('draw'); window.MJNet.send('flash', { text: '流局', fx: 'lose', voice: 'draw' }); streak++; }
    else {
      const [sb, st] = (cfg().stake || '30/10').split('/').map(Number); let dealerKept = false;
      r.winners.forEach((w) => {
        const pay = sb + w.tai * st;   // 底 + 台數×台
        if (r.selfDraw) { for (const q of [0, 1, 2, 3]) if (q !== w.player) { scores[q] -= pay; scores[w.player] += pay; } }
        else { scores[r.loser] -= pay; scores[w.player] += pay; }
        if (w.player === dealerIndex) dealerKept = true;
        sessionStats[w.player].hu++; if (r.selfDraw) sessionStats[w.player].tsumo++;
      });
      if (!r.selfDraw && r.loser != null) sessionStats[r.loser].dealIn++;
      MJSound.fx('win');
      const wp = G.players[r.winners[0].player];
      r.winHand = { melds: wp.melds, hand: wp.hand.slice() };
      if (dealerKept) streak++; else { dealerIndex = (dealerIndex + 1) & 3; streak = 0; dealerPasses++; }
    }
    saveOnlineSession();
    // push final views (with updated scores) to guests + show locally
    for (let p = 1; p <= 3; p++) if (cidOf(p)) window.MJNet.to(cidOf(p), 'result', buildView(p));
    showHostResult(true);
  }
  function hostNewRound() {
    scores = [0, 0, 0, 0]; dealerIndex = 0; streak = 0; dealerPasses = 0;
    sessionStats = [0, 1, 2, 3].map(() => ({ hu: 0, tsumo: 0, dealIn: 0 }));
    G = null;
    saveOnlineSession();
    window.MJNet.send('dice', { name: nameOf(dealerIndex) });
    window.MJView.rollDealer(nameOf(dealerIndex), hostStartHand);
  }

  // ---------- host message handler --------------------------
  function hostOnMsg(type, payload, from) {
    if (type === 'join') {
      payload = payload || {};
      const token = String(payload.token || '');
      let seat = seatOfToken(token);
      if (seat === 0) seat = -1;
      if (seat < 0) seat = seatOfCid(from);
      if (started && seat < 0) { window.MJNet.to(from, 'full', {}); return; }
      if (seat < 0) { for (let i = 1; i <= 3; i++) { if (!seats[i] || (!seats[i].cid && !seats[i].ai)) { seat = i; break; } } }
      if (seat < 0) { window.MJNet.to(from, 'full', {}); return; }
      const previous = seats[seat] || {};
      seats[seat] = {
        seat, cid: from, token: token || previous.token,
        name: payload.name || previous.name || ('玩家' + seat), ai: false,
      };
      saveOnlineSession();
      window.MJNet.to(from, 'welcome', { seat, roster: rosterMsg() });
      window.MJNet.send('roster', { roster: rosterMsg() });
      if (G) window.MJNet.to(from, G.phase === 'over' ? 'result' : 'view', buildView(seat));
      else if (started) window.MJNet.to(from, 'begin', { roster: rosterMsg() });
      else renderRoom();
    } else if (type === 'act') {
      const seat = seatOfCid(from); if (seat > 0) applyActFor(seat, payload.action);
    } else if (type === 'claim') {
      const seat = seatOfCid(from); if (seat > 0) declareFor(seat, payload.action);
    } else if (type === 'swap') {
      const seat = seatOfCid(from); if (seat > 0) swapFor(seat, payload.tiles);
    } else if (type === 'emote') {
      onEmote(payload);
    } else if (type === 'rejoin') {
      // a guest reconnected mid-game → resend their current view
      payload = payload || {};
      let seat = seatOfToken(payload.token);
      if (seat === 0) seat = -1;
      if (seat < 0) seat = seatOfCid(from);
      if (seat > 0) {
        seats[seat].cid = from;
        if (payload.token) seats[seat].token = payload.token;
        if (payload.name) seats[seat].name = payload.name;
        seats[seat].ai = false;
        saveOnlineSession();
        window.MJNet.to(from, 'welcome', { seat, roster: rosterMsg() });
        if (G) window.MJNet.to(from, G.phase === 'over' ? 'result' : 'view', buildView(seat));
        else if (started) window.MJNet.to(from, 'begin', { roster: rosterMsg() });
      } else if (!started) window.MJNet.to(from, 'host-rejoin', {});
      else window.MJNet.to(from, 'full', {});
    }
  }
  function rosterMsg() { return [0, 1, 2, 3].map((i) => { const s = seats[i]; return s ? { seat: i, name: s.name, ai: !!s.ai } : { seat: i }; }); }

  // ============================================================
  //  GUEST
  // ============================================================
  async function sendGuestIntent(type, payload) {
    if (!guestOnlineReady) {
      window.MJView.toast('正在恢復連線，請稍候');
      startRejoinHandshake();
      return;
    }
    guestOnlineReady = false;
    disableBar();
    const sent = await window.MJNet.send(type, payload);
    if (sent) return;
    if (lastGuestView) {
      const stale = clone(lastGuestView); stale.mySeat = mySeat;
      window.MJView.renderView(stale, guestHandlers);
      disableBar();
    }
    window.MJView.toast('連線中斷，正在回到牌局');
    startRejoinHandshake();
  }

  const guestHandlers = {
    onAct(action) { sendGuestIntent('act', { action }); },
    onClaim(action) { sendGuestIntent('claim', { action }); },
    onSwap(tiles) { sendGuestIntent('swap', { tiles }); },
  };
  function disableBar() { [...document.querySelectorAll('#actions .act-btn')].forEach((b) => b.disabled = true); }

  function stopRejoinHandshake() {
    rejoinGeneration++;
    clearTimeout(rejoinTimer); rejoinTimer = null;
    restoringSession = false;
  }

  function acceptGuestView(payload, isResult) {
    stopRejoinHandshake();
    joinStatus = 'seated'; guestOnlineReady = true;
    lastGuestView = clone(payload);
    if (!$('#app').classList.contains('on')) { startGameAudio(); enterTable(); }
    const v = clone(payload); v.mySeat = mySeat;
    if (!isResult) {
      window.MJView.hideResult();
      window.MJView.renderView(v, guestHandlers);
    } else {
      window.MJView.renderView(v, guestHandlers);
      if (v.result && v.result.type === 'win') window.MJView.playWinAnim(v.result.selfDraw ? 'tsumo' : 'hu', () => window.MJView.showResult(v, null, false));
      else if (v.result) window.MJView.showResult(v, null, false);
    }
    saveOnlineSession();
  }

  // ⑩ 線上喊話:廣播 {seat,text},各端依自己座位換算位置顯示
  function selfSeat() { return mode === 'host' ? 0 : (mySeat == null ? 0 : mySeat); }
  function onlineEmote(text) { window.MJNet.send('emote', { seat: selfSeat(), text }); window.MJView.showBubble(0, text); }
  function onEmote(payload) { window.MJView.showBubble(((payload.seat - selfSeat()) + 4) & 3, payload.text); }

  function guestOnMsg(type, payload) {
    if (type === 'welcome') {
      mySeat = payload.seat; joinStatus = 'seated'; joinFailureReason = '';
      clearTimeout(joinTimer);
      window._guestRoster = payload.roster;
      if (!$('#app').classList.contains('on')) { stopRejoinHandshake(); renderRoom(); }
      else saveOnlineSession();
    }
    else if (type === 'roster') {
      window._guestRoster = payload.roster;
      if (!$('#app').classList.contains('on')) renderRoom();
      else saveOnlineSession();
    }
    else if (type === 'full') {
      clearTimeout(joinTimer); stopRejoinHandshake(); guestOnlineReady = false;
      joinStatus = 'failed'; joinRejected = true;
      joinFailureReason = '這個房間已滿，或房主已開打且無法驗證你的原座位。';
      if ($('#app').classList.contains('on')) window.MJView.toast('無法恢復原座位，請離開後重新加入');
      else renderRoom();
    }
    else if (type === 'begin') { startGameAudio(); enterTable(); guestOnlineReady = false; saveOnlineSession(); }
    else if (type === 'view') acceptGuestView(payload, false);
    else if (type === 'result') acceptGuestView(payload, true);
    else if (type === 'flash') {
      if (payload.text) window.MJView.toast(payload.text);
      if (payload.fx) MJSound.fx(payload.fx);
      if (payload.voice) MJSound.voice(payload.voice);
      if (payload.tile) MJSound.tile(payload.tile, payload.tileName);
    }
    else if (type === 'host-rejoin') {
      if (mySeat == null) {
        joinStatus = 'connecting'; renderRoom(); startJoinHandshake();
      } else startRejoinHandshake();
    }
    else if (type === 'emote') { onEmote(payload); }
    else if (type === 'dice') { window.MJView.rollDealer(payload.name, () => {}); }
  }

  // ============================================================
  //  Lobby buttons
  // ============================================================
  const myNick = () => (($('#nameInput') && $('#nameInput').value) || '').trim();
  const codeInput = $('#codeInput');
  function cleanRoomCode() {
    const code = window.MJNet.normalizeRoomCode(codeInput.value).slice(0, 6);
    if (codeInput.value !== code) codeInput.value = code;
    return code;
  }
  codeInput.addEventListener('input', cleanRoomCode);
  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); $('#btnJoin').click(); }
  });
  $('#btnCreate').addEventListener('click', async () => {
    MJSound.unlock(); mode = 'host';
    seats = [{ seat: 0, cid: window.MJNet.clientId, token: playerToken, name: myNick() || '房主', ai: false }];
    try {
      await window.MJNet.create(hostOnMsg);
      window.__onlineEmote = onlineEmote;
      $('#pillCode').textContent = '房號 ' + window.MJNet.code; $('#pillCode').style.display = '';
      renderRoom();
    } catch (e) {
      window.MJNet.leave(); mode = null;
      alert('開房失敗:' + (e.message || e) + '\n可先用單機,或連線稍後再試。');
    }
  });

  // 持續向房主敲門,直到入座或逾時(涵蓋房主稍晚上線/行動網路較慢的時序)
  function startJoinHandshake() {
    clearTimeout(joinTimer);
    let tries = 0;
    (function ask() {
      if (joinRejected) return;
      if (mySeat != null) { joinStatus = 'seated'; return; }   // welcome 已到
      if (tries >= 30) {
        if (joinStatus !== 'failed') { joinStatus = 'failed'; renderRoom(); }
        window.MJNet.send('join', { name: myName, token: playerToken });
        joinTimer = setTimeout(ask, 3000);
        return;
      }
      window.MJNet.send('join', { name: myName, token: playerToken });
      tries++;
      joinTimer = setTimeout(ask, 800);
    })();
  }

  function startRejoinHandshake() {
    clearTimeout(rejoinTimer);
    const generation = ++rejoinGeneration;
    let tries = 0;
    guestOnlineReady = false;
    disableBar();
    (async function ask() {
      if (generation !== rejoinGeneration || mode !== 'guest' || !window.MJNet.code) return;
      if (document.hidden) {
        rejoinTimer = setTimeout(ask, 2500);
        return;
      }
      await window.MJNet.send('rejoin', { token: playerToken, name: myName });
      if (generation !== rejoinGeneration) return;
      tries++;
      rejoinTimer = setTimeout(ask, tries < 12 ? 800 : 3000);
    })();
  }

  $('#btnJoin').addEventListener('click', async () => {
    const code = cleanRoomCode();
    if (code.length !== 6) { alert('請輸入完整的 6 碼房號'); codeInput.focus(); return; }
    codeInput.blur();
    MJSound.unlock(); mode = 'guest'; mySeat = null; myName = myNick() || '玩家';
    guestOnlineReady = false; joinRejected = false; joinFailureReason = '';
    const jb = $('#btnJoin'); jb.disabled = true; jb.textContent = '連線中…';
    try {
      await window.MJNet.join(code, guestOnMsg);
      window.__onlineEmote = onlineEmote;
      $('#pillCode').textContent = '房號 ' + code; $('#pillCode').style.display = '';
      joinStatus = 'connecting';
      renderRoom();
      startJoinHandshake();
    } catch (e) {
      alert('連線失敗:' + (e.message || e) + '\n請確認網路後再試,或先玩單機。');
    } finally { jb.disabled = false; jb.textContent = '加入'; }
  });

  function restoreOnlineMeta(saved) {
    Object.assign(cfg(), saved.cfg || {});
    scores = Array.isArray(saved.scores) && saved.scores.length === 4 ? saved.scores.slice() : [0, 0, 0, 0];
    dealerIndex = Number.isInteger(saved.dealerIndex) ? saved.dealerIndex : 0;
    streak = Number.isFinite(saved.streak) ? saved.streak : 0;
    roundWind = saved.roundWind || 'z1';
    dealerPasses = Number.isFinite(saved.dealerPasses) ? saved.dealerPasses : 0;
    sessionStats = Array.isArray(saved.sessionStats) && saved.sessionStats.length === 4
      ? clone(saved.sessionStats)
      : [0, 1, 2, 3].map(() => ({ hu: 0, tsumo: 0, dealIn: 0 }));
  }

  function showCachedGuestView(view) {
    if (!view) return;
    lastGuestView = clone(view);
    const v = clone(view); v.mySeat = mySeat;
    window.MJView.renderView(v, guestHandlers);
    if (v.result) window.MJView.showResult(v, null, false);
    guestOnlineReady = false;
    disableBar();
  }

  async function restoreOnlineSession(saved) {
    if (!saved || saved.kind !== 'online' || !['host', 'guest'].includes(saved.role) || !saved.room) return;
    restoringSession = true;
    mode = saved.role;
    playerToken = saved.playerToken || playerToken;
    mySeat = Number.isInteger(saved.mySeat) ? saved.mySeat : null;
    myName = saved.myName || (mode === 'host' ? '房主' : '玩家');
    started = !!saved.started;
    restoreOnlineMeta(saved);

    const connecting = window.MJNet.restore(saved.room, mode, mode === 'host' ? hostOnMsg : guestOnMsg);
    $('#pillCode').textContent = '房號 ' + window.MJNet.code;
    $('#pillCode').style.display = '';
    window.__onlineEmote = onlineEmote;

    if (mode === 'host') {
      seats = Array.isArray(saved.seats) ? clone(saved.seats) : [];
      const host = seats[0] || {};
      seats[0] = Object.assign({}, host, {
        seat: 0, cid: window.MJNet.clientId, token: playerToken,
        name: host.name || myName || '房主', ai: false,
      });
      if (saved.game) G = Game.fromState(saved.game, { onEvent: hostEvent });
      if (G || saved.inTable || started) {
        startGameAudio(); enterTable();
        if (G) window.MJView.renderView(buildView(0), hostHandlers);
      } else renderRoom();
    } else {
      lastGuestView = clone(saved.lastView);
      if (saved.inTable) {
        startGameAudio(); enterTable(); showCachedGuestView(lastGuestView);
      } else {
        joinStatus = mySeat == null ? 'connecting' : 'seated';
        renderRoom();
      }
    }

    let connected = false;
    try {
      await connecting;
      connected = true;
    } catch (e) {
      if ($('#app').classList.contains('on')) window.MJView.toast('網路恢復中，牌局已保留');
      else {
        joinStatus = 'failed';
        joinFailureReason = '目前無法連上房間，系統會在網路恢復後繼續嘗試。';
        renderRoom();
      }
    }

    if (mode === 'host') {
      restoringSession = false;
      saveOnlineSession();
      if (connected) window.MJNet.send('host-rejoin', { token: playerToken });
      if (G) hostAdvance();
      else if (started) hostStartHand();
    } else if (mySeat == null) {
      joinStatus = 'connecting'; startJoinHandshake();
    } else startRejoinHandshake();
  }

  if (savedOnline && savedOnline.kind === 'online') {
    restoreOnlineSession(savedOnline).catch(() => {
      if (window.MJSession) { window.MJSession.clear(); window.MJSession.setScene('lobby'); }
      window.MJNet.leave(); location.reload();
    });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        saveOnlineSession();
        clearTimeout(rejoinTimer);
      } else if (mode === 'guest' && mySeat != null) startRejoinHandshake();
    });
  }
  if (window.addEventListener) {
    window.addEventListener('pagehide', saveOnlineSession);
    window.addEventListener('pageshow', () => { if (mode === 'guest' && mySeat != null) startRejoinHandshake(); });
    window.addEventListener('online', () => { if (mode === 'guest' && mySeat != null) startRejoinHandshake(); });
  }
})();

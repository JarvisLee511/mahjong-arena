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

  const cfg = () => window.MJSolo.cfg;

  // ============================================================
  //  ROOM (waiting) overlay
  // ============================================================
  function roomOverlay() {
    let o = $('#room');
    if (!o) {
      o = el('div', ''); o.id = 'room';
      o.style.cssText = 'position:fixed;inset:0;z-index:150;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(70% 60% at 50% 30%,rgba(255,45,85,.10),transparent 60%),#0B0E14';
      document.body.appendChild(o);
    }
    o.style.display = 'flex';
    return o;
  }
  function hideRoom() { const o = $('#room'); if (o) o.style.display = 'none'; }

  function renderRoom() {
    const o = roomOverlay(); o.innerHTML = '';
    const card = el('div', 'lobby-card'); card.style.gap = '16px';
    card.appendChild(Object.assign(el('h1', 'neon', '房號'), { style: 'font-size:26px;text-align:center' }));
    const codeBox = el('div', ''); codeBox.style.cssText = 'text-align:center;font-size:44px;font-weight:900;letter-spacing:.25em;color:#FFD24C;text-shadow:0 0 16px rgba(255,210,76,.6)';
    codeBox.textContent = window.MJNet.code; card.appendChild(codeBox);
    if (mode === 'host') {
      const cp = el('div', 'hint', window.MJNet.usingSupabase ? '把房號給朋友,他們輸入就能入座' : '本機測試模式(多分頁):同房號開分頁即可');
      card.appendChild(cp);
      const c = cfg();
      const set = el('div', 'hint', `${c.rule === 'swap' ? '換三張' : '十六張'} · ${c.len === 'game' ? '一將' : '一圈'} · 底注 ${c.stake}`);
      set.style.color = 'var(--gold)'; card.appendChild(set);
    }
    // roster
    const list = el('div', ''); list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    const roster = (mode === 'host') ? seats : (window._guestRoster || []);
    [0, 1, 2, 3].forEach((i) => {
      const s = roster[i] || {};
      const row = el('div', ''); row.style.cssText = 'display:flex;align-items:center;gap:10px;background:#0c0f16;border:1px solid #2a3140;border-radius:12px;padding:10px 14px';
      const wind = window.MJView.WIND[window.MJ.SEAT_WIND[i]];
      const badge = el('div', '', wind); badge.style.cssText = 'width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:#000;color:#FFD24C;border:1.5px solid #FFD24C;font-weight:900';
      row.appendChild(badge);
      const nm = el('div', '', s.name || '（空位 → 電腦補位）');
      nm.style.cssText = 'flex:1;font-weight:800;color:' + (s.name ? '#fff' : '#7f8c96');
      if (i === 0) nm.textContent = (s.name || '房主') + (mode === 'host' ? '(你)' : '');
      row.appendChild(nm);
      if (mySeat === i && mode === 'guest') { const you = el('div', '', '你'); you.style.cssText = 'color:#00E5D0;font-weight:800'; row.appendChild(you); }
      list.appendChild(row);
    });
    card.appendChild(list);

    if (mode === 'host') {
      const start = el('button', 'btn', '開始牌局(空位由電腦補位)');
      start.addEventListener('click', hostStartGame);
      card.appendChild(start);
    } else {
      if (mySeat != null) {
        card.appendChild(el('div', 'hint', '✅ 已入座,等待房主開始…'));
      } else if (joinStatus === 'failed') {
        const w = el('div', 'hint', '❌ 找不到房主(房號 ' + window.MJNet.code + ')。請確認:①房號輸入正確 ②房主已按「建立房間」並停留在房間畫面 ③雙方網路正常。');
        w.style.color = '#ff6b6b'; card.appendChild(w);
        const retry = el('button', 'btn', '重新嘗試加入');
        retry.addEventListener('click', () => { joinStatus = 'connecting'; renderRoom(); startJoinHandshake(); });
        card.appendChild(retry);
      } else {
        card.appendChild(el('div', 'hint', '🔗 連線中… 正在尋找房主(房號 ' + window.MJNet.code + ')'));
      }
    }
    const leave = el('button', 'btn ghost', '離開房間');
    leave.addEventListener('click', () => location.reload());
    card.appendChild(leave);
    o.appendChild(card);
  }

  // ============================================================
  //  VIEW builder (host)
  // ============================================================
  function nameOf(p) { const s = seats[p]; return (s && s.name) || NAMES_AI[p] || ('玩家' + p); }
  function isAI(p) { return !!(seats[p] && seats[p].ai); }
  function cidOf(p) { return seats[p] && seats[p].cid; }
  function seatOfCid(cid) { return seats.findIndex((s) => s && s.cid === cid); }

  function buildView(forSeat) {
    const snap = G.snapshot();
    const v = {
      mySeat: forSeat, phase: G.phase, turn: G.turn, dealerIndex: snap.dealerIndex,
      roundWind, wall: snap.wall, streak, lastDiscard: snap.lastDiscard,
      players: [0, 1, 2, 3].map((p) => ({
        seat: p, name: nameOf(p), ai: isAI(p), score: scores[p],
        handCount: G.players[p].hand.length, melds: G.players[p].melds, flowers: G.players[p].flowers,
        discards: G.players[p].discards,
      })),
      myHand: G.players[forSeat].hand.slice(),
      myActions: (G.phase === 'act' && G.turn === forSeat) ? G.actActions(forSeat) : null,
      myDrawn: (G.phase === 'act' && G.turn === forSeat) ? G.players[forSeat]._drawn : null,
      myClaims: (G.phase === 'claim' && G.pendingClaims && G.pendingClaims.options[forSeat]) || null,
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
    started = true;
    for (let p = 1; p <= 3; p++) if (!seats[p] || !seats[p].cid) seats[p] = { seat: p, ai: true, name: NAMES_AI[p] + ' 🤖' };
    // tell guests we begin
    window.MJNet.send('begin', { roster: seats.map((s) => ({ seat: s.seat, name: s.name, ai: !!s.ai })) });
    MJSound.bgmStop(); if (window.__lobbyFX) window.__lobbyFX.stop();
    const mb = $('#btnMusic'); if (!mb || mb.dataset.on !== '0') MJSound.bgmStart('game');
    hideRoom();
    $('#lobby').style.display = 'none'; $('#app').classList.add('on');
    scores = [0, 0, 0, 0]; dealerIndex = 0; streak = 0; roundWind = 'z1'; dealerPasses = 0;
    sessionStats = [0, 1, 2, 3].map(() => ({ hu: 0, tsumo: 0, dealIn: 0 }));
    window.MJNet.send('dice', { name: nameOf(dealerIndex) });   // ⑧ 擲骰決莊(客人同步)
    window.MJView.rollDealer(nameOf(dealerIndex), hostStartHand);
  }

  function hostStartHand() {
    window.MJView.clearSelection(); window.MJView.hideResult();
    roundWind = (cfg().len === 'game') ? window.MJ.SEAT_WIND[Math.min(3, Math.floor(dealerPasses / 4))] : 'z1';
    G = new Game({ dealerIndex, roundWind, streak, aiLevel: cfg().lvl, swapMode: cfg().rule === 'swap', allowMultiHu: cfg().multi !== 'single', onEvent: hostEvent });
    window.MJView.rollDice();
    window.MJNet.send('flash', { fx: 'deal' });
    MJSound.fx('deal');
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
    pushViews();
    if (!G) return;
    if (G.phase === 'over') return hostFinish();
    if (G.phase === 'swap') return hostSwap();
    if (G.phase === 'act') {
      const seat = G.turn;
      if (isAI(seat)) setTimeout(() => hostAI(seat), aiDelay);
      // else wait: local host (seat 0) uses buttons; remote guest sends 'act'
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
    }, 15000);
  }

  function swapFor(seat, tiles) {
    if (!G || G.phase !== 'swap' || G.swapReady(seat)) return;
    const before = G.swapRound;
    G.selectSwap(seat, tiles);
    clearTimeout(claimTimer);
    if (G.phase !== 'swap' || G.swapRound !== before) hostAdvance();  // round resolved → drive on
    else pushViews();                                                // still collecting
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
      Object.keys(G.pendingClaims.options).map(Number).forEach((p) => {
        if (!G.pendingClaims.declared[p]) G.declareClaim(p, { type: 'pass' });
      });
      if (G.phase !== 'claim') hostAdvance();
    }, CLAIM_TIMEOUT);
  }

  function declareFor(seat, action) {
    if (!G || G.phase !== 'claim' || !G.pendingClaims.options[seat]) return;
    G.declareClaim(seat, action);
    if (G.phase !== 'claim') { clearTimeout(claimTimer); hostAdvance(); }
    else pushViews();
  }

  function hostFinish() {
    window.MJView.clearSelection();
    const r = G.result;
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
    const target = cfg().len === 'game' ? 16 : 4;
    const cont = dealerPasses >= target ? hostNewRound : hostStartHand;   // 打完賽制 → 開新賽
    // push final views (with updated scores) to guests + show locally
    for (let p = 1; p <= 3; p++) if (cidOf(p)) window.MJNet.to(cidOf(p), 'result', buildView(p));
    if (r.type === 'win') window.MJView.playWinAnim(r.selfDraw ? 'tsumo' : 'hu', () => window.MJView.showResult(buildView(0), cont, true));
    else window.MJView.showResult(buildView(0), cont, true);
  }
  function hostNewRound() {
    scores = [0, 0, 0, 0]; dealerIndex = 0; streak = 0; dealerPasses = 0;
    sessionStats = [0, 1, 2, 3].map(() => ({ hu: 0, tsumo: 0, dealIn: 0 }));
    window.MJNet.send('dice', { name: nameOf(dealerIndex) });
    window.MJView.rollDealer(nameOf(dealerIndex), hostStartHand);
  }

  // ---------- host message handler --------------------------
  function hostOnMsg(type, payload, from) {
    if (type === 'join') {
      if (started) { window.MJNet.to(from, 'full', {}); return; }
      // reconnect: if this cid already holds a seat, just re-welcome it
      let seat = seatOfCid(from);
      if (seat < 0) { for (let i = 1; i <= 3; i++) { if (!seats[i] || (!seats[i].cid && !seats[i].ai)) { seat = i; break; } } }
      if (seat < 0) { window.MJNet.to(from, 'full', {}); return; }
      seats[seat] = { seat, cid: from, name: payload.name || ('玩家' + seat), ai: false };
      window.MJNet.to(from, 'welcome', { seat, roster: rosterMsg() });
      window.MJNet.send('roster', { roster: rosterMsg() });
      renderRoom();
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
      const seat = seatOfCid(from);
      if (seat > 0 && G) window.MJNet.to(from, G.phase === 'over' ? 'result' : 'view', buildView(seat));
    }
  }
  function rosterMsg() { return [0, 1, 2, 3].map((i) => { const s = seats[i]; return s ? { seat: i, name: s.name, ai: !!s.ai } : { seat: i }; }); }

  // ============================================================
  //  GUEST
  // ============================================================
  const guestHandlers = {
    onAct(action) { window.MJNet.send('act', { action }); disableBar(); },
    onClaim(action) { window.MJNet.send('claim', { action }); disableBar(); },
    onSwap(tiles) { window.MJNet.send('swap', { tiles }); disableBar(); },
  };
  function disableBar() { [...document.querySelectorAll('#actions .act-btn')].forEach((b) => b.disabled = true); }

  // ⑩ 線上喊話:廣播 {seat,text},各端依自己座位換算位置顯示
  function selfSeat() { return mode === 'host' ? 0 : (mySeat == null ? 0 : mySeat); }
  function onlineEmote(text) { window.MJNet.send('emote', { seat: selfSeat(), text }); window.MJView.showBubble(0, text); }
  function onEmote(payload) { window.MJView.showBubble(((payload.seat - selfSeat()) + 4) & 3, payload.text); }

  function guestOnMsg(type, payload) {
    if (type === 'welcome') { mySeat = payload.seat; joinStatus = 'seated'; clearTimeout(joinTimer); window._guestRoster = payload.roster; renderRoom(); }
    else if (type === 'roster') { window._guestRoster = payload.roster; renderRoom(); }
    else if (type === 'full') { alert('房間已滿或已開打 🙇'); location.reload(); }
    else if (type === 'begin') { MJSound.bgmStop(); if (window.__lobbyFX) window.__lobbyFX.stop(); const mb = $('#btnMusic'); if (!mb || mb.dataset.on !== '0') MJSound.bgmStart('game'); hideRoom(); $('#lobby').style.display = 'none'; $('#app').classList.add('on'); }
    else if (type === 'view') {
      const v = payload; v.mySeat = mySeat;
      window.MJView.hideResult();
      window.MJView.renderView(v, guestHandlers);
    }
    else if (type === 'result') {
      const v = payload; v.mySeat = mySeat; window.MJView.renderView(v, guestHandlers);
      if (v.result && v.result.type === 'win') window.MJView.playWinAnim(v.result.selfDraw ? 'tsumo' : 'hu', () => window.MJView.showResult(v, null, false));
      else if (v.result) window.MJView.showResult(v, null, false);
    }
    else if (type === 'flash') {
      if (payload.text) window.MJView.toast(payload.text);
      if (payload.fx) MJSound.fx(payload.fx);
      if (payload.voice) MJSound.voice(payload.voice);
      if (payload.tile) MJSound.tile(payload.tile, payload.tileName);
    }
    else if (type === 'emote') { onEmote(payload); }
    else if (type === 'dice') { window.MJView.rollDealer(payload.name, () => {}); }
  }

  // ============================================================
  //  Lobby buttons
  // ============================================================
  const myNick = () => (($('#nameInput') && $('#nameInput').value) || '').trim();
  $('#btnCreate').addEventListener('click', async () => {
    MJSound.unlock(); mode = 'host';
    seats = [{ seat: 0, cid: window.MJNet.clientId, name: myNick() || '房主', ai: false }];
    try {
      await window.MJNet.create(hostOnMsg);
      window.__onlineEmote = onlineEmote;
      $('#pillCode').textContent = '房號 ' + window.MJNet.code; $('#pillCode').style.display = '';
      renderRoom();
    } catch (e) { alert('開房失敗:' + (e.message || e) + '\n可先用單機,或連線稍後再試。'); }
  });

  // 持續向房主敲門,直到入座或逾時(涵蓋房主稍晚上線/行動網路較慢的時序)
  function startJoinHandshake() {
    clearTimeout(joinTimer);
    let tries = 0;
    (function ask() {
      if (mySeat != null) { joinStatus = 'seated'; return; }   // welcome 已到
      if (tries >= 30) { joinStatus = 'failed'; renderRoom(); return; }   // ~30 × 800ms ≈ 24 秒
      window.MJNet.send('join', { name: myName });
      tries++;
      joinTimer = setTimeout(ask, 800);
    })();
  }

  $('#btnJoin').addEventListener('click', async () => {
    const code = ($('#codeInput').value || '').toUpperCase().trim();
    if (code.length < 4) { alert('請輸入房號'); return; }
    MJSound.unlock(); mode = 'guest'; myName = myNick() || '玩家';
    const jb = $('#btnJoin'); jb.disabled = true;
    try {
      await window.MJNet.join(code, guestOnMsg);
      window.__onlineEmote = onlineEmote;
      $('#pillCode').textContent = '房號 ' + code; $('#pillCode').style.display = '';
      joinStatus = 'connecting';
      renderRoom();
      startJoinHandshake();
    } catch (e) {
      alert('連線失敗:' + (e.message || e) + '\n請確認網路後再試,或先玩單機。');
    } finally { jb.disabled = false; }
  });
})();

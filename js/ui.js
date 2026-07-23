/* ============================================================
   Mahjong Arena — shared renderer + single-player controller.
   The renderer draws a seat-relative VIEW (my seat always at the
   bottom), so solo / host / guest all reuse it. Online controller
   (online.js) feeds views built from the authoritative host game.
   ============================================================ */
(function () {
  'use strict';
  const { Game } = window.MJGame;
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  const WIND = { z1: '東', z2: '南', z3: '西', z4: '北' };
  const SEAT_EL = { 1: 'seatRight', 2: 'seatTop', 3: 'seatLeft' };  // by screen position
  const DIR = { 0: 'bottom-seat', 1: 'right-seat', 2: 'top-seat', 3: 'left-seat' };

  // ---------- tile elements ---------------------------------
  function tileEl(t, extraCls) {
    const d = el('div', 'tile ' + t[0] + (extraCls ? ' ' + extraCls : ''));
    d.innerHTML = window.MJArt.face(t);
    d.dataset.tile = t;
    return d;
  }
  function backEl() { return el('div', 'tb'); }
  function meldGroup(m) {
    const g = el('div', 'meld-group');
    m.tiles.forEach((t) => g.appendChild(tileEl(t, 'meld-tile')));   // 全部同方向
    return g;
  }

  // ============================================================
  //  RENDERER — draws a view. handlers: { onAct(action), onClaim(action) }
  // ============================================================
  let selected = null;
  let swapSel = new Set();
  let swapViewKey = null;
  let lastPondView = null;

  function renderView(v, handlers) {
    handlers = handlers || {};
    lastPondView = v;
    const nextSwapKey = v.phase === 'swap' && v.swap ? `${v.mySeat}:${v.swap.round}` : null;
    if (nextSwapKey !== swapViewKey) swapSel.clear();
    swapViewKey = nextSwapKey;
    if (v.phase === 'swap') {
      $('#wallCount').innerHTML = '換三張<small> 美麻</small>';
      $('#roundWind').textContent = `第 ${v.swap ? v.swap.round : 1} / 2 輪 · 各選 3 張傳下家`;
    } else {
      $('#wallCount').innerHTML = v.wall + '<small> 張</small>';
      $('#roundWind').textContent = WIND[v.roundWind] + '風圈' + (v.streak ? ` · 連${v.streak}` : '');
    }
    renderWalls(v);

    // 自家狀態:風位 + 分數 + 莊/連莊
    const si = $('#selfInfo');
    if (si) {
      const meWind = window.MJ.SEAT_WIND[((v.mySeat - v.dealerIndex) + 4) & 3];
      const me = v.players[v.mySeat];
      si.textContent = `${WIND[meWind]}位 ${me.score >= 0 ? '+' : ''}${me.score}` +
        (v.mySeat === v.dealerIndex ? (' · 莊' + (v.streak ? '連' + v.streak : '')) : '');
    }

    for (const p of [0, 1, 2, 3]) {
      const pos = (p - v.mySeat + 4) & 3;
      if (pos === 0) renderSelf(v, handlers);
      else renderOpp(v, p, pos);
    }
    renderPond(v);
    renderActions(v, handlers);
    document.querySelector('.table').classList.toggle('has-actions', $('#actions').childElementCount > 0);
    renderTenpai(v);
    renderSelfBar(v);
    requestAnimationFrame(fitTableGeometry);
  }

  // #5 聽牌提示列:顯示「聽」+ 聽的牌漂在旁邊
  function renderTenpai(v) {
    const bar = $('#tenpaiBar'); if (!bar) return;
    bar.innerHTML = '';
    const hasActionPrompt = $('#actions') && $('#actions').childElementCount > 0;
    const show = v.waits && v.waits.length && v.phase === 'act' && v.turn === v.mySeat;
    bar.classList.toggle('on', !!show);
    bar.classList.toggle('with-actions', !!show && hasActionPrompt);
    if (!show) return;
    bar.appendChild(el('span', 'tp-label', '聽'));
    v.waits.forEach((t) => {
      const mini = el('div', 'tile tp-tile'); mini.innerHTML = window.MJArt.face(t); bar.appendChild(mini);
    });
  }

  function renderOpp(v, p, pos) {
    const wrap = $('#' + SEAT_EL[pos]); wrap.innerHTML = '';
    const sp = v.players[p];
    const av = el('div', 'avatar' + (v.turn === p ? ' turn' : '') + (p === v.dealerIndex ? ' dealer' : ''));
    const face = el('div', 'face');
    face.style.backgroundImage = `url('assets/avatars/a${(p % 6) + 1}.svg?v=28')`;
    av.appendChild(face);
    const wind = window.MJ.SEAT_WIND[((p - v.dealerIndex) + 4) & 3];
    av.appendChild(el('div', 'wind', WIND[wind]));
    av.appendChild(el('div', 'nm', sp.name + (sp.ai ? ' · AI' : '')));
    const sc = el('div', 'sc' + (sp.score > 0 ? ' pos' : sp.score < 0 ? ' neg' : ''), (sp.score >= 0 ? '+' : '') + sp.score);
    av.appendChild(sc);
    if (p === v.dealerIndex && v.streak > 0) av.appendChild(el('div', 'streak', '連' + v.streak));
    wrap.appendChild(av);
    const backs = el('div', 'backs');
    backs.classList.toggle('short', sp.handCount <= 8);
    for (let i = 0; i < sp.handCount; i++) backs.appendChild(backEl());
    wrap.appendChild(backs);
    if (sp.melds && sp.melds.length) {
      const mm = el('div', 'opp-melds'); sp.melds.forEach((m) => mm.appendChild(meldGroup(m))); wrap.appendChild(mm);
    }
    // 補花:縮小成一小排放在旁邊(不擠壓牌背)
    if (sp.flowers && sp.flowers.length) {
      const fl = el('div', 'flowers opp-flowers'); sp.flowers.forEach((f) => fl.appendChild(tileEl(f))); wrap.appendChild(fl);
    }
  }

  // 明星3缺一式底部狀態列:風位莊 · 圈數 · 金幣(分數)
  function renderSelfBar(v) {
    const bar = $('#selfBar'); if (!bar) return;
    bar.innerHTML = '';
    const meWind = window.MJ.SEAT_WIND[((v.mySeat - v.dealerIndex) + 4) & 3];
    const me = v.players[v.mySeat];
    const dealer = v.mySeat === v.dealerIndex;
    bar.appendChild(el('span', 'sb-wind' + (dealer ? ' dealer' : ''), WIND[meWind] + (dealer ? ' 莊' : '')));
    const roundTxt = v.phase === 'swap' ? '換三張' : (WIND[v.roundWind] + '風圈' + (v.streak ? ' · 連' + v.streak : ''));
    bar.appendChild(el('span', 'sb-info', roundTxt));
    if (v.furiten) bar.appendChild(el('span', 'sb-status', '過水'));
    bar.appendChild(el('span', 'sb-coin', '籌碼 ' + (me.score >= 0 ? '+' : '') + me.score));
  }

  function renderSelf(v, handlers) {
    const me = v.players[v.mySeat];
    // Flowers stay on their own tray so they never shrink the playable hand.
    const flowers = $('#myFlowers'); flowers.innerHTML = '';
    (me.flowers || []).forEach((f) => flowers.appendChild(tileEl(f)));

    // exposed melds
    const mm = $('#myMelds'); mm.innerHTML = '';
    (me.melds || []).forEach((m) => mm.appendChild(meldGroup(m)));

    // hand — 16 sorted tiles butted together; the freshly-drawn tile is
    // held slightly apart on the right, just like real 摸牌.
    const hand = $('#myHand'); hand.innerHTML = '';
    const swapping = v.phase === 'swap' && v.swap && !v.swap.done;
    const interactive = v.phase === 'act' && v.turn === v.mySeat && v.myActions &&
      v.myActions.some((a) => a.type === 'discard');
    // #6 可吃碰的牌閃爍:算出參與吃/碰/槓的手牌
    const flashSet = new Set();
    if (v.myClaims && v.claimTile) {
      for (const o of v.myClaims) {
        if (o.type === 'pung' || o.type === 'kong') flashSet.add(v.claimTile);
        else if (o.type === 'chow') o.tiles.forEach((t) => { if (t !== v.claimTile) flashSet.add(t); });
      }
    }
    // #5 聽牌:整手發亮
    hand.classList.toggle('tenpai', !!(interactive && v.waits && v.waits.length));
    const list = (v.myHand || []).slice();
    let drawn = null;
    if (interactive && v.myDrawn) {
      const di = list.lastIndexOf(v.myDrawn);
      if (di >= 0) drawn = list.splice(di, 1)[0];
    }
    const addTile = (t, idx, isDrawn) => {
      const cls = [];
      const key = t + '#' + idx;                    // identify duplicate tiles by slot
      if (!swapping && selected === key) cls.push('sel');
      if (swapping && swapSel.has(key)) cls.push('sel');
      if (v.hint && v.hint.includes(t)) cls.push('hintable');
      if (flashSet.has(t)) cls.push('flash');
      if (isDrawn) { cls.push('drawn'); if (v.waits && v.waits.length && selected === null) cls.push('reveal'); }
      const e = tileEl(t, cls.join(' '));
      if (swapping) e.addEventListener('click', () => {
        if (swapSel.has(key)) swapSel.delete(key);
        else if (swapSel.size < 3) swapSel.add(key);
        renderView(v, handlers);   // refresh hand + the confirm button count
      });
      else if (interactive) e.addEventListener('click', () => {
        if (selected === key) { selected = null; handlers.onAct && handlers.onAct({ type: 'discard', tile: t }); }
        else { selected = key; renderSelf(v, handlers); }
      });
      hand.appendChild(e);
    };
    list.forEach((t, idx) => addTile(t, idx, false));
    if (drawn !== null) {
      addTile(drawn, 'd', true);
      if (v.waits && v.waits.length && selected === null) {   // ④ 聽牌摸牌:一隻手翻開
        const h = el('div', 'draw-hand', '✋'); hand.appendChild(h); setTimeout(() => h.remove(), 1000);
      }
    }
    fitPlayerRack();
  }

  function fitPlayerRack() {
    const rack = document.querySelector('.player-rack');
    if (!rack) return;
    rack.style.setProperty('--rack-scale', '1');
    const css = getComputedStyle(document.documentElement);
    const safeLeft = parseFloat(css.getPropertyValue('--safe-left')) || 0;
    const safeRight = parseFloat(css.getPropertyValue('--safe-right')) || 0;
    rack.style.setProperty('--rack-safe-shift', `${(safeLeft - safeRight) / 2}px`);
    const available = Math.max(1, window.innerWidth - safeLeft - safeRight - 10);
    const contentWidth = rack.scrollWidth;
    rack.style.setProperty('--rack-scale', Math.min(1, available / Math.max(1, contentWidth)).toFixed(4));
  }

  function fitTableGeometry() {
    const app = document.querySelector('#app');
    const center = document.querySelector('.center');
    const leftSeat = document.querySelector('.seat-left');
    const rightSeat = document.querySelector('.seat-right');
    const leftBacks = leftSeat && leftSeat.querySelector('.backs');
    const rightBacks = rightSeat && rightSeat.querySelector('.backs');
    if (!app || !center || !leftBacks || !rightBacks) return;

    const tableRect = center.getBoundingClientRect();
    if (!tableRect.width || !tableRect.height) return;
    const tableSlope = window.innerHeight < 300 ? 0.06 : (window.innerHeight <= 500 ? 0.12 : 0.22);
    const angle = Math.atan2(tableRect.width * tableSlope, tableRect.height) * 180 / Math.PI;
    app.style.setProperty('--table-side-angle', `${angle.toFixed(3)}deg`);
    app.style.setProperty('--table-side-angle-neg', `${(-angle).toFixed(3)}deg`);

    const positionBacks = (backs, seat, side) => {
      const seatRect = seat.getBoundingClientRect();
      const anchorY = seatRect.top + backs.offsetTop;
      const progress = Math.min(1, Math.max(0, (anchorY - tableRect.top) / tableRect.height));
      const inset = tableRect.width * tableSlope * (1 - progress);
      const edgeX = side === 'left' ? tableRect.left + inset : tableRect.right - inset;
      const railGap = Math.min(5, Math.max(2, backs.offsetWidth * 0.12));
      const targetX = edgeX + (side === 'left' ? -railGap : railGap);
      const offset = side === 'left' ? targetX - seatRect.left : seatRect.right - targetX;
      backs.style.setProperty('--side-hand-x', `${offset.toFixed(2)}px`);
    };

    positionBacks(leftBacks, leftSeat, 'left');
    positionBacks(rightBacks, rightSeat, 'right');

    const fitSideMelds = (seat) => {
      const melds = seat.querySelector('.opp-melds');
      const avatar = seat.querySelector('.avatar');
      if (!melds || !avatar) return;
      melds.style.setProperty('--opp-tile-scale', '.30');
      const seatRect = seat.getBoundingClientRect();
      const avatarRect = avatar.getBoundingClientRect();
      const available = Math.max(1, seatRect.bottom - avatarRect.bottom - 16);
      if (melds.offsetHeight > available) {
        const scale = Math.max(.18, .30 * available / melds.offsetHeight);
        melds.style.setProperty('--opp-tile-scale', scale.toFixed(4));
      }
    };

    fitSideMelds(leftSeat);
    fitSideMelds(rightSeat);

    const topSeat = document.querySelector('.seat-top');
    const topBacks = topSeat && topSeat.querySelector('.backs');
    if (!topSeat || !topBacks) return;
    const topSeatRect = topSeat.getBoundingClientRect();
    const topBacksRect = topBacks.getBoundingClientRect();
    const farRight = tableRect.right - tableRect.width * tableSlope;
    const edgeGap = 8;
    const rootStyle = getComputedStyle(document.documentElement);
    const safeLeft = parseFloat(rootStyle.getPropertyValue('--safe-left')) || 0;
    const safeRight = parseFloat(rootStyle.getPropertyValue('--safe-right')) || 0;
    const viewportLeft = safeLeft + 8;
    const viewportRight = window.innerWidth - safeRight - 8;
    const topMelds = topSeat.querySelector('.opp-melds');
    const topFlowers = topSeat.querySelector('.opp-flowers');

    if (topMelds) {
      topMelds.style.setProperty('--opp-tile-scale', '.30');
      const leftAvatarRect = leftSeat.querySelector('.avatar').getBoundingClientRect();
      const leftEdge = Math.max(viewportLeft, leftAvatarRect.right + edgeGap);
      const rightEdge = topBacksRect.left - edgeGap;
      const available = Math.max(1, rightEdge - leftEdge);
      if (topMelds.offsetWidth > available) {
        const scale = Math.max(.16, .30 * available / topMelds.offsetWidth);
        topMelds.style.setProperty('--opp-tile-scale', scale.toFixed(4));
      }
      const targetLeft = Math.max(leftEdge, rightEdge - topMelds.offsetWidth);
      topMelds.style.left = `${(targetLeft - topSeatRect.left).toFixed(2)}px`;
    }
    if (topFlowers) {
      const leftEdge = Math.max(farRight + edgeGap, topBacksRect.right + edgeGap);
      const targetLeft = Math.min(viewportRight - topFlowers.offsetWidth, leftEdge);
      topFlowers.style.right = 'auto';
      topFlowers.style.left = `${(targetLeft - topSeatRect.left).toFixed(2)}px`;
    }
  }

  let layoutFrame = 0;
  function refitTable() {
    if (window.MJLayout && window.MJLayout.fitTiles) window.MJLayout.fitTiles();
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      if (lastPondView) renderPond(lastPondView);
      fitPlayerRack();
      fitTableGeometry();
    });
  }

  function prepareTableLayout() {
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
    refitTable();
    setTimeout(refitTable, 320);
  }

  window.addEventListener('resize', refitTable);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', refitTable);

  function renderPond(v) {
    const pond = $('#pond'); pond.innerHTML = '';
    const compact = window.innerHeight < 300;
    const horizontalLimit = compact ? 12 : 20;
    const sideLimit = compact ? 6 : (window.innerWidth < 620 ? 10 : (window.innerWidth < 820 ? 15 : 20));
    for (const p of [0, 1, 2, 3]) {
      const pos = (p - v.mySeat + 4) & 3;
      const r = el('div', 'river ' + DIR[pos]);
      const allDiscards = v.players[p].discards || [];
      const visibleLimit = (pos === 1 || pos === 3) ? sideLimit : horizontalLimit;
      const hidden = allDiscards.length > visibleLimit ? allDiscards.length - visibleLimit + 1 : 0;
      const ds = hidden ? allDiscards.slice(-(visibleLimit - 1)) : allDiscards;
      const entries = hidden ? [{ hidden }, ...ds.map((tile) => ({ tile }))] : ds.map((tile) => ({ tile }));
      const per = (pos === 1 || pos === 3) ? (compact ? 6 : 5) : (compact ? 12 : 10);
      for (let i = 0; i < entries.length; i += per) {
        const row = el('div', 'river-row');
        entries.slice(i, i + per).forEach((entry, j) => {
          if (entry.hidden) {
            row.appendChild(el('div', 'river-history', '+' + entry.hidden));
            return;
          }
          const t = entry.tile;
          const idx = allDiscards.length - ds.length + i + j - (hidden ? 1 : 0);
          const isLast = v.lastDiscard && v.lastDiscard.from === p &&
            v.lastDiscard.tile === t && idx === allDiscards.length - 1;
          row.appendChild(tileEl(t, isLast ? 'last' : ''));
        });
        r.appendChild(row);
      }
      pond.appendChild(r);
    }
  }

  // Stable two-tile stacks make normal draws and replacement draws visibly
  // consume opposite ends of the wall without reflowing the table.
  function renderWalls(v) {
    const total = Math.max(0, Math.round(Number.isFinite(v.wallStart) ? v.wallStart : v.wall));
    const drawnFront = Math.max(0, Math.min(total, Math.round(v.wallDrawnFront || 0)));
    const drawnBack = Math.max(0, Math.min(total - drawnFront, Math.round(
      Number.isFinite(v.wallDrawnBack) ? v.wallDrawnBack : Math.max(0, total - drawnFront - v.wall)
    )));
    const liveStart = drawnFront;
    const liveEnd = total - drawnBack;
    const stackTotal = Math.ceil(total / 2);
    const base = Math.floor(stackTotal / 4);
    const extra = stackTotal % 4;
    const sides = ['wallB', 'wallR', 'wallT', 'wallL'];
    const capacities = sides.map((_, index) => base + (index < extra ? 1 : 0));
    let slotOffset = 0;

    sides.forEach((id, sideIndex) => {
      const box = document.getElementById(id); if (!box) return;
      const capacity = capacities[sideIndex];
      if (box.childElementCount !== capacity) {
        box.innerHTML = '';
        for (let i = 0; i < capacity; i++) {
          const stack = el('div', 'wall-stack');
          stack.setAttribute('aria-hidden', 'true');
          stack.appendChild(el('i', 'wall-layer lower'));
          stack.appendChild(el('i', 'wall-layer upper'));
          box.appendChild(stack);
        }
      }

      [...box.children].forEach((stack, localIndex) => {
        const globalIndex = slotOffset + localIndex;
        const tileStart = globalIndex * 2;
        const tileEnd = Math.min(total, tileStart + 2);
        let count = 0;
        for (let tileIndex = tileStart; tileIndex < tileEnd; tileIndex++) {
          if (tileIndex >= liveStart && tileIndex < liveEnd) count++;
        }
        let cls = count === 2 ? 'full' : (count === 1 ? 'single' : 'empty');
        if (count && liveStart >= tileStart && liveStart < tileEnd) cls += ' draw-front';
        if (count && liveEnd - 1 >= tileStart && liveEnd - 1 < tileEnd) cls += ' draw-back';
        stack.className = 'wall-stack ' + cls;
        stack.dataset.count = count;
      });
      box.classList.toggle('exhausted', ![...box.children].some((stack) => stack.dataset.count !== '0'));
      slotOffset += capacity;
    });
  }

  function renderActions(v, handlers) {
    const bar = $('#actions'); bar.innerHTML = '';
    const mk = (label, cls, fn, detail = '') => {
      const b = el('button', 'act-btn ' + cls);
      b.appendChild(el('span', 'act-label', label));
      if (detail) b.appendChild(el('small', 'act-detail', detail));
      b.title = detail ? `${label} ${detail}` : label;
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    const tName = window.MJ.tileName;
    const chowName = (tiles) => {
      const suit = tiles[0] && tiles[0][0];
      const suitName = { m: '萬', p: '筒', s: '條' }[suit];
      if (suitName && tiles.every((tile) => tile[0] === suit)) {
        return tiles.map((tile) => tile[1]).join('') + suitName;
      }
      return tiles.map(tName).join('');
    };

    if (v.phase === 'swap' && v.swap) {
      if (v.swap.done) { const b = el('button', 'act-btn pass', '已選好,等待其他家…'); b.disabled = true; bar.appendChild(b); return; }
      const n = swapSel.size;
      const label = n < 3 ? `換三張:再選 ${3 - n} 張 給下家` : '傳給下家 ▶';
      const b = el('button', 'act-btn swap-action ' + (n === 3 ? 'hu' : ''), label);
      b.disabled = n !== 3;
      b.addEventListener('click', () => {
        const tiles = [...swapSel].map((k) => k.slice(0, k.indexOf('#')));
        swapSel.clear();
        handlers.onSwap && handlers.onSwap(tiles);
      });
      bar.appendChild(b);
      return;
    }
    if (v.phase === 'act' && v.turn === v.mySeat && v.myActions) {
      const A = v.myActions;
      const ts = A.find((a) => a.type === 'tsumo');
      if (ts) mk('自摸', 'hu', () => handlers.onAct(ts));
      A.filter((a) => a.type === 'ankong').forEach((a) => mk('暗槓', '', () => handlers.onAct(a), tName(a.tile)));
      A.filter((a) => a.type === 'addkong').forEach((a) => mk('加槓', '', () => handlers.onAct(a), tName(a.tile)));
    } else if (v.phase === 'claim' && v.claimSubmitted) {
      const waiting = el('button', 'act-btn claim-wait', '已選擇，等待其他家');
      waiting.disabled = true;
      bar.appendChild(waiting);
    } else if (v.phase === 'claim' && v.myClaims && v.myClaims.length) {
      const C = v.myClaims;
      if (C.find((o) => o.type === 'hu')) mk('胡', 'hu', () => handlers.onClaim({ type: 'hu' }));
      if (C.find((o) => o.type === 'kong')) mk('槓', 'pon', () => handlers.onClaim({ type: 'kong' }));
      if (C.find((o) => o.type === 'pung')) mk('碰', 'pon', () => handlers.onClaim({ type: 'pung' }));
      C.filter((o) => o.type === 'chow').forEach((o) => mk('吃', '', () => handlers.onClaim(o), chowName(o.tiles)));
      mk('過', 'pass', () => handlers.onClaim({ type: 'pass' }));
    }
  }

  // ---------- flourishes ------------------------------------
  function toast(txt) { const t = el('div', 'toast', txt); $('#app').appendChild(t); setTimeout(() => t.remove(), 1200); }
  function rollDice() { const f = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅']; $('#dice').textContent = f[(Math.random() * 6) | 0] + f[(Math.random() * 6) | 0]; }
  function burst() {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    for (let i = 0; i < 70; i++) {
      const s = el('div', 'spark'); document.body.appendChild(s);
      const ang = Math.random() * Math.PI * 2, dist = 120 + Math.random() * 260;
      s.style.left = cx + 'px'; s.style.top = cy + 'px';
      s.style.background = Math.random() < 0.5 ? '#FFD24C' : '#FF2D55';
      s.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${Math.cos(ang) * dist}px,${Math.sin(ang) * dist}px) scale(0)`, opacity: 0 }],
        { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.15,.7,.3,1)' }).onfinish = () => s.remove();
    }
  }

  // 台味胡牌大動畫:紅金印章 + 光芒 + 金幣雨,結束後 callback
  function playWinAnim(kind, cb) {
    const table = document.querySelector('.table');
    if (table) { table.classList.add('shake'); setTimeout(() => table.classList.remove('shake'), 600); }
    const wrap = $('#winanim'); wrap.innerHTML = '';
    wrap.classList.add('on');
    wrap.appendChild(el('div', 'rays'));
    wrap.appendChild(el('div', 'flash'));
    const stamp = el('div', 'stamp');
    stamp.appendChild(el('div', 'big', kind === 'tsumo' ? '自摸' : '胡'));
    stamp.appendChild(el('div', 'sub', kind === 'tsumo' ? 'TSì-BÔ' : 'HÔ--AH'));
    wrap.appendChild(stamp);
    // gold coin / firecracker rain
    const glyphs = ['🪙', '🧧', '💰', '🀄'];
    for (let i = 0; i < 26; i++) {
      const c = el('div', 'coin', glyphs[(Math.random() * glyphs.length) | 0]);
      c.style.left = Math.random() * 100 + '%';
      const dur = 1000 + Math.random() * 900, delay = Math.random() * 400;
      wrap.appendChild(c);
      c.animate([
        { transform: `translateY(-10vh) rotate(0deg)`, opacity: 0 },
        { transform: `translateY(10vh) rotate(90deg)`, opacity: 1, offset: .15 },
        { transform: `translateY(115vh) rotate(${360 + Math.random() * 360}deg)`, opacity: 1 },
      ], { duration: dur, delay, easing: 'cubic-bezier(.3,.2,.5,1)' }).onfinish = () => c.remove();
    }
    burst();
    setTimeout(() => { wrap.classList.remove('on'); wrap.innerHTML = ''; cb && cb(); }, 1500);
  }

  function showResult(v, onAgain, canAgain) {
    const r = v.result; const card = $('#resultCard'); card.innerHTML = '';
    const body = el('div', 'rc-body');    // 可捲動內容
    const foot = el('div', 'rc-foot');    // 固定按鈕(永遠看得到)
    if (r.type === 'draw') {
      body.appendChild(el('h2', '', '流局'));
      body.appendChild(el('div', 'taitotal', '牌牆摸完,無人胡牌'));
    } else {
      const w0 = r.winners[0];
      const isMultiHu = !r.selfDraw && r.winners.length > 1;
      body.appendChild(el('h2', '', isMultiHu ? '一炮多響!' : (r.selfDraw ? '自摸!' : '胡牌!')));
      if (isMultiHu) {
        const list = el('div', 'multi-winners');
        r.winners.forEach((winner) => {
          const item = el('div', 'multi-winner');
          const title = el('div', 'multi-winner-title');
          title.append(document.createTextNode(v.players[winner.player].name + ' '), el('b', '', winner.tai), document.createTextNode(' 台'));
          item.appendChild(title);
          const bd = el('div', 'bd');
          (winner.breakdown || []).forEach((entry) => bd.appendChild(el('span', '', entry.name + ' ' + entry.tai)));
          item.appendChild(bd);
          list.appendChild(item);
        });
        body.appendChild(list);
      } else {
        const tt = el('div', 'taitotal');
        tt.append(document.createTextNode(v.players[w0.player].name + ' '), el('b', '', w0.tai), document.createTextNode(' 台'));
        body.appendChild(tt);
      }
      if (r.winHand && !isMultiHu) {
        const wh = el('div', 'winhand');
        let fi = 0;                                   // ③ 逐張翻開:遞增延遲
        const addFlip = (t, extra) => { const e = tileEl(t, (extra || '') + ' flip'); e.style.animationDelay = (fi++ * 70) + 'ms'; wh.appendChild(e); };
        (r.winHand.melds || []).forEach((m) => m.tiles.forEach((t) => addFlip(t)));
        (r.winHand.hand || []).forEach((t) => addFlip(t));
        if (!r.selfDraw) addFlip(r.winTile, 'last');
        body.appendChild(wh);
      }
      if (!isMultiHu) {
        const bd = el('div', 'bd'); w0.breakdown.forEach((b) => bd.appendChild(el('span', '', b.name + ' ' + b.tai))); body.appendChild(bd);
      }
    }
    const sb = el('div', 'taitotal'); sb.style.fontSize = '15px'; sb.style.color = '#cfe';
    sb.textContent = v.players.map((p) => `${p.name} ${p.score >= 0 ? '+' : ''}${p.score}`).join('   ');
    body.appendChild(sb);
    if (v.nicks && v.nicks.length) {                 // ⑪ 牌風綽號
      const nk = el('div', 'nicks');
      v.nicks.forEach((n) => {
        const line = el('div', 'nick');
        line.append(document.createTextNode(n.name + ' — '), el('b', '', n.tag));
        nk.appendChild(line);
      });
      body.appendChild(nk);
    }
    if (v.progress) { const pg = el('div', 'hint', v.progress); pg.style.marginTop = '4px'; body.appendChild(pg); }
    if (v.roundOver && v.ranking) {
      body.appendChild(Object.assign(el('h2', '', '🏆 賽局結束!'), { style: 'font-size:26px;margin-top:8px' }));
      const rk = el('div', 'nicks');
      const medal = ['🥇', '🥈', '🥉', '4️⃣'];
      v.ranking.forEach((p, i) => {
        const line = el('div', 'nick');
        line.append(document.createTextNode(`${medal[i]} ${p.name} — `), el('b', '', (p.score >= 0 ? '+' : '') + p.score));
        rk.appendChild(line);
      });
      body.appendChild(rk);
    }

    // 固定按鈕列:上訴/檢視 + 下一局/離開
    const row2 = el('div', 'row');
    const appeal = el('button', 'btn ghost', '😤 不服上訴'); appeal.addEventListener('click', appealGag); row2.appendChild(appeal);
    const review = el('button', 'btn ghost', '🔍 檢視這局'); review.addEventListener('click', () => renderReview(v, onAgain, canAgain)); row2.appendChild(review);
    foot.appendChild(row2);
    const row = el('div', 'row'); row.style.marginTop = '8px';
    if (canAgain) { const a = el('button', 'btn', v.roundOver ? '🀄 再來一場 ▶' : '下一局 ▶'); a.addEventListener('click', () => { $('#result').classList.remove('on'); onAgain && onAgain(); }); row.appendChild(a); }
    else { row.appendChild(Object.assign(el('div', 'hint', '等待房主開始下一局…'), { style: 'align-self:center' })); }
    const lv = el('button', 'btn ghost', '離開'); lv.addEventListener('click', () => location.reload()); row.appendChild(lv);
    foot.appendChild(row);

    card.append(body, foot);
    $('#result').classList.add('on');
  }

  // 😤 不服上訴 — 賭徒不服輸的娛樂梗:蓋「上訴駁回」印章
  function appealGag() {
    const ov = el('div', 'appeal-stamp', '上訴駁回'); $('#result').appendChild(ov);
    MJSound.fx('lose'); MJSound.say(['免談', '駁回', '認命吧', '不要吵'][(Math.random() * 4) | 0]);
    setTimeout(() => ov.remove(), 1500);
  }

  // 🔍 檢視這局 — 攤開四家最終手牌 / 副露 / 花,標示胡家與放槍
  function renderReview(v, onAgain, canAgain) {
    const card = $('#resultCard'); card.innerHTML = '';
    card.appendChild(Object.assign(el('h2', '', '檢視這局'), { style: 'font-size:26px' }));
    const r = v.result;
    (v.review || []).forEach((pl, p) => {
      const won = r.type === 'win' && r.winners.some((w) => w.player === p);
      const lost = r.type === 'win' && r.loser === p;
      const rw = el('div', 'rv-row');
      const nm = el('div', 'rv-name', pl.name + (won ? ' · 胡' : lost ? ' · 放槍' : ''));
      if (won) nm.classList.add('won'); if (lost) nm.classList.add('lost');
      rw.appendChild(nm);
      const ts = el('div', 'rv-tiles');
      (pl.melds || []).forEach((m) => m.tiles.forEach((t) => ts.appendChild(tileEl(t))));
      (pl.hand || []).forEach((t) => ts.appendChild(tileEl(t)));
      (pl.flowers || []).forEach((t) => { const e = tileEl(t); e.style.opacity = '.7'; ts.appendChild(e); });
      rw.appendChild(ts);
      card.appendChild(rw);
    });
    const back = el('button', 'btn', '返回結算'); back.style.marginTop = '12px';
    back.addEventListener('click', () => showResult(v, onAgain, canAgain));
    card.appendChild(back);
  }
  const hideResult = () => $('#result').classList.remove('on');

  function clearSelection() { selected = null; swapSel.clear(); }

  // ⑧ 擲骰決莊開場
  function rollDealer(name, cb) {
    const ov = $('#diceRoll'); if (!ov) { cb && cb(); return; }
    ov.classList.add('on');
    const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const a = $('#dieA'), b = $('#dieB'), say = $('#diceSay');
    say.textContent = '擲骰定莊…';
    let n = 0;
    const iv = setInterval(() => {
      a.textContent = faces[(Math.random() * 6) | 0]; b.textContent = faces[(Math.random() * 6) | 0];
      MJSound.fx('tick');
      if (++n > 14) {
        clearInterval(iv);
        const d1 = 1 + ((Math.random() * 6) | 0), d2 = 1 + ((Math.random() * 6) | 0);
        a.textContent = faces[d1 - 1]; b.textContent = faces[d2 - 1];
        say.innerHTML = '';
        say.append(document.createTextNode('擲出 '), el('b', '', d1 + d2), document.createTextNode(' 點 · 莊家 '), el('b', '', name));
        setTimeout(() => { ov.classList.remove('on'); cb && cb(); }, 1300);
      }
    }, 90);
  }

  // ⑩ 喊話泡泡(依螢幕座位定位)
  function bubblePos(pos) {
    if (pos === 0) return { left: '50%', bottom: '120px', transform: 'translateX(-50%)' };
    if (pos === 1) return { right: '92px', top: '40%' };
    if (pos === 2) return { left: '50%', top: '62px', transform: 'translateX(-50%)' };
    return { left: '92px', top: '40%' };
  }
  function showBubble(pos, text) {
    const bub = el('div', 'bubble', text);
    Object.assign(bub.style, bubblePos(pos));
    $('#app').appendChild(bub);
    setTimeout(() => bub.remove(), 2200);
  }

  // ⑪ 牌風綽號(依累積戰績)
  function nicknames(stats, scores, names) {
    const idxMax = (key) => { let bi = -1, bv = 0; stats.forEach((s, i) => { if (s[key] > bv) { bv = s[key]; bi = i; } }); return bi; };
    const dealer = idxMax('dealIn'), machine = idxMax('tsumo');
    let hi = 0, lo = 0; scores.forEach((s, i) => { if (s > scores[hi]) hi = i; if (s < scores[lo]) lo = i; });
    return names.map((nm, i) => {
      let tag = '穩健派';
      if (i === dealer) tag = '放槍大戶';
      else if (i === machine) tag = '自摸機器';
      else if (i === hi && scores[hi] > 0) tag = '好野人';
      else if (i === lo && scores[lo] < 0) tag = '苦命人';
      return { name: nm, tag };
    });
  }

  // expose renderer for online.js + solo
  window.MJView = { renderView, toast, rollDice, rollDealer, burst, playWinAnim, showResult, hideResult, clearSelection, showBubble, nicknames, tileEl, refitTable, prepareTableLayout, WIND };

  // ============================================================
  //  SINGLE-PLAYER CONTROLLER
  // ============================================================
  const NAMES = ['你', '阿明', '秀蓮', '土豆伯'];
  const TAUNTS = ['等你很久了', '快一點啦', '手氣真好齁', '穩住', '唉呦', '嘿嘿', '這張安啦'];
  let cfg = { rule: 'std', lvl: 'normal', len: 'round', stake: '30/10' };
  const roundTarget = () => (cfg.len === 'game' ? 16 : 4);   // 一將16莊 / 一圈4莊
  const stakeVals = () => { const [b, t] = (cfg.stake || '30/10').split('/').map(Number); return { base: b, tai: t }; };  // 底/台點數
  let G = null, scores = [0, 0, 0, 0], dealerIndex = 0, streak = 0, roundWind = 'z1', busy = false;
  let sessionStats = [0, 1, 2, 3].map(() => ({ hu: 0, tsumo: 0, dealIn: 0 }));
  let dealerPasses = 0;   // 莊家換過幾家;換滿 4 家 = 打完一圈
  let autopilot = false;  // 託管:電腦代打我的回合
  const aiDelay = 1250;   // 手動時的慢節奏(留給碰/槓/報牌語音講完)
  const curDelay = () => (autopilot ? 150 : aiDelay);   // 託管時大幅加速,快速跑完整圈/將

  function solto() { return cfg.rule; }

  function buildSoloView() {
    const snap = G.snapshot();
    const me = G.players[0];
    const v = {
      mySeat: 0, phase: G.phase, turn: G.turn, dealerIndex: snap.dealerIndex,
      roundWind, wall: snap.wall, streak,
      wallStart: snap.wallStart,
      wallDrawnFront: snap.wallDrawnFront,
      wallDrawnBack: snap.wallDrawnBack,
      furiten: G.furiten[0],
      lastDiscard: snap.lastDiscard,
      players: [0, 1, 2, 3].map((p) => ({
        seat: p, name: NAMES[p], ai: p !== 0, score: scores[p],
        handCount: G.players[p].hand.length, melds: G.players[p].melds, flowers: G.players[p].flowers,
        discards: G.players[p].discards,
      })),
      myHand: me.hand.slice(),
      myDrawn: (G.phase === 'act' && G.turn === 0) ? me._drawn : null,
      myActions: (G.phase === 'act' && G.turn === 0) ? G.actActions(0) : null,
      myClaims: (G.phase === 'claim' && G.pendingClaims && G.pendingClaims.options[0] && !G.pendingClaims.declared[0])
        ? G.pendingClaims.options[0] : null,
      claimTile: (G.phase === 'claim' && G.pendingClaims) ? G.pendingClaims.tile : null,
      swap: (G.phase === 'swap') ? { round: G.swapRound, done: G.swapReady(0) } : null,
      result: (G.phase === 'over') ? G.result : null,   // ← 結算卡需要這個(先前遺漏→結算崩潰卡死)
      waits: computeWaits(0),
      hint: soloHint,
      nicks: (G.phase === 'over') ? MJView.nicknames(sessionStats, scores, NAMES) : null,
      review: (G.phase === 'over') ? [0, 1, 2, 3].map((p) => ({
        name: NAMES[p], hand: G.players[p].hand.slice(), melds: G.players[p].melds, flowers: G.players[p].flowers,
      })) : null,
      roundOver: (G.phase === 'over') && dealerPasses >= roundTarget(),
      progress: (cfg.len === 'game' ? '一將 · ' : '一圈 · ') + `${WIND[roundWind]}風圈 · 莊家 ${Math.min(dealerPasses, roundTarget())}/${roundTarget()}`,
      ranking: (G.phase === 'over' && dealerPasses >= roundTarget())
        ? [0, 1, 2, 3].map((p) => ({ name: NAMES[p], score: scores[p] })).sort((a, b) => b.score - a.score) : null,
    };
    return v;
  }
  // 聽牌:輪到我出牌時,算出「打掉某張後聽哪些牌」的聯集(自動聽牌提示)
  function computeWaits(seat) {
    if (!G || G.phase !== 'act' || G.turn !== seat) return null;
    const pl = G.players[seat]; const w = new Set();
    for (const t of new Set(pl.hand)) {
      const rest = pl.hand.slice(); rest.splice(rest.indexOf(t), 1);
      window.MJ.winningTiles(rest, pl.melds).forEach((x) => w.add(x));
    }
    return w.size ? [...w] : null;
  }
  function aiPickSwap(p) {
    const hand = G.players[p].hand.slice();
    return hand.map((t) => ({ t, v: window.MJAI.tileValue(hand, t) }))
      .sort((a, b) => a.v - b.v).slice(0, 3).map((x) => x.t);
  }
  let soloHint = null;

  const soloHandlers = {
    onAct(action) {
      soloHint = null;
      if (action.type === 'discard') MJSound.fx('discard');
      if (action.type === 'ankong' || action.type === 'addkong') MJSound.fx('kong');
      G.applyAct(0, action); soloAdvance();
    },
    onClaim(action) {
      if (action.type === 'pung') MJSound.fx('pung');
      if (action.type === 'kong') MJSound.fx('kong');
      if (action.type === 'chow') MJSound.fx('chow');
      G.declareClaim(0, action); soloAdvance();
    },
    onSwap(tiles) {
      MJSound.fx('discard');
      G.selectSwap(0, tiles);
      for (const p of [1, 2, 3]) if (!G.swapReady(p)) G.selectSwap(p, aiPickSwap(p));
      soloAdvance();
    },
  };

  function soloRender() { if (G) MJView.renderView(buildSoloView(), soloHandlers); }

  function soloAdvance() {
    soloRender();
    if (!G) return;
    if (G.phase === 'over') return soloFinish();
    if (G.phase === 'swap') { busy = false; if (autopilot && !G.swapReady(0)) setTimeout(soloAutoStep, curDelay() * 0.5); return; }
    if (G.phase === 'act') {
      if (G.turn === 0) { busy = false; if (autopilot) setTimeout(soloAutoStep, curDelay() * 0.5); }
      else { busy = true; setTimeout(soloAI, curDelay()); }
    } else if (G.phase === 'claim') soloClaims();
  }
  // 託管:電腦代打人類(seat 0)的回合/吃碰/換牌(含自動胡)
  function soloAutoStep() {
    if (!autopilot || !G) return;
    if (G.phase === 'act' && G.turn === 0) soloHandlers.onAct(window.MJAI.act(G, 0));
    else if (G.phase === 'claim' && G.pendingClaims && G.pendingClaims.options[0]) {
      const hu = G.pendingClaims.options[0].find((o) => o.type === 'hu');
      soloHandlers.onClaim(hu || { type: 'pass' });
    } else if (G.phase === 'swap' && !G.swapReady(0)) soloHandlers.onSwap(aiPickSwap(0));
  }
  function soloAI() {
    if (!G || G.phase !== 'act' || G.turn === 0) return;
    const seat = G.turn;
    const a = window.MJAI.act(G, seat);
    if (a.type === 'discard') MJSound.fx('discard');
    G.applyAct(seat, a);
    if (a.type === 'discard' && Math.random() < 0.08) MJView.showBubble(seat, TAUNTS[(Math.random() * TAUNTS.length) | 0]);
    soloAdvance();
  }
  function soloClaims() {
    const pc = G.pendingClaims; const elig = Object.keys(pc.options).map(Number);
    elig.filter((p) => p !== 0).forEach((p) => { if (G.phase === 'claim') G.declareClaim(p, window.MJAI.claim(G, p)); });
    if (G.phase !== 'claim') { soloRender(); setTimeout(soloAdvance, curDelay() * 0.6); return; }
    if (elig.includes(0)) { busy = false; soloRender(); if (autopilot) setTimeout(soloAutoStep, curDelay() * 0.5); }
    else { soloRender(); setTimeout(soloAdvance, curDelay() * 0.6); }
  }
  function soloFinish() {
    MJView.clearSelection();
    const r = G.result;
    const finishUp = () => {
      const cont = (dealerPasses >= roundTarget()) ? newRound : startHand;   // 打完賽制 → 重開
      MJView.showResult(buildSoloView(), cont, true);
    };
    if (r.type === 'draw') { MJSound.fx('lose'); MJSound.voice('draw'); streak++; finishUp(); return; }  // 流局連莊
    const S = stakeVals(); let dealerKept = false;
    r.winners.forEach((w) => {
      const pay = S.base + w.tai * S.tai;   // 底 + 台數×台
      if (r.selfDraw) { for (const q of [0, 1, 2, 3]) if (q !== w.player) { scores[q] -= pay; scores[w.player] += pay; } }
      else { scores[r.loser] -= pay; scores[w.player] += pay; }
      if (w.player === dealerIndex) dealerKept = true;
      sessionStats[w.player].hu++; if (r.selfDraw) sessionStats[w.player].tsumo++;   // ⑪ 戰績
    });
    if (!r.selfDraw && r.loser != null) sessionStats[r.loser].dealIn++;
    MJSound.fx('win');
    const wp = G.players[r.winners[0].player];
    r.winHand = { melds: wp.melds, hand: wp.hand.slice() };
    if (dealerKept) streak++; else { dealerIndex = (dealerIndex + 1) & 3; streak = 0; dealerPasses++; }
    MJView.playWinAnim(r.selfDraw ? 'tsumo' : 'hu', finishUp);
  }

  // 開新的一圈:重置分數/莊家/戰績
  function newRound() {
    scores = [0, 0, 0, 0]; dealerIndex = 0; streak = 0; dealerPasses = 0;
    sessionStats = [0, 1, 2, 3].map(() => ({ hu: 0, tsumo: 0, dealIn: 0 }));
    MJView.rollDealer(NAMES[dealerIndex], startHand);
  }

  function onGameEvent(type, p) {
    if (type === 'discard') { MJSound.tile(p.tile, window.MJ.tileName(p.tile)); }
    else if (type === 'pung') { MJView.toast(NAMES[p.player] + ' 碰!'); MJSound.fx('pung'); MJSound.voice('pung'); }
    else if (type === 'kong') { MJView.toast(NAMES[p.player] + ' 槓!'); MJSound.fx('kong'); MJSound.voice('kong'); }
    else if (type === 'chow') { MJView.toast(NAMES[p.player] + ' 吃'); MJSound.fx('chow'); MJSound.voice('chow'); }
    else if (type === 'swap') { MJView.toast('換牌完成 · 第' + p.round + '輪'); MJSound.fx('chow'); }
    else if (type === 'ready') { MJView.toast((NAMES[p.player] || '') + (p.kind === 'tian' ? ' 天聽!' : ' 地聽!')); MJSound.fx('tick'); }
    else if (type === 'win') { MJSound.fx('hu'); MJSound.voice(p.selfDraw ? 'tsumo' : 'hu'); }
  }

  function startHand() {
    busy = false; soloHint = null; MJView.clearSelection();
    roundWind = (cfg.len === 'game') ? window.MJ.SEAT_WIND[Math.min(3, Math.floor(dealerPasses / 4))] : 'z1';  // 一將輪圈風
    G = new Game({ dealerIndex, roundWind, streak, aiLevel: cfg.lvl, swapMode: cfg.rule === 'swap', allowMultiHu: true, onEvent: onGameEvent });
    MJView.rollDice(); soloRender(); MJSound.fx('deal');
    setTimeout(soloAdvance, 480);
  }

  function startSolo() {
    scores = [0, 0, 0, 0]; dealerIndex = 0; streak = 0; roundWind = 'z1'; dealerPasses = 0;
    sessionStats = [0, 1, 2, 3].map(() => ({ hu: 0, tsumo: 0, dealIn: 0 }));
    MJSound.bgmStop(); if (window.__lobbyFX) window.__lobbyFX.stop();
    $('#lobby').style.display = 'none'; $('#app').classList.add('on');
    prepareTableLayout();
    const mb = $('#btnMusic'); if (!mb || mb.dataset.on !== '0') MJSound.bgmStart('game');   // 遊戲中中國風輕音樂
    MJView.rollDealer(NAMES[dealerIndex], startHand);   // ⑧ 擲骰決莊開場
  }

  // ---------- lobby wiring ----------------------------------
  function seg(id, key, prop) {
    $('#' + id).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      [...e.currentTarget.children].forEach((c) => c.classList.remove('on'));
      b.classList.add('on'); cfg[key] = b.dataset[prop];
    });
  }
  seg('ruleSeg', 'rule', 'rule'); seg('lvlSeg', 'lvl', 'lvl'); seg('lenSeg', 'len', 'len'); seg('stakeSeg', 'stake', 'stake');
  $('#btnJoinToggle').addEventListener('click', () => { const f = $('#joinField'); f.style.display = f.style.display === 'none' ? 'flex' : 'none'; });
  $('#btnSolo').addEventListener('click', () => { MJSound.unlock(); startSolo(); });
  $('#btnSound').addEventListener('click', (e) => { MJSound.enabled = !MJSound.enabled; e.currentTarget.textContent = MJSound.enabled ? '♪' : '×'; });
  // ⑥ 託管(自動摸打):開啟後你的回合由電腦代打(含自動胡),再按一下收回
  $('#btnAuto').addEventListener('click', (e) => {
    autopilot = !autopilot;
    e.currentTarget.textContent = autopilot ? 'Ⅱ' : '»';
    e.currentTarget.style.color = autopilot ? '#47d18a' : '';
    if (autopilot) { MJView.toast('託管中,電腦代打'); soloAutoStep(); }
  });
  $('#btnLeave').addEventListener('click', () => location.reload());

  // ⑩ 喊話 / 表情
  const EMOTES = ['碰!', '槓!', '胡啦!', '聽牌囉', '等你很久了', '快一點啦', '手氣真好齁', '再一盤!', '穩住', '唉呦', '😎', '😭', '🔥', '💰', '👏', '🀄'];
  (function buildEmotePanel() {
    const panel = $('#emotePanel'); if (!panel) return;
    EMOTES.forEach((t) => { const b = el('button', '', t); b.addEventListener('click', () => { panel.classList.remove('on'); sendEmote(t); }); panel.appendChild(b); });
  })();
  function sendEmote(text) {
    if (window.__onlineEmote) window.__onlineEmote(text);   // online.js 廣播 + 自家泡泡
    else MJView.showBubble(0, text);                        // 單機:自家泡泡
  }
  $('#btnEmote').addEventListener('click', (e) => { e.stopPropagation(); $('#emotePanel').classList.toggle('on'); });
  document.addEventListener('click', (e) => { const p = $('#emotePanel'); if (p && p.classList.contains('on') && !p.contains(e.target) && e.target.id !== 'btnEmote') p.classList.remove('on'); });

  // lobby background music: autoplay needs a gesture, so kick on first tap;
  // a 🎵 toggle lets the player mute it. Music stops once a game begins.
  let bgmKicked = false;
  document.addEventListener('pointerdown', () => {
    if (bgmKicked) return; bgmKicked = true;
    const b = $('#btnMusic');
    if (b && b.dataset.on !== '0') { MJSound.unlock(); MJSound.bgmStart(); }
  }, { once: true });
  const btnMusic = $('#btnMusic');
  if (btnMusic) btnMusic.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btnMusic.dataset.on === '0') { btnMusic.dataset.on = '1'; btnMusic.textContent = '♪'; MJSound.unlock(); MJSound.bgmStart(); }
    else { btnMusic.dataset.on = '0'; btnMusic.textContent = '×'; MJSound.bgmStop(); }
  });

  // ---------- lobby FX: falling gold coins (canvas) ----------
  function initLobbyFX() {
    const cv = document.getElementById('coinCanvas'); if (!cv) return null;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0, coins = [], raf = 0, running = true, tick = 0;
    function resize() { W = cv.width = cv.offsetWidth * dpr; H = cv.height = cv.offsetHeight * dpr; }
    resize(); window.addEventListener('resize', resize);
    function spawn(prefill) {
      const r = (7 + Math.random() * 11) * dpr;
      coins.push({ x: Math.random() * W, y: prefill ? Math.random() * H : -r * 2, r, vy: (0.5 + Math.random() * 1.3) * dpr,
        spin: Math.random() * 6.28, vs: 0.02 + Math.random() * 0.06, sway: (0.2 + Math.random() * 0.6) * dpr,
        phase: Math.random() * 6.28, a: 0.55 + Math.random() * 0.4 });
    }
    for (let i = 0; i < 34; i++) spawn(true);   // pre-fill so it looks alive instantly
    function drawCoin(c) {
      const w = Math.max(c.r * 0.14, Math.abs(Math.cos(c.spin)) * c.r);  // flip → ellipse width
      ctx.save(); ctx.translate(c.x, c.y); ctx.globalAlpha = c.a;
      const g = ctx.createRadialGradient(-w * 0.3, -c.r * 0.3, c.r * 0.1, 0, 0, c.r);
      g.addColorStop(0, '#fff6cf'); g.addColorStop(.5, '#e7c451'); g.addColorStop(1, '#9c7a1e');
      ctx.beginPath(); ctx.ellipse(0, 0, w, c.r, 0, 0, 6.283); ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = Math.max(1, c.r * 0.12); ctx.strokeStyle = 'rgba(120,90,20,.75)'; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, w * 0.58, c.r * 0.58, 0, 0, 6.283);
      ctx.lineWidth = Math.max(1, c.r * 0.08); ctx.strokeStyle = 'rgba(255,242,190,.5)'; ctx.stroke();
      ctx.restore();
    }
    function loop() {
      if (!running) return;
      ctx.clearRect(0, 0, W, H); tick++;
      if (coins.length < 60 && tick % 4 === 0) spawn();
      for (const c of coins) { c.y += c.vy; c.spin += c.vs; c.x += Math.sin(tick * 0.01 + c.phase) * c.sway; drawCoin(c); }
      coins = coins.filter((c) => c.y < H + c.r * 2);
      raf = requestAnimationFrame(loop);
    }
    loop();
    return { stop() { running = false; cancelAnimationFrame(raf); ctx.clearRect(0, 0, W, H); } };
  }
  window.__lobbyFX = initLobbyFX();

  // online buttons handed to online.js (loaded after this file)
  window.MJSolo = { cfg, get names() { return NAMES; } };
})();

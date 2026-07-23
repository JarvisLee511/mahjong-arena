/* ============================================================
   Mahjong Arena — networking transport.
   Supabase Realtime broadcast (4-player room) with a
   BroadcastChannel fallback (same browser, multi-tab) so the
   whole online flow is testable before keys are set.

   Message shape: { type, from(clientId), to(optional clientId), payload }
   Broadcast reaches everyone on the channel; clients filter by `to`.
   ============================================================ */
(function (root) {
  'use strict';

  // Explicit developer-only fallback. The old ?local=1 URL was too easy to
  // share with a friend, which silently put each device in a different room.
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  const FORCE_LOCAL = typeof location !== 'undefined' && LOCAL_HOSTS.has(location.hostname) &&
    new URLSearchParams(location.search).get('transport') === 'local';
  const CONFIG = FORCE_LOCAL ? { url: '', anonKey: '' } : {
    // reuse the same Supabase project as Sudoku Arena (realtime needs no tables)
    url: 'https://yiplqvtyshkzjeysnzfe.supabase.co',
    anonKey: 'sb_publishable_UbOcYXLiPzceoElNSxkPGQ_qsVU9qPG',
  };
  const isSupa = () => !!(CONFIG.url && CONFIG.anonKey);
  const SUPABASE_MODULES = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
    'https://esm.sh/@supabase/supabase-js@2',
  ];
  const ROOM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  const clientId = Math.random().toString(36).slice(2, 10);
  let role = null, code = null, channel = null, supa = null;
  let onMsg = null, reconnecting = null, messageSeq = 0, resumeTimer = null, reconnectTimer = null;
  let reconnectAttempts = 0;
  const seenMessages = new Set(), seenOrder = [];

  function normalizeRoomCode(value) {
    let text = String(value == null ? '' : value);
    try { text = text.normalize('NFKC'); } catch (e) {}
    return [...text.toUpperCase()].filter((char) => ROOM_CHARS.includes(char)).join('');
  }

  function genCode() {
    let s = ''; for (let i = 0; i < 6; i++) s += ROOM_CHARS[(Math.random() * ROOM_CHARS.length) | 0];
    return s;
  }

  function handle(msg) {
    if (!msg || msg.from === clientId) return;         // ignore self echo
    if (msg.to && msg.to !== clientId) return;         // not addressed to us
    if (msg.id) {
      if (seenMessages.has(msg.id)) return;
      seenMessages.add(msg.id); seenOrder.push(msg.id);
      if (seenOrder.length > 256) seenMessages.delete(seenOrder.shift());
    }
    onMsg && onMsg(msg.type, msg.payload, msg.from);
  }

  async function deliver(msg) {
    if (!channel) return false;
    try {
      if (isSupa()) {
        const status = await channel.send({ type: 'broadcast', event: 'm', payload: msg }, { timeout: 1500 });
        return status === 'ok';
      }
      channel.postMessage(msg);
      return true;
    } catch (e) { return false; }
  }

  async function send(type, payload, to) {
    const msg = { id: clientId + '-' + (++messageSeq), type, from: clientId, to: to || null, payload };
    if (isSupa() && (!channel || channel.state !== 'joined') && !(await ensureConnected())) return false;
    if (!channel) return false;
    if (await deliver(msg)) return true;
    // A server acknowledgement can time out during a mobile network handoff.
    // Retrying the same id is safe because receivers de-duplicate it.
    await new Promise((resolve) => setTimeout(resolve, 160));
    if (isSupa() && channel && channel.state !== 'joined' && !(await ensureConnected())) return false;
    return deliver(msg);
  }

  async function loadSupabase() {
    if (supa) return supa;
    let lastError = null;
    for (const source of SUPABASE_MODULES) {
      try {
        const mod = await import(source);
        const createClient = mod.createClient || (mod.default && mod.default.createClient);
        if (!createClient) throw new Error('createClient unavailable');
        supa = createClient(CONFIG.url, CONFIG.anonKey);
        return supa;
      } catch (e) { lastError = e; }
    }
    const error = new Error('連線元件載入失敗，請切換網路後再試');
    error.cause = lastError;
    throw error;
  }

  async function openChannel(room) {
    if (isSupa()) {
      await loadSupabase();
      if (channel) {
        const oldChannel = channel; channel = null;
        try { await supa.removeChannel(oldChannel); } catch (e) {}
      }
      const ch = supa.channel('mahjong-' + room, { config: { broadcast: { self: false, ack: true } } });
      ch.on('broadcast', { event: 'm' }, ({ payload }) => handle(payload));
      channel = ch;
      try {
        await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('連線逾時(realtime 無回應)')), 12000);
          ch.subscribe((status, err) => {
            if (status === 'SUBSCRIBED') { clearTimeout(to); resolve(); }
            else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
              clearTimeout(to); reject(err || new Error(status));
              if (channel === ch && role) scheduleReconnect();
            }
          });
        });
      } catch (e) {
        if (channel === ch) channel = null;
        try { await supa.removeChannel(ch); } catch (removeError) {}
        throw e;
      }
    } else {
      try { if (channel) channel.close(); } catch (e) {}
      channel = new BroadcastChannel('mj_room_' + room);
      channel.onmessage = (e) => handle(e.data);
    }
  }

  async function ensureConnected(force) {
    if (!code) return false;
    if (!isSupa() && !force) return !!channel;
    if (isSupa() && !force && channel && channel.state === 'joined') return true;
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      try {
        await openChannel(code);
        return true;
      } catch (e) { return false; }
      finally { reconnecting = null; }
    })();
    return reconnecting;
  }
  async function resumeConnection() {
    // Re-open even when the client still reports "joined": mobile browsers can
    // preserve that stale state after suspending the WebSocket in background.
    if (!role || !code) return false;
    if (!(await ensureConnected(true))) {
      scheduleReconnect(Math.min(10000, 600 * Math.pow(2, Math.min(reconnectAttempts++, 4))));
      return false;
    }
    reconnectAttempts = 0;
    if (role === 'guest') await send('rejoin', {});
    else if (role === 'host') await send('host-rejoin', {});
    return true;
  }
  function scheduleReconnect(delay = 600) {
    if (!role || !code) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (role && code) resumeConnection();
    }, delay);
  }
  function scheduleResume() {
    if (!role || !code) return;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (role && code) resumeConnection();
    }, 120);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleResume(); });
    window.addEventListener('online', scheduleResume);
    window.addEventListener('focus', scheduleResume);
    window.addEventListener('pageshow', scheduleResume);
  }

  const MJNet = {
    clientId,
    get role() { return role; },
    get code() { return code; },
    get usingSupabase() { return isSupa(); },
    normalizeRoomCode,
    async create(handler) { role = 'host'; onMsg = handler; code = genCode(); await openChannel(code); return code; },
    async join(room, handler) {
      role = 'guest'; onMsg = handler; code = normalizeRoomCode(room);
      if (code.length !== 6) throw new Error('房號必須是 6 碼');
      await openChannel(code); return code;
    },
    async restore(room, savedRole, handler) {
      const normalized = normalizeRoomCode(room);
      if (normalized.length !== 6 || !['host', 'guest'].includes(savedRole)) throw new Error('invalid saved room');
      role = savedRole; onMsg = handler; code = normalized;
      await openChannel(code); return code;
    },
    send,
    resume: resumeConnection,
    to(cid, type, payload) { return send(type, payload, cid); },
    leave() {
      role = null; code = null; onMsg = null;
      reconnectAttempts = 0;
      clearTimeout(resumeTimer); clearTimeout(reconnectTimer);
      try { if (isSupa() && channel) supa.removeChannel(channel); else if (channel) channel.close(); } catch (e) {}
      channel = null;
    },
  };
  root.MJNet = MJNet;
})(typeof window !== 'undefined' ? window : globalThis);

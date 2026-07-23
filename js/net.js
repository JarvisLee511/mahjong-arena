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

  // ?local=1 forces the BroadcastChannel transport (same-browser multi-tab),
  // handy for offline testing without hitting Supabase.
  const FORCE_LOCAL = typeof location !== 'undefined' && /[?&]local\b/.test(location.search);
  const CONFIG = FORCE_LOCAL ? { url: '', anonKey: '' } : {
    // reuse the same Supabase project as Sudoku Arena (realtime needs no tables)
    url: 'https://yiplqvtyshkzjeysnzfe.supabase.co',
    anonKey: 'sb_publishable_UbOcYXLiPzceoElNSxkPGQ_qsVU9qPG',
  };
  const isSupa = () => !!(CONFIG.url && CONFIG.anonKey);

  const clientId = Math.random().toString(36).slice(2, 10);
  let role = null, code = null, channel = null, supa = null;
  let onMsg = null, connecting = false;

  function genCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusables
    let s = ''; for (let i = 0; i < 6; i++) s += chars[(Math.random() * chars.length) | 0];
    return s;
  }

  function handle(msg) {
    if (!msg || msg.from === clientId) return;         // ignore self echo
    if (msg.to && msg.to !== clientId) return;         // not addressed to us
    onMsg && onMsg(msg.type, msg.payload, msg.from);
  }

  function send(type, payload, to) {
    if (!channel) return;
    const msg = { type, from: clientId, to: to || null, payload };
    try {
      if (isSupa()) channel.send({ type: 'broadcast', event: 'm', payload: msg });
      else channel.postMessage(msg);
    } catch (e) { /* mid-reconnect; heartbeat/logic will retry */ }
  }

  async function openChannel(room) {
    if (isSupa()) {
      if (!supa) {
        const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
        supa = mod.createClient(CONFIG.url, CONFIG.anonKey);
      }
      if (channel) { try { supa.removeChannel(channel); } catch (e) {} channel = null; }
      const ch = supa.channel('mahjong-' + room, { config: { broadcast: { self: false } } });
      ch.on('broadcast', { event: 'm' }, ({ payload }) => handle(payload));
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('連線逾時(realtime 無回應)')), 12000);
        ch.subscribe((status, err) => {
          if (status === 'SUBSCRIBED') { clearTimeout(to); resolve(); }
          else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) { clearTimeout(to); reject(err || new Error(status)); }
        });
      });
      channel = ch;
    } else {
      channel = new BroadcastChannel('mj_room_' + room);
      channel.onmessage = (e) => handle(e.data);
    }
  }

  async function ensureConnected() {
    if (!isSupa() || !code || connecting) return;
    if (channel && channel.state === 'joined') return;
    connecting = true;
    try { await openChannel(code); } catch (e) {} finally { connecting = false; }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureConnected(); });
    window.addEventListener('online', ensureConnected);
  }

  const MJNet = {
    clientId,
    get role() { return role; },
    get code() { return code; },
    get usingSupabase() { return isSupa(); },
    async create(handler) { role = 'host'; onMsg = handler; code = genCode(); await openChannel(code); return code; },
    async join(room, handler) { role = 'guest'; onMsg = handler; code = String(room).toUpperCase().trim(); await openChannel(code); return code; },
    send,
    to(cid, type, payload) { send(type, payload, cid); },
    leave() { try { if (isSupa() && channel) supa.removeChannel(channel); else if (channel) channel.close(); } catch (e) {} channel = null; },
  };
  root.MJNet = MJNet;
})(typeof window !== 'undefined' ? window : globalThis);

/* Persistent mobile session + scene helpers. */
(function (root) {
  'use strict';

  const KEY = 'mahjong_arena_resume_v2';
  const MAX_AGE = 24 * 60 * 60 * 1000;
  const LOBBY_COLOR = '#0B0E14';
  const GAME_COLOR = '#25A9D2';

  function initTabId() {
    try {
      const state = root.history.state || {};
      if (state.__mahjongArenaTab) return state.__mahjongArenaTab;
      const id = token();
      root.history.replaceState(Object.assign({}, state, { __mahjongArenaTab: id }), document.title);
      return id;
    } catch (e) { return token(); }
  }
  const TAB_ID = initTabId();

  function read(storage) {
    try {
      const value = JSON.parse(storage.getItem(KEY) || 'null');
      if (!value || value.version !== 2 || !value.savedAt || Date.now() - value.savedAt > MAX_AGE) return null;
      return value;
    } catch (e) { return null; }
  }

  function load() {
    // sessionStorage belongs to this tab. Prefer it so two local test tabs do
    // not restore each other's host/guest record through shared localStorage.
    let session = null;
    try { session = read(root.sessionStorage); } catch (e) {}
    if (session) return session;
    try {
      const local = read(root.localStorage);
      return local && local.tabId === TAB_ID ? local : null;
    } catch (e) { return null; }
  }

  function save(value) {
    if (!value || typeof value !== 'object') return false;
    const record = Object.assign({}, value, { version: 2, savedAt: Date.now(), tabId: TAB_ID });
    let saved = false;
    try {
      const json = JSON.stringify(record);
      try { root.sessionStorage.setItem(KEY, json); saved = true; } catch (e) {}
      try { root.localStorage.setItem(KEY, json); saved = true; } catch (e) {}
    } catch (e) {}
    return saved;
  }

  function clear() {
    try { root.sessionStorage.removeItem(KEY); } catch (e) {}
    try {
      const local = read(root.localStorage);
      if (!local || local.tabId === TAB_ID) root.localStorage.removeItem(KEY);
    } catch (e) {}
  }

  function token() {
    try {
      const bytes = new Uint8Array(16); root.crypto.getRandomValues(bytes);
      return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
  }

  function setScene(scene) {
    const game = scene === 'game';
    document.documentElement.classList.toggle('game-scene', game);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', game ? GAME_COLOR : LOBBY_COLOR);
  }

  root.MJSession = { load, save, clear, token, setScene };
})(typeof window !== 'undefined' ? window : globalThis);

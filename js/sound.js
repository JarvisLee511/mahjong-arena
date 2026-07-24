/* ============================================================
   Mahjong Arena — sound. Zero external files:
   · WebAudio-synthesised tile/claim blips
   · Browser SpeechSynthesis for 報牌 (國語/台語 voice if present)
   ============================================================ */
(function (root) {
  'use strict';
  let ctx = null;
  let enabled = true;
  let lang = 'zh-TW';

  function ac() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // a short shaped tone
  function tone(freq, dur, type, gain, slideTo) {
    const a = ac(); if (!a || !enabled) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'triangle';
    o.frequency.value = freq;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, a.currentTime + dur);
    g.gain.setValueAtTime(0, a.currentTime);
    g.gain.linearRampToValueAtTime(gain ?? 0.18, a.currentTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + dur + 0.02);
  }
  // filtered noise burst (clack)
  function clack(gain) {
    const a = ac(); if (!a || !enabled) return;
    const n = a.sampleRate * 0.05, buf = a.createBuffer(1, n, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200; f.Q.value = 0.8;
    const g = a.createGain(); g.gain.value = gain ?? 0.25;
    src.connect(f); f.connect(g); g.connect(a.destination); src.start();
  }

  const FX = {
    draw() { tone(520, 0.08, 'sine', 0.10); },
    discard() { clack(0.28); },
    deal() { clack(0.18); },
    pung() { tone(300, 0.12, 'square', 0.16, 180); },
    kong() { tone(240, 0.18, 'square', 0.18, 120); },
    chow() { tone(420, 0.10, 'triangle', 0.14, 520); },
    tick() { tone(880, 0.04, 'sine', 0.08); },
    hu() { [660, 880, 1180].forEach((f, i) => setTimeout(() => tone(f, 0.18, 'triangle', 0.2), i * 90)); },
    win() { [523, 659, 784, 1046, 1318].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'triangle', 0.22), i * 110)); },
    lose() { tone(300, 0.4, 'sawtooth', 0.15, 120); },
  };

  // ---- 台語語音:優先播 assets/audio/*.mp3,沒有就退回國語 TTS ----
  // 使用者自錄的台語短句丟進 assets/audio/ 即自動生效(檔名見下)。
  const VOICE = {
    pung: '碰', kong: '槓', chow: '吃', hu: '胡啦', tsumo: '自摸',
    draw: '流局', tenpai: '聽牌', start: '開始',
  };
  const BOOSTED_RECORDED_CLAIMS = new Set(['pung', 'kong', 'chow', 'hu', 'tsumo']);
  const RECORDED_VOICE_VOLUME = 0.33;
  const TILE_CLIP_GAIN = 6.0;     // 報牌通道(用戶指定 2.0 再×3),有限幅器防爆音
  const TILE_TTS_VOLUME = 0.9;    // TTS 備援報牌(SpeechSynthesis 上限 1.0)
  const BOOST_BASE = 6.75;        // 自錄吃碰槓胡(用戶指定 4.5×1.5)
  const clips = {};            // key -> HTMLAudioElement
  const boostedSources = new WeakMap();
  const tileSources = new WeakMap();
  let boostedGain = null, boostedLimiter = null, tileGain = null;
  let voicesTried = false;

  // ---- 三通道音量(⚙設定面板):tts=電腦報牌 / bgm=背景音樂 / voice=自錄吃碰槓胡 ----
  // 滑桿 0..1;0.5=原本音量,1=兩倍(有上限),0=靜音。存 localStorage。
  const VOL_KEY = 'mj_volumes';
  const vol = { tts: 0.5, bgm: 0.5, voice: 0.5 };
  try {
    const s = JSON.parse(localStorage.getItem(VOL_KEY) || 'null');
    if (s) for (const k in vol) if (typeof s[k] === 'number') vol[k] = Math.max(0, Math.min(1, s[k]));
  } catch (e) {}
  const mul = (k) => vol[k] * 2;
  const capped = (v) => Math.max(0, Math.min(1, v));
  function applyVolumes() {
    if (tileGain) tileGain.gain.value = TILE_CLIP_GAIN * mul('tts');
    if (boostedGain) boostedGain.gain.value = BOOST_BASE * mul('voice');
    if (bgmKind && BGM_VOL[bgmKind] != null) {
      if (bgmMusicGain) bgmMusicGain.gain.value = BGM_VOL[bgmKind] * mul('bgm');
      if (bgmAudio) bgmAudio.volume = capped(BGM_VOL[bgmKind] * mul('bgm'));
    }
    if (bgmGain && bgmKind && SYNTH_VOL[bgmKind] != null) bgmGain.gain.value = SYNTH_VOL[bgmKind] * mul('bgm');
  }
  function setVolume(key, v) {
    if (!(key in vol)) return;
    vol[key] = Math.max(0, Math.min(1, v));
    try { localStorage.setItem(VOL_KEY, JSON.stringify(vol)); } catch (e) {}
    applyVolumes();
  }

  // Claim calls need more presence than tile names, but raw 3x gain clips loudly.
  // Keep the gain on its own bus and catch peaks before they reach the speakers.
  function mkLimiter(a) {
    const limiter = a.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    return limiter;
  }
  function ensureBoostedBus() {
    const a = ac(); if (!a) return null;
    if (!boostedGain) {
      boostedGain = a.createGain();
      boostedGain.gain.value = BOOST_BASE * mul('voice');
      boostedLimiter = mkLimiter(a);
      boostedGain.connect(boostedLimiter);
      boostedLimiter.connect(a.destination);
    }
    return boostedGain;
  }
  function ensureTileBus() {
    const a = ac(); if (!a) return null;
    if (!tileGain) {
      tileGain = a.createGain();
      tileGain.gain.value = TILE_CLIP_GAIN * mul('tts');
      const limiter = mkLimiter(a);   // 增益>1,比照吃碰通道限幅防爆音
      tileGain.connect(limiter);
      limiter.connect(a.destination);
    }
    return tileGain;
  }
  function routeBoostedVoice(audio) {
    const a = ac(), g = ensureBoostedBus();
    if (!a || !g) return false;
    try {
      if (!boostedSources.has(audio)) {
        const source = a.createMediaElementSource(audio);
        source.connect(g);
        boostedSources.set(audio, source);
      }
      return true;
    } catch (e) { return false; }
  }
  function routeTileVoice(audio) {
    const a = ac(), g = ensureTileBus();
    if (!a || !g) return false;
    try {
      if (!tileSources.has(audio)) {
        const source = a.createMediaElementSource(audio);
        source.connect(g);
        tileSources.set(audio, source);
      }
      return true;
    } catch (e) { return false; }
  }

  // ---- WebAudio buffer 播放(主路徑)----------------------------------
  // iOS WebKit 對 <audio>.volume 與 MediaElementSource 都不可靠(音量增益可能被繞過),
  // 一律 fetch+decode 成 AudioBuffer 走增益播;fetch 失敗(如 file:// 直開)退回 <audio> 元素。
  const buffers = {};              // key -> AudioBuffer
  const bufferFails = new Set();
  const bufferLoading = new Set();
  function loadBuffer(key, url) {
    const a = ac();
    if (typeof location !== 'undefined' && location.protocol === 'file:') {   // file:// fetch 必被 CORS 擋,直接走元素備援
      bufferFails.add(key);
      return Promise.resolve(null);
    }
    if (!a || buffers[key] || bufferFails.has(key) || bufferLoading.has(key)) {
      return Promise.resolve(buffers[key] || null);
    }
    bufferLoading.add(key);
    return fetch(url)
      .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
      .then((ab) => new Promise((res, rej) => a.decodeAudioData(ab, res, rej)))
      .then((buf) => { buffers[key] = buf; bufferLoading.delete(key); return buf; })
      .catch(() => { bufferFails.add(key); bufferLoading.delete(key); return null; });
  }
  function playBuffer(key, gainNode) {
    const a = ac(), buf = buffers[key];
    if (!a || !buf || !gainNode) return false;
    try {
      const s = a.createBufferSource();
      s.buffer = buf; s.connect(gainNode); s.start();
      return true;
    } catch (e) { return false; }
  }
  function playBufferAtVolume(key, volume) {   // 一次性小增益(非常駐 bus 的雜項語音)
    const a = ac(), buf = buffers[key];
    if (!a || !buf) return false;
    try {
      const g = a.createGain(); g.gain.value = volume; g.connect(a.destination);
      const s = a.createBufferSource(); s.buffer = buf; s.connect(g); s.start();
      return true;
    } catch (e) { return false; }
  }
  function decodeAllClips() {   // 把清單裡的音檔全部解碼(loadBuffer 自身防重複)
    Object.keys(clips).forEach((key) => {
      const src = clips[key] && clips[key].src;
      if (src) loadBuffer(key, src);
    });
  }
  // load only the files listed in assets/audio/manifest.json → no 404 spam.
  // manifest is a JSON array of filenames, e.g. ["pung.m4a","hu.mp3"].
  // ⚠️ file:// 直開時 fetch 被 CORS 擋 → 退回內建清單(<audio> 元素不受此限),
  //    自錄的吃碰槓胡/報牌才不會無聲變 TTS。缺檔由 onerror 移除,照樣回 TTS。
  const DEFAULT_AUDIO_FILES = [
    'pung.m4a', 'kong.m4a', 'chow.m4a', 'hu.m4a', 'tsumo.m4a',
    ...['m', 'p', 's'].flatMap((s) => Array.from({ length: 9 }, (_, i) => s + (i + 1) + '.m4a')),
    ...Array.from({ length: 7 }, (_, i) => 'z' + (i + 1) + '.m4a'),
  ];
  function loadClips(files) {
    (files || []).forEach((f) => {
      const key = String(f).replace(/\.[^.]+$/, '');
      if (clips[key]) return;
      const a = new Audio('assets/audio/' + f); a.preload = 'auto';
      const isTile = /^(?:[mps][1-9]|z[1-7])$/.test(key);
      a.volume = BOOSTED_RECORDED_CLAIMS.has(key) || isTile ? 1 : RECORDED_VOICE_VOLUME;
      a.onerror = () => { delete clips[key]; };
      clips[key] = a;
    });
    decodeAllClips();   // AudioContext 已在(解鎖後)就順手解碼成 buffer
  }
  function preloadVoices() {
    if (voicesTried) return; voicesTried = true;
    fetch('assets/audio/manifest.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : DEFAULT_AUDIO_FILES))
      .then(loadClips)
      .catch(() => loadClips(DEFAULT_AUDIO_FILES));
  }
  function voice(key) {
    if (!enabled) return;
    // 主路徑:AudioBuffer 走增益(手機/桌機音量一致);沒 buffer 才退回 <audio> 元素
    if (BOOSTED_RECORDED_CLAIMS.has(key)) {
      if (playBuffer(key, ensureBoostedBus())) return;
    } else if (playBufferAtVolume(key, RECORDED_VOICE_VOLUME * mul('voice'))) return;
    const a = clips[key];
    if (a) {
      try {
        if (BOOSTED_RECORDED_CLAIMS.has(key)) {
          if (!routeBoostedVoice(a)) a.volume = capped(mul('voice'));   // WebAudio 不可用時退回元素音量
        } else a.volume = capped(RECORDED_VOICE_VOLUME * mul('voice'));
        a.currentTime = 0; a.play(); return;
      } catch (e) {}
    }
    say(VOICE[key] || key, capped(0.9 * mul('voice')));    // fallback TTS 跟著自錄語音滑桿
  }
  // 報牌:打出的每張牌念出牌名。有 assets/audio/<code>.* 音檔就播,否則國語 TTS。
  function tileVoice(code, spoken) {
    if (!enabled) return;
    if (playBuffer(code, ensureTileBus())) return;
    const a = clips[code];
    if (a) {
      try {
        if (!routeTileVoice(a)) a.volume = capped(TILE_CLIP_GAIN * mul('tts'));
        a.currentTime = 0; a.play(); return;
      } catch (e) {}
    }
    if (spoken) say(spoken, capped(TILE_TTS_VOLUME * mul('tts')));
  }

  // Chinese TTS: 報牌 / 碰 / 槓 / 胡啦
  let voices = [];
  function loadVoices() { voices = (window.speechSynthesis && speechSynthesis.getVoices()) || []; }
  if (window.speechSynthesis) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  function say(text, volume) {
    if (!enabled || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang; u.rate = 1.05; u.pitch = 1.0; u.volume = volume ?? capped(0.9 * mul('tts'));
      const v = voices.find((x) => /zh[-_]?(TW|HK|CN)/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  // ---- background music (原創,零版權) -------------------------
  // 'lobby' = 戲劇賭場氛圍(賭神那種感覺,原創);'game' = 中國風輕音樂(音量壓低於人聲)。
  // 兩條音軌在載入腳本時先建立，手機上的第一次手勢可直接 play，不需等待 fetch。
  const BGM_FILES = { lobby: 'lobby.mp3', game: 'game.mp3' };
  const BGM_VOL = { lobby: 0.3, game: 0.049 };      // 音檔基準音量(用戶指定×0.6;滑桿 0.5 = 此值)
  const SYNTH_VOL = { lobby: 0.096, game: 0.014 };  // WebAudio 合成備援基準(同步×0.6)
  const bgmTracks = {};
  if (typeof Audio !== 'undefined') {
    Object.keys(BGM_FILES).forEach((kind) => {
      const audio = new Audio('assets/music/' + BGM_FILES[kind]);
      audio.preload = 'auto';
      audio.loop = true;
      try { audio.load(); } catch (e) {}
      bgmTracks[kind] = audio;
    });
  }
  let bgmOn = false, bgmKind = null, bgmAudio = null, bgmTimer = null, bgmGain = null;
  let bgmGeneration = 0;
  // iOS WebKit 對 <audio>.volume 和 MediaElementSource 都不可靠 → BGM 主路徑=AudioBuffer 循環播放
  let bgmMusicGain = null, bgmSource = null;
  function ensureBgmBus() {
    const a = ac(); if (!a) return null;
    if (!bgmMusicGain) { bgmMusicGain = a.createGain(); bgmMusicGain.connect(a.destination); }
    return bgmMusicGain;
  }
  function mkNote(freq, when, dur, type, gain, cutoff) {
    const a = ac(); if (!a || !bgmGain) return;
    const o = a.createOscillator(), g = a.createGain(), f = a.createBiquadFilter();
    o.type = type; o.frequency.value = freq; f.type = 'lowpass'; f.frequency.value = cutoff || 2000;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(f); f.connect(g); g.connect(bgmGain);
    o.start(when); o.stop(when + dur + 0.05);
  }
  // 首頁:戲劇性小調賭場氛圍(Dm–B♭–C–A,原創進行)
  function lobbyLoop(a, generation) {
    const BASS = [73.42, 58.27, 65.41, 55.00];   // D2 B♭1 C2 A1
    const CH = [[293.66, 349.23, 440.00], [233.08, 349.23, 466.16], [261.63, 392.00, 523.25], [277.18, 329.63, 440.00]];
    const beat = 0.5; let bar = 0;
    (function sch() {
      if (!bgmOn || bgmKind !== 'lobby' || generation !== bgmGeneration) return;
      const t0 = a.currentTime + 0.05, bassF = BASS[bar % 4], notes = CH[bar % 4];
      for (let b = 0; b < 4; b++) mkNote(bassF, t0 + b * beat, 0.44, 'sawtooth', 0.5, 420);   // 低音脈動
      notes.forEach((f) => mkNote(f, t0, beat * 3.6, 'sawtooth', 0.10, 1150));                 // 銅管襯底
      if (bar % 2 === 0) mkNote(notes[2] * 2, t0 + beat * 2, 0.5, 'triangle', 0.12, 4200);      // 高音動機
      if (bar % 4 === 3) [523.25, 587.33, 659.25].forEach((f, i) => mkNote(f, t0 + beat * 2 + i * 0.12, 0.14, 'square', 0.10, 3200)); // 緊張上行
      bar++; bgmTimer = setTimeout(sch, beat * 4 * 1000);
    })();
  }
  // 遊戲中:中國風五聲音階輕音樂(古箏感撥弦 + 柔和低鳴,原創)
  function gameLoop(a, generation) {
    const R = 0; // 休止
    const MEL = [392.00, 440.00, 523.25, 440.00, 392.00, 329.63, 392.00, R, 293.66, 329.63, 392.00, 329.63, 293.66, 261.63, R, R];
    const DRONE = [130.81, 196.00]; // C3 G3
    const beat = 0.42; let i = 0;
    (function sch() {
      if (!bgmOn || bgmKind !== 'game' || generation !== bgmGeneration) return;
      const t0 = a.currentTime + 0.05, f = MEL[i % MEL.length];
      if (f) { mkNote(f, t0, 0.5, 'triangle', 0.5, 2600); mkNote(f * 2, t0, 0.32, 'sine', 0.14, 4200); }
      if (i % 8 === 0) DRONE.forEach((d) => mkNote(d, t0, beat * 8, 'sine', 0.22, 520));
      i++; bgmTimer = setTimeout(sch, beat * 1000);
    })();
  }
  function startSynth(kind, generation) {
    if (!bgmOn || bgmKind !== kind || generation !== bgmGeneration) return;
    const a = ac(); if (!a) return;
    bgmGain = a.createGain();
    bgmGain.gain.value = SYNTH_VOL[kind] * mul('bgm');   // 遊戲中極淡,遠低於吃碰人聲
    bgmGain.connect(a.destination);
    (kind === 'game' ? gameLoop : lobbyLoop)(a, generation);
  }
  function bgmStart(kind) {
    kind = kind || 'lobby';
    if (!enabled || (bgmOn && bgmKind === kind)) return;
    bgmStop(); bgmOn = true; bgmKind = kind;
    const a = ac();
    const generation = bgmGeneration;
    const bus = ensureBgmBus();
    if (a && bus) {
      bus.gain.value = BGM_VOL[kind] * mul('bgm');
      loadBuffer('bgm:' + kind, 'assets/music/' + BGM_FILES[kind]).then((buf) => {
        if (!bgmOn || bgmKind !== kind || generation !== bgmGeneration) return;
        if (!buf) { bgmElementFallback(kind, generation); return; }
        try {
          bgmSource = a.createBufferSource();
          bgmSource.buffer = buf; bgmSource.loop = true;
          bgmSource.connect(bus); bgmSource.start();
        } catch (e) { bgmElementFallback(kind, generation); }
      });
      return;
    }
    bgmElementFallback(kind, generation);
  }
  // 無 WebAudio / fetch 失敗(file:// 直開)才退回 <audio> 元素播放
  function bgmElementFallback(kind, generation) {
    if (!bgmOn || bgmKind !== kind || generation !== bgmGeneration) return;
    const audio = bgmTracks[kind];
    if (!audio) { startSynth(kind, generation); return; }
    bgmAudio = audio;
    bgmAudio.volume = capped(BGM_VOL[kind] * mul('bgm'));
    try { bgmAudio.currentTime = 0; } catch (e) {}
    let playback;
    try { playback = bgmAudio.play(); }
    catch (e) { startSynth(kind, generation); return; }
    if (playback && typeof playback.catch === 'function') {
      playback.catch(() => {
        if (!bgmOn || bgmKind !== kind || generation !== bgmGeneration || bgmAudio !== audio) return;
        startSynth(kind, generation);
      });
    }
  }
  function bgmStop() {
    bgmGeneration++;
    bgmOn = false; bgmKind = null;
    if (bgmTimer) { clearTimeout(bgmTimer); bgmTimer = null; }
    if (bgmSource) { try { bgmSource.stop(); } catch (e) {} bgmSource = null; }
    Object.keys(bgmTracks).forEach((kind) => { try { bgmTracks[kind].pause(); } catch (e) {} });
    bgmAudio = null;
    if (bgmGain) { try { bgmGain.gain.value = 0; } catch (e) {} bgmGain = null; }
  }

  preloadVoices();

  const MJSound = {
    fx(name) { if (FX[name]) FX[name](); },
    say, voice, tile: tileVoice, preloadVoices,
    setVolume, volumes: () => Object.assign({}, vol),
    bgmStart, bgmStop,
    unlock() { ac(); preloadVoices(); decodeAllClips(); },   // call on first user gesture
    set enabled(v) { enabled = v; if (!v) { bgmStop(); if (window.speechSynthesis) speechSynthesis.cancel(); } },
    get enabled() { return enabled; },
    set lang(v) { lang = v; },
  };
  root.MJSound = MJSound;
})(typeof window !== 'undefined' ? window : globalThis);

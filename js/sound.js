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
  const clips = {};            // key -> HTMLAudioElement
  const boostedSources = new WeakMap();
  let boostedGain = null, boostedLimiter = null;
  let voicesTried = false;

  // Claim calls need more presence than tile names, but raw 3x gain clips loudly.
  // Keep the gain on its own bus and catch peaks before they reach the speakers.
  function routeBoostedVoice(audio) {
    const a = ac();
    if (!a) return false;
    try {
      if (!boostedGain) {
        boostedGain = a.createGain();
        boostedGain.gain.value = 4.5;
        boostedLimiter = a.createDynamicsCompressor();
        boostedLimiter.threshold.value = -6;
        boostedLimiter.knee.value = 0;
        boostedLimiter.ratio.value = 20;
        boostedLimiter.attack.value = 0.001;
        boostedLimiter.release.value = 0.12;
        boostedGain.connect(boostedLimiter);
        boostedLimiter.connect(a.destination);
      }
      if (!boostedSources.has(audio)) {
        const source = a.createMediaElementSource(audio);
        source.connect(boostedGain);
        boostedSources.set(audio, source);
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  // load only the files listed in assets/audio/manifest.json → no 404 spam.
  // manifest is a JSON array of filenames, e.g. ["pung.m4a","hu.mp3"].
  function preloadVoices() {
    if (voicesTried) return; voicesTried = true;
    fetch('assets/audio/manifest.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((files) => {
        (files || []).forEach((f) => {
          const key = String(f).replace(/\.[^.]+$/, '');
          const a = new Audio('assets/audio/' + f); a.preload = 'auto';
          a.volume = BOOSTED_RECORDED_CLAIMS.has(key) ? 1 : RECORDED_VOICE_VOLUME;
          clips[key] = a;
        });
      })
      .catch(() => {});
  }
  function voice(key) {
    if (!enabled) return;
    const a = clips[key];
    if (a) {
      try {
        if (BOOSTED_RECORDED_CLAIMS.has(key)) routeBoostedVoice(a);
        a.currentTime = 0; a.play(); return;
      } catch (e) {}
    }
    say(VOICE[key] || key);    // fallback TTS keeps its normal volume
  }
  // 報牌:打出的每張牌念出牌名。有 assets/audio/<code>.* 音檔就播,否則國語 TTS。
  function tileVoice(code, spoken) {
    if (!enabled) return;
    const a = clips[code];
    if (a) { try { a.currentTime = 0; a.play(); return; } catch (e) {} }
    if (spoken) say(spoken, 0.3);
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
      u.lang = lang; u.rate = 1.05; u.pitch = 1.0; u.volume = volume ?? 0.9;
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
    bgmGain.gain.value = kind === 'game' ? 0.023 : 0.16;   // 遊戲中極淡,遠低於吃碰人聲
    bgmGain.connect(a.destination);
    (kind === 'game' ? gameLoop : lobbyLoop)(a, generation);
  }
  function bgmStart(kind) {
    kind = kind || 'lobby';
    if (!enabled || (bgmOn && bgmKind === kind)) return;
    bgmStop(); bgmOn = true; bgmKind = kind; ac();
    const generation = bgmGeneration;
    const audio = bgmTracks[kind];
    if (!audio) { startSynth(kind, generation); return; }
    bgmAudio = audio;
    bgmAudio.volume = kind === 'game' ? 0.081 : 0.5;   // 中國風再降,更淡
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
    Object.keys(bgmTracks).forEach((kind) => { try { bgmTracks[kind].pause(); } catch (e) {} });
    bgmAudio = null;
    if (bgmGain) { try { bgmGain.gain.value = 0; } catch (e) {} bgmGain = null; }
  }

  preloadVoices();

  const MJSound = {
    fx(name) { if (FX[name]) FX[name](); },
    say, voice, tile: tileVoice, preloadVoices,
    bgmStart, bgmStop,
    unlock() { ac(); preloadVoices(); },         // call on first user gesture
    set enabled(v) { enabled = v; if (!v) { bgmStop(); if (window.speechSynthesis) speechSynthesis.cancel(); } },
    get enabled() { return enabled; },
    set lang(v) { lang = v; },
  };
  root.MJSound = MJSound;
})(typeof window !== 'undefined' ? window : globalThis);

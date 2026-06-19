(() => {
  'use strict';

  const canvas = document.getElementById('canvas');
  const overlay = document.getElementById('runnerOverlay');
  const params = new URLSearchParams(location.search);
  let session = params.get('session') || '';

  const MS_OFF = {
    ACTION: 0x0C,
    FACE_YAW: 0x2E,
    POS_X: 0x3C,
    POS_Y: 0x40,
    POS_Z: 0x44,
    FWD_VEL: 0x54,
    COINS: 0xA8,
    STARS: 0xAA,
    LIVES: 0xAD,
    HEALTH: 0xAE,
    CAP_TIMER: 0xB6,
  };

  const DEFAULT_SETTINGS = {
    mode: 'tilt',
    target: 'auto',
    strength: 6,
    speed: 6,
    tiltBias: 28,
    rangeStart: 20,
    rangeEnd: 86,
    protectLow: true,
    smartGuard: true,
    crashGuard: true,
    visualFx: true,
  };

  const state = {
    booted: false,
    ready: false,
    armed: false,
    tilted: false,
    scriptLoaded: false,
    settings: { ...DEFAULT_SETTINGS },
    corruptTimer: 0,
    heartbeatTimer: 0,
    hotTimer: 0,
    snapshot: null,
    snapshotTime: 0,
    lastLayer: [],
    totalPokes: 0,
    heapBuffer: null,
    views: null,
    marioBase: -1,
    marioScanCursor: 0x400,
    lastMarioScan: 0,
    hotCursor: 0,
    hotHashes: new Map(),
    hotScores: new Map(),
    hotPages: [],
    lastTargetLabel: 'waiting',
  };

  function post(type, payload = {}) {
    try { parent.postMessage({ source: 'cartritilt64-runner', session, type, payload }, '*'); } catch (_) {}
  }

  function runnerLog(message, kind = 'info') { post('log', { message, kind }); }
  function status(message, tone = 'idle') { post('status', { message, tone }); }
  function setOverlay(text, hidden = false) {
    overlay.textContent = text;
    overlay.classList.toggle('hidden', hidden);
  }

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function randInt(max) { return Math.floor(Math.random() * Math.max(1, max)); }
  function chance(p) { return Math.random() < p; }
  function pick(arr) { return arr[randInt(arr.length)] || 0; }
  function finite(v) { return Number.isFinite(v); }
  function hex(n) { return `0x${(n >>> 0).toString(16)}`; }

  window.addEventListener('error', (ev) => {
    post('crash', { message: ev.message || 'window error', filename: ev.filename, lineno: ev.lineno });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    post('crash', { message: (ev.reason && (ev.reason.message || String(ev.reason))) || 'unhandled rejection' });
  });

  function mergeSettings(next = {}) {
    state.settings = { ...state.settings, ...next };
    state.settings.strength = clamp(Number(state.settings.strength) || DEFAULT_SETTINGS.strength, 1, 64);
    state.settings.speed = clamp(Number(state.settings.speed) || DEFAULT_SETTINGS.speed, 1, 30);
    state.settings.tiltBias = clamp(Number(state.settings.tiltBias) || DEFAULT_SETTINGS.tiltBias, 0, 100);
    state.settings.rangeStart = clamp(Number(state.settings.rangeStart) || 0, 0, 98);
    state.settings.rangeEnd = clamp(Number(state.settings.rangeEnd) || 100, 1, 100);
    if (state.settings.rangeStart >= state.settings.rangeEnd) state.settings.rangeEnd = Math.min(100, state.settings.rangeStart + 1);
    if (state.armed || state.tilted) restartCorruptTimer();
  }

  function getViews() {
    const M = window.Module;
    if (!M || !M.HEAPU8) return null;
    const u8 = M.HEAPU8;
    if (state.heapBuffer !== u8.buffer) {
      state.heapBuffer = u8.buffer;
      state.views = {
        u8,
        i8: M.HEAP8,
        u16: M.HEAPU16,
        i16: M.HEAP16,
        u32: M.HEAPU32,
        i32: M.HEAP32,
        f32: M.HEAPF32,
      };
      runnerLog(`Heap view ready (${(u8.length / 1048576).toFixed(1)} MiB).`, 'good');
    }
    return state.views;
  }

  function safeRange() {
    const v = getViews();
    if (!v) return [0, 0];
    const len = v.u8.length;
    let start = Math.floor(len * (state.settings.rangeStart / 100));
    let end = Math.floor(len * (state.settings.rangeEnd / 100));
    if (state.settings.protectLow) start = Math.max(start, Math.min(len - 4096, Math.max(2 * 1024 * 1024, Math.floor(len * 0.06))));
    end = Math.min(end, len - 1024);
    start = clamp(start, 0, Math.max(0, len - 2048));
    if (end <= start + 1024) end = Math.min(len - 1024, start + 1024);
    return [start, end];
  }

  function validAddr(addr, bytes = 1) {
    const v = getViews();
    if (!v) return false;
    const [start, end] = safeRange();
    return addr >= start && addr + bytes < end && addr + bytes < v.u8.length;
  }

  function rememberWrite(layer, addr, bytes = 1) {
    const v = getViews();
    if (!v || !validAddr(addr, bytes)) return false;
    if (layer && layer.length < 5000) {
      const old = Array.from(v.u8.subarray(addr, addr + bytes));
      layer.push([addr, old]);
    }
    return true;
  }

  function write8(addr, value, layer) {
    const v = getViews();
    if (!v || !rememberWrite(layer, addr, 1)) return false;
    v.u8[addr] = value & 0xFF;
    state.totalPokes += 1;
    return true;
  }

  function write16(addr, value, layer) {
    const v = getViews();
    if (!v || (addr & 1) || !rememberWrite(layer, addr, 2)) return false;
    v.u16[addr >> 1] = value & 0xFFFF;
    state.totalPokes += 1;
    return true;
  }

  function writeFloat(addr, value, layer) {
    const v = getViews();
    if (!v || (addr & 3) || !rememberWrite(layer, addr, 4)) return false;
    v.f32[addr >> 2] = value;
    state.totalPokes += 1;
    return true;
  }

  function heapHash(pageAddr, pageSize = 1024) {
    const v = getViews();
    if (!v || pageAddr + pageSize >= v.u8.length) return 0;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < pageSize; i += 64) {
      h ^= v.u8[pageAddr + i];
      h = Math.imul(h, 16777619) >>> 0;
      h ^= v.u8[pageAddr + i + 17];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function scanHotPagesSlice() {
    const v = getViews();
    if (!v || !state.ready) return;
    const [start, end] = safeRange();
    const pageSize = 1024;
    const pages = Math.max(1, Math.floor((end - start) / pageSize));
    const checks = Math.min(48, pages);
    for (let i = 0; i < checks; i++) {
      const page = start + (((state.hotCursor + i) % pages) * pageSize);
      const h = heapHash(page, pageSize);
      const old = state.hotHashes.get(page);
      if (old !== undefined && old !== h) state.hotScores.set(page, (state.hotScores.get(page) || 0) + 3);
      else state.hotScores.set(page, Math.max(0, (state.hotScores.get(page) || 0) - 1));
      state.hotHashes.set(page, h);
    }
    state.hotCursor = (state.hotCursor + checks) % pages;
    if (state.hotCursor === 0 || state.hotPages.length < 24) {
      state.hotPages = Array.from(state.hotScores.entries())
        .filter(([, score]) => score > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 256)
        .map(([page]) => page);
    }
  }

  function looksLikeMario(b) {
    const v = getViews();
    if (!v || b + 0xC0 > v.u8.length || b < 0) return false;
    const health = v.u16[(b + MS_OFF.HEALTH) >> 1];
    const wedges = health >> 8;
    if (wedges < 1 || wedges > 8 || health < 0x0100 || health > 0x0880) return false;
    const lives = v.i8[b + MS_OFF.LIVES];
    if (lives < 1 || lives > 99) return false;
    const stars = v.i16[(b + MS_OFF.STARS) >> 1];
    if (stars < 0 || stars > 120) return false;
    const coins = v.i16[(b + MS_OFF.COINS) >> 1];
    if (coins < 0 || coins > 999) return false;
    const action = v.u32[(b + MS_OFF.ACTION) >> 2];
    if (action < 0x40) return false;
    const x = v.f32[(b + MS_OFF.POS_X) >> 2];
    const y = v.f32[(b + MS_OFF.POS_Y) >> 2];
    const z = v.f32[(b + MS_OFF.POS_Z) >> 2];
    if (!(finite(x) && finite(y) && finite(z))) return false;
    if (Math.abs(x) > 25000 || Math.abs(y) > 25000 || Math.abs(z) > 25000) return false;
    if (Math.abs(x) < 1 && Math.abs(z) < 1) return false;
    const speed = v.f32[(b + MS_OFF.FWD_VEL) >> 2];
    if (!finite(speed) || Math.abs(speed) > 350) return false;
    return true;
  }

  function scanMarioSlice(force = false) {
    const now = performance.now();
    if (!force && now - state.lastMarioScan < 500) return state.marioBase;
    state.lastMarioScan = now;
    if (state.marioBase !== -1 && looksLikeMario(state.marioBase)) return state.marioBase;
    const v = getViews();
    if (!v) return -1;
    const end = Math.min(v.u8.length - 0xC0, 0x4000000);
    const stepBudget = force ? 0x400000 : 0x180000;
    const stop = Math.min(end, state.marioScanCursor + stepBudget);
    for (let b = Math.max(0x400, state.marioScanCursor); b < stop; b += 4) {
      if (looksLikeMario(b)) {
        state.marioBase = b;
        state.lastTargetLabel = `MarioState ${hex(b)}`;
        runnerLog(`MarioState candidate locked at ${hex(b)}.`, 'good');
        return b;
      }
    }
    state.marioScanCursor = stop >= end ? 0x400 : stop;
    return -1;
  }

  function randomHeapAddr(preferHot = true) {
    const v = getViews();
    if (!v) return -1;
    if (preferHot && state.settings.smartGuard && state.hotPages.length && chance(0.75)) {
      const page = pick(state.hotPages);
      return page + randInt(900);
    }
    const [start, end] = safeRange();
    return start + randInt(Math.max(1, end - start - 8));
  }

  function corruptByte(addr, mode, layer) {
    const v = getViews();
    if (!v || !validAddr(addr, 1)) return false;
    const old = v.u8[addr];
    if (mode === 'bitflip') return write8(addr, old ^ (1 << randInt(8)), layer);
    if (mode === 'xor') return write8(addr, old ^ (randInt(255) || 0x55), layer);
    if (mode === 'zeroff') return write8(addr, chance(0.5) ? 0x00 : 0xFF, layer);
    if (mode === 'swap') {
      const other = randomHeapAddr(true);
      if (!validAddr(other, 1)) return false;
      const temp = v.u8[other];
      if (!rememberWrite(layer, addr, 1) || !rememberWrite(layer, other, 1)) return false;
      v.u8[addr] = temp;
      v.u8[other] = old;
      state.totalPokes += 2;
      return true;
    }
    if (mode === 'numeric' && !(addr & 3) && validAddr(addr, 4) && chance(0.35)) {
      const cur = v.f32[addr >> 2];
      if (finite(cur) && Math.abs(cur) < 100000) return writeFloat(addr, cur + ((Math.random() - 0.5) * 200), layer);
    }
    const drift = chance(0.5) ? 1 + randInt(6) : -(1 + randInt(6));
    return write8(addr, old + drift, layer);
  }

  function corruptMario(layer, intensity = 1) {
    const v = getViews();
    const b = scanMarioSlice(false);
    if (!v || b === -1) return false;
    const choices = [
      () => {
        const off = pick([MS_OFF.POS_X, MS_OFF.POS_Y, MS_OFF.POS_Z]);
        const addr = b + off;
        const cur = v.f32[addr >> 2];
        if (!finite(cur)) return false;
        const amount = (Math.random() - 0.5) * (24 + intensity * 22);
        return writeFloat(addr, clamp(cur + amount, -22000, 22000), layer);
      },
      () => {
        const addr = b + MS_OFF.FWD_VEL;
        const cur = v.f32[addr >> 2];
        if (!finite(cur)) return false;
        return writeFloat(addr, clamp(cur + (Math.random() - 0.5) * (8 + intensity * 4), -260, 260), layer);
      },
      () => {
        const addr = b + MS_OFF.FACE_YAW;
        const cur = v.u16[addr >> 1];
        return write16(addr, cur ^ (1 << randInt(15)), layer);
      },
      () => {
        const addr = b + MS_OFF.HEALTH;
        const cur = v.u16[addr >> 1];
        const delta = chance(0.5) ? 0x0100 : -0x0100;
        return write16(addr, clamp(cur + delta, 0x0100, 0x0880), layer);
      },
      () => write16(b + MS_OFF.CAP_TIMER, randInt(3000), layer),
      () => {
        const addr = b + MS_OFF.COINS;
        const cur = v.i16[addr >> 1];
        return write16(addr, clamp(cur + randInt(7) - 3, 0, 999), layer);
      },
    ];
    state.lastTargetLabel = `MarioState ${hex(b)}`;
    return pick(choices)();
  }

  function runCorruptionPass(kind = 'tick') {
    if (!state.ready) return;
    const v = getViews();
    if (!v) return;
    const s = state.settings;
    const layer = [];
    const mode = s.mode || 'tilt';
    const baseStrength = kind === 'blast' ? s.strength * 9 : s.strength;
    const hardCap = s.crashGuard ? (kind === 'blast' ? 420 : 72) : (kind === 'blast' ? 900 : 160);
    const writesWanted = clamp(Math.floor(baseStrength * (state.tilted ? 1.4 : 1)), 1, hardCap);
    const startTime = performance.now();
    let writes = 0;
    let attempts = 0;

    scanHotPagesSlice();
    scanMarioSlice(false);

    while (writes < writesWanted && attempts < writesWanted * 6) {
      attempts += 1;
      if (s.crashGuard && performance.now() - startTime > (kind === 'blast' ? 7 : 2.5)) break;
      let ok = false;
      const target = s.target || 'auto';
      if (target === 'mario') ok = corruptMario(layer, s.strength);
      else if (target === 'hot') ok = corruptByte(randomHeapAddr(true), mode, layer);
      else if (target === 'heap') ok = corruptByte(randomHeapAddr(false), mode, layer);
      else {
        const marioChance = state.marioBase !== -1 ? 0.55 : 0.16;
        ok = chance(marioChance) ? corruptMario(layer, s.strength) : corruptByte(randomHeapAddr(true), mode, layer);
      }
      if (ok) writes += 1;
    }

    if (layer.length) {
      state.lastLayer = layer;
      if (kind === 'blast') runnerLog(`Blast wrote ${layer.length} byte group(s).`, 'good');
    }
    postHeartbeat(kind === 'blast' ? 'blast' : 'alive');
  }

  function restartCorruptTimer() {
    clearInterval(state.corruptTimer);
    state.corruptTimer = 0;
    if (!state.ready || (!state.armed && !state.tilted)) return;
    const interval = Math.max(33, Math.floor(1000 / clamp(state.settings.speed, 1, 30)));
    state.corruptTimer = setInterval(() => runCorruptionPass('tick'), interval);
  }

  function arm(on) {
    state.armed = !!on;
    restartCorruptTimer();
    runnerLog(state.armed ? 'Corruptor armed.' : 'Corruptor disarmed.', state.armed ? 'good' : 'info');
    post('ack', { cmd: state.armed ? 'arm' : 'disarm' });
  }

  function tilt(on) {
    state.tilted = !!on;
    restartCorruptTimer();
    runnerLog(state.tilted ? 'Cartridge tilted. Runtime pokes are pulsing.' : 'Cartridge untilted.', state.tilted ? 'warn' : 'info');
    post('ack', { cmd: state.tilted ? 'tiltStart' : 'tiltStop' });
  }

  function panic() {
    clearInterval(state.corruptTimer);
    state.corruptTimer = 0;
    state.armed = false;
    state.tilted = false;
    if (state.snapshot) restoreSnapshot(false);
    runnerLog('Panic handled in runner: corruption timers stopped.', 'warn');
    post('ack', { cmd: 'panic' });
    postHeartbeat('panic');
  }

  function takeSnapshot() {
    const v = getViews();
    if (!v) return;
    try {
      state.snapshot = new Uint8Array(v.u8);
      state.snapshotTime = Date.now();
      runnerLog(`Snapshot captured (${(state.snapshot.length / 1048576).toFixed(1)} MiB).`, 'good');
      post('ack', { cmd: 'snapshot' });
      postHeartbeat('snapshot');
    } catch (err) {
      runnerLog(`Snapshot failed: ${err.message || err}`, 'bad');
    }
  }

  function restoreSnapshot(announce = true) {
    const v = getViews();
    if (!v || !state.snapshot) return false;
    const len = Math.min(v.u8.length, state.snapshot.length);
    v.u8.set(state.snapshot.subarray(0, len), 0);
    clearInterval(state.corruptTimer);
    state.corruptTimer = 0;
    state.armed = false;
    state.tilted = false;
    if (announce) runnerLog('Snapshot restored and corruptor stopped.', 'good');
    post('ack', { cmd: 'restore' });
    postHeartbeat('restored');
    return true;
  }

  function undoLastLayer() {
    const v = getViews();
    if (!v || !state.lastLayer.length) return;
    for (let i = state.lastLayer.length - 1; i >= 0; i--) {
      const [addr, old] = state.lastLayer[i];
      if (addr >= 0 && addr + old.length < v.u8.length) v.u8.set(old, addr);
    }
    runnerLog(`Undid last layer (${state.lastLayer.length} write group(s)).`, 'good');
    state.lastLayer = [];
    post('ack', { cmd: 'undo' });
    postHeartbeat('undo');
  }

  function postHeartbeat(label = 'alive') {
    const v = getViews();
    post('heartbeat', {
      state: label,
      heapBytes: v ? v.u8.length : 0,
      target: state.marioBase !== -1 ? state.lastTargetLabel : (state.hotPages.length ? `hot RAM ${state.hotPages.length} pages` : 'scanning heap'),
      totalPokes: state.totalPokes,
      hasSnapshot: !!state.snapshot,
      hasUndo: !!state.lastLayer.length,
      armed: state.armed,
      tilted: state.tilted,
    });
  }

  function installModule(wasmBinary, wasmName) {
    if (state.booted) {
      runnerLog('This runner already booted. Recreate the runner to boot again.', 'bad');
      return;
    }
    state.booted = true;
    setOverlay(`Booting ${wasmName || 'sm64.wasm'}…`);
    status('Runner booting…', 'idle');
    window.Module = {
      canvas,
      wasmBinary: new Uint8Array(wasmBinary),
      noInitialRun: false,
      locateFile(path) {
        const name = String(path || '').replace(/\\/g, '/').split('/').pop();
        if (name && name.endsWith('.wasm')) return './sm64.wasm';
        return path;
      },
      print(text) { if (text) runnerLog(String(text)); },
      printErr(text) { if (text) runnerLog(String(text), 'bad'); },
      setStatus(text) { if (text) status(String(text), 'idle'); },
      onAbort(what) { post('crash', { message: `abort: ${what}` }); },
      onRuntimeInitialized() {
        state.ready = true;
        getViews();
        scanHotPagesSlice();
        scanMarioSlice(true);
        setOverlay('Running', true);
        status('Runner ready', 'ready');
        post('ready', {});
        clearInterval(state.heartbeatTimer);
        clearInterval(state.hotTimer);
        state.heartbeatTimer = setInterval(() => postHeartbeat('alive'), 500);
        state.hotTimer = setInterval(scanHotPagesSlice, 220);
        canvas.focus();
      },
    };
    const script = document.createElement('script');
    script.src = './sm64.js';
    script.async = true;
    script.onload = () => { state.scriptLoaded = true; runnerLog('sm64.js loaded inside runner.', 'good'); };
    script.onerror = () => post('crash', { message: 'Could not load ./sm64.js' });
    document.body.appendChild(script);
  }

  function handleMessage(event) {
    const data = event.data || {};
    if (data.source !== 'cartritilt64-supervisor') return;
    if (data.session) session = data.session;
    const payload = data.payload || {};
    try {
      if (data.cmd === 'boot') {
        mergeSettings(payload.settings || {});
        installModule(payload.wasmBinary, payload.wasmName);
      } else if (data.cmd === 'settings') mergeSettings(payload);
      else if (data.cmd === 'arm') { mergeSettings(payload.settings || {}); arm(true); }
      else if (data.cmd === 'disarm') arm(false);
      else if (data.cmd === 'tiltStart') { mergeSettings(payload.settings || {}); tilt(true); }
      else if (data.cmd === 'tiltStop') tilt(false);
      else if (data.cmd === 'blast') { mergeSettings(payload.settings || {}); runCorruptionPass('blast'); post('ack', { cmd: 'blast' }); }
      else if (data.cmd === 'panic') panic();
      else if (data.cmd === 'snapshot') takeSnapshot();
      else if (data.cmd === 'restore') restoreSnapshot(true);
      else if (data.cmd === 'undo') undoLastLayer();
      else if (data.cmd === 'focus') { canvas.focus(); post('ack', { cmd: 'focus' }); }
    } catch (err) {
      post('crash', { message: err && (err.message || String(err)) || 'runner command error', cmd: data.cmd });
    }
  }

  window.addEventListener('message', handleMessage);
  post('hello', { href: location.href });
  setInterval(() => { if (!state.ready) post('heartbeat', { state: 'waiting', totalPokes: state.totalPokes, hasSnapshot: false, hasUndo: false }); }, 1000);
})();

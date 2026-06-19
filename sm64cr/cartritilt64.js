(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const DEFAULT_WASM = "./sm64.wasm";
  const SETTINGS_KEY = "cartritilt64.pro.settings.v1";
  const POLLEN_KEY = "cartritilt64.pollen.userKey";
  const APP_KEY = "cartritilt64.pollen.appKey";
  const POLLEN_AUTH = "https://enter.pollinations.ai/authorize";
  const POLLEN_API = "https://gen.pollinations.ai/v1/chat/completions";

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

  const ui = {
    canvas: $("canvas"), shell: $("screenShell"), overlay: $("bootOverlay"), env: $("envNote"),
    status: $("runtimeStatus"), light: $("runtimeLight"), log: $("log"),
    bootDefault: $("bootDefaultBtn"), wasmFile: $("wasmFile"), reload: $("reloadBtn"),
    focus: $("focusBtn"), fullscreen: $("fullscreenBtn"),
    arm: $("armBtn"), blast: $("blastBtn"), tilt: $("tiltBtn"), panic: $("panicBtn"),
    probe: $("probeBtn"), undo: $("undoBtn"), snapshot: $("snapshotBtn"), restore: $("restoreBtn"),
    preset: $("presetSelect"), target: $("targetSelect"), mode: $("modeSelect"), strength: $("strength"),
    speed: $("speed"), writeCap: $("writeCap"), start: $("rangeStart"), end: $("rangeEnd"),
    crashGuard: $("crashGuard"), protectRuntime: $("protectRuntime"), hotOnly: $("hotOnly"), autoSnapshot: $("autoSnapshot"),
    strengthOut: $("strengthOut"), speedOut: $("speedOut"), capOut: $("capOut"), rangeOut: $("rangeOut"),
    heapStat: $("heapStat"), marioStat: $("marioStat"), hotStat: $("hotStat"), pokeCount: $("pokeCount"),
    pollenAuth: $("pollenAuthBtn"), pollenKey: $("pollenKey"), pollenSave: $("pollenSaveBtn"),
    appKey: $("appKey"), aiModel: $("aiModel"), aiPrompt: $("aiPrompt"), aiVision: $("aiVision"), aiUnsafe: $("aiUnsafe"),
    aiPlan: $("aiPlanBtn"), aiApply: $("aiApplyBtn"), aiOut: $("aiPlanOut"),
    stateName: $("stateName"), saveState: $("saveStateBtn"), stateList: $("stateList"),
  };

  const state = {
    booted: false,
    ready: false,
    armed: false,
    timer: 0,
    totalWrites: 0,
    lastLayer: [],
    quickSnapshot: null,
    heapStates: [],
    bootTime: 0,
    marioBase: -1,
    marioScanAt: 0,
    marioScanCursor: 0x400,
    hotPages: [],
    prevPageHashes: new Map(),
    lastProbeAt: 0,
    lastPlan: null,
    selectedWasm: null,
  };

  const rand = (n) => Math.floor(Math.random() * Math.max(1, n));
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const now = () => performance.now();

  function heap() { return window.Module && window.Module.HEAPU8 ? window.Module.HEAPU8 : null; }
  function H8() { return window.Module && window.Module.HEAP8; }
  function H16() { return window.Module && window.Module.HEAP16; }
  function HU16() { return window.Module && window.Module.HEAPU16; }
  function HU32() { return window.Module && window.Module.HEAPU32; }
  function HF32() { return window.Module && window.Module.HEAPF32; }

  function fmtBytes(bytes) {
    if (!bytes) return "—";
    const u = ["B", "KiB", "MiB", "GiB"];
    let v = bytes, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i && v < 10 ? 1 : 0)} ${u[i]}`;
  }

  function log(msg, kind = "info") {
    if (!ui.log) return;
    const tag = kind === "bad" ? "ERR" : kind === "good" ? "OK" : kind === "warn" ? "WARN" : "INFO";
    const lines = (ui.log.textContent + `[${new Date().toLocaleTimeString()}] ${tag} ${msg}\n`).split("\n");
    ui.log.textContent = lines.slice(-9).join("\n");
  }

  function setStatus(msg, tone = "idle") {
    ui.status.textContent = msg;
    ui.light.className = `dot ${tone}`;
  }

  function syncOutputs() {
    let s = Number(ui.start.value), e = Number(ui.end.value);
    if (s >= e) {
      if (document.activeElement === ui.start) e = clamp(s + 1, 1, 100);
      else s = clamp(e - 1, 0, 99);
      ui.start.value = String(s); ui.end.value = String(e);
    }
    ui.strengthOut.value = ui.strength.value;
    ui.speedOut.value = `${ui.speed.value}/s`;
    ui.capOut.value = ui.writeCap.value;
    ui.rangeOut.value = `${ui.start.value}–${ui.end.value}%`;
    saveSettings();
  }

  function saveSettings() {
    const data = {
      preset: ui.preset.value, target: ui.target.value, mode: ui.mode.value,
      strength: ui.strength.value, speed: ui.speed.value, cap: ui.writeCap.value,
      start: ui.start.value, end: ui.end.value,
      crashGuard: ui.crashGuard.checked, protectRuntime: ui.protectRuntime.checked,
      hotOnly: ui.hotOnly.checked, autoSnapshot: ui.autoSnapshot.checked,
      aiModel: ui.aiModel.value, appKey: ui.appKey.value.trim(),
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch {}
  }

  function loadSettings() {
    try {
      const data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      for (const [key, el] of Object.entries({ preset: ui.preset, target: ui.target, mode: ui.mode, strength: ui.strength, speed: ui.speed, cap: ui.writeCap, start: ui.start, end: ui.end, aiModel: ui.aiModel })) {
        if (data[key] !== undefined && el) el.value = String(data[key]);
      }
      for (const [key, el] of Object.entries({ crashGuard: ui.crashGuard, protectRuntime: ui.protectRuntime, hotOnly: ui.hotOnly, autoSnapshot: ui.autoSnapshot })) {
        if (typeof data[key] === "boolean") el.checked = data[key];
      }
      ui.appKey.value = data.appKey || localStorage.getItem(APP_KEY) || "";
      const savedKey = localStorage.getItem(POLLEN_KEY);
      if (savedKey) ui.pollenKey.placeholder = "saved user key loaded";
    } catch {}
  }

  function applyPreset(name) {
    if (name === "manual") return;
    const p = {
      safe:   { strength: 3, speed: 2, cap: 8,  mode: "nudges", target: "auto", guard: true, hot: true, range: [22, 82] },
      medium: { strength: 6, speed: 4, cap: 18, mode: "bitflip", target: "auto", guard: true, hot: true, range: [18, 88] },
      wild:   { strength: 10, speed: 7, cap: 34, mode: "xor", target: "hot", guard: true, hot: true, range: [12, 94] },
    }[name];
    if (!p) return;
    ui.strength.value = p.strength; ui.speed.value = p.speed; ui.writeCap.value = p.cap;
    ui.mode.value = p.mode; ui.target.value = p.target; ui.crashGuard.checked = p.guard; ui.hotOnly.checked = p.hot;
    ui.start.value = p.range[0]; ui.end.value = p.range[1]; syncOutputs();
  }

  function enableRuntime(enabled) {
    [ui.arm, ui.blast, ui.tilt, ui.panic, ui.probe, ui.snapshot].forEach(b => b.disabled = !enabled);
    ui.restore.disabled = !(enabled && state.quickSnapshot);
    ui.saveState.disabled = !enabled;
    ui.undo.disabled = !(enabled && state.lastLayer.length);
  }

  function bootWith(opts = {}) {
    if (state.booted) { log("Already booted. Use Reload to start fresh.", "warn"); return; }
    state.booted = true;
    state.bootTime = Date.now();
    setStatus("Booting…", "idle");

    window.Module = {
      canvas: ui.canvas,
      noInitialRun: false,
      locateFile(path, prefix) {
        return String(path).endsWith(".wasm") ? (opts.wasmUrl || DEFAULT_WASM) : `${prefix || ""}${path}`;
      },
      setStatus(text) { if (text) setStatus(String(text), "idle"); },
      print(text) { log(String(text)); },
      printErr(text) { log(String(text), "warn"); },
      onAbort(reason) {
        stopCorruptor();
        setStatus("Runtime aborted", "bad");
        log(`Runtime aborted: ${reason}`, "bad");
      },
      onRuntimeInitialized() {
        state.ready = true;
        ui.overlay.classList.add("hidden");
        setStatus(`Ready — heap ${fmtBytes(heap()?.byteLength)}`, "ready");
        enableRuntime(true);
        updateStats();
        setInterval(lightProbe, 2200);
        setTimeout(() => probeAll(false), 800);
        log("SM64 initialized. Defaults are capped so it should glitch before it dies.", "good");
      }
    };
    if (opts.wasmBinary) window.Module.wasmBinary = opts.wasmBinary;

    const script = document.createElement("script");
    script.src = "./sm64.js";
    script.async = true;
    script.onerror = () => { setStatus("Missing ./sm64.js", "bad"); log("Put sm64.js beside index.html.", "bad"); };
    document.body.appendChild(script);
  }

  function bootDefault() {
    if (location.protocol === "file:") {
      setStatus("Pick a WASM file", "warn");
      log("file:// pages usually cannot fetch ./sm64.wasm. Pick the file instead.", "warn");
      return;
    }
    bootWith({ wasmUrl: DEFAULT_WASM });
  }

  async function bootPicked(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".wasm")) { log("That is not a .wasm file.", "bad"); return; }
    const buf = await file.arrayBuffer();
    bootWith({ wasmUrl: file.name, wasmBinary: buf });
  }

  function heapRange() {
    const u8 = heap();
    if (!u8) return [0, 0];
    let start = Math.floor(u8.length * Number(ui.start.value) / 100);
    let end = Math.floor(u8.length * Number(ui.end.value) / 100);
    if (ui.protectRuntime.checked) start = Math.max(start, Math.min(u8.length - 4096, Math.floor(u8.length * 0.14)));
    if (end <= start) end = Math.min(u8.length, start + 4096);
    return [start, end];
  }

  function checksumPage(u8, base, size = 4096) {
    let h = 2166136261 >>> 0;
    const end = Math.min(u8.length, base + size);
    for (let i = base; i < end; i += 64) {
      h ^= u8[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function lightProbe() {
    if (!state.ready) return;
    const u8 = heap();
    if (!u8) return;
    const [start, end] = heapRange();
    const page = 4096;
    const pages = Math.max(1, Math.floor((end - start) / page));
    const samples = ui.crashGuard.checked ? 28 : 80;
    const changed = [];
    for (let i = 0; i < samples; i++) {
      const p = start + rand(pages) * page;
      const h = checksumPage(u8, p, page);
      const old = state.prevPageHashes.get(p);
      if (old !== undefined && old !== h) changed.push(p);
      state.prevPageHashes.set(p, h);
    }
    if (changed.length) {
      state.hotPages = Array.from(new Set(changed.concat(state.hotPages))).slice(0, 96);
    }
    if (Date.now() - state.marioScanAt > 2500) scanMarioBudgeted(4);
    updateStats();
  }

  async function probeAll(verbose = true) {
    if (!state.ready) return;
    for (let i = 0; i < 5; i++) {
      lightProbe();
      scanMarioBudgeted(6);
      await new Promise(requestAnimationFrame);
    }
    if (verbose) log(`Probe complete: ${state.hotPages.length} hot pages, MarioState ${state.marioBase >= 0 ? "found" : "not found yet"}.`, state.marioBase >= 0 ? "good" : "warn");
    updateStats();
  }

  function looksLikeMario(b) {
    const u8 = heap(), f = HF32(), u16 = HU16(), i16 = H16(), i8 = H8(), u32 = HU32();
    if (!u8 || !f || !u16 || !i16 || !i8 || !u32 || b + 0xC0 > u8.length) return false;
    const health = u16[(b + MS_OFF.HEALTH) >> 1];
    const wedges = health >> 8;
    if (wedges < 1 || wedges > 8 || health < 0x0100 || health > 0x0880) return false;
    const lives = i8[b + MS_OFF.LIVES];
    if (lives < 1 || lives > 99) return false;
    const stars = i16[(b + MS_OFF.STARS) >> 1], coins = i16[(b + MS_OFF.COINS) >> 1];
    if (stars < 0 || stars > 120 || coins < 0 || coins > 999) return false;
    const action = u32[(b + MS_OFF.ACTION) >> 2];
    if (action < 0x40) return false;
    const x = f[(b + MS_OFF.POS_X) >> 2], y = f[(b + MS_OFF.POS_Y) >> 2], z = f[(b + MS_OFF.POS_Z) >> 2], v = f[(b + MS_OFF.FWD_VEL) >> 2];
    if (![x, y, z, v].every(Number.isFinite)) return false;
    if (Math.abs(x) > 30000 || Math.abs(y) > 30000 || Math.abs(z) > 30000 || Math.abs(v) > 500) return false;
    if (Math.abs(x) < 1 && Math.abs(z) < 1) return false;
    return true;
  }

  function scanMarioBudgeted(msBudget = 5) {
    const u8 = heap();
    if (!u8) return -1;
    state.marioScanAt = Date.now();
    if (state.marioBase >= 0 && looksLikeMario(state.marioBase)) return state.marioBase;
    const end = Math.min(u8.length - 0xC0, 0x4000000);
    const t0 = now();
    let b = state.marioScanCursor || 0x400;
    for (; b < end; b += 4) {
      if (looksLikeMario(b)) {
        state.marioBase = b;
        state.marioScanCursor = b;
        log(`MarioState candidate locked @ 0x${b.toString(16)}.`, "good");
        return b;
      }
      if (now() - t0 > msBudget) break;
    }
    state.marioScanCursor = b >= end ? 0x400 : b;
    state.marioBase = -1;
    return -1;
  }

  function readMario() {
    const b = state.marioBase;
    if (b < 0 || !looksLikeMario(b)) return null;
    try {
      const f = HF32(), u16 = HU16(), i16 = H16(), i8 = H8(), u32 = HU32();
      return {
        base: b,
        x: f[(b + MS_OFF.POS_X) >> 2], y: f[(b + MS_OFF.POS_Y) >> 2], z: f[(b + MS_OFF.POS_Z) >> 2],
        speed: f[(b + MS_OFF.FWD_VEL) >> 2], yaw: i16[(b + MS_OFF.FACE_YAW) >> 1],
        health: u16[(b + MS_OFF.HEALTH) >> 1], coins: i16[(b + MS_OFF.COINS) >> 1],
        stars: i16[(b + MS_OFF.STARS) >> 1], lives: i8[b + MS_OFF.LIVES], action: u32[(b + MS_OFF.ACTION) >> 2],
      };
    } catch { return null; }
  }

  function updateStats() {
    const u8 = heap();
    ui.heapStat.textContent = fmtBytes(u8?.byteLength);
    const m = readMario();
    ui.marioStat.textContent = m ? `0x${m.base.toString(16)} · ${m.lives} lives` : (state.marioBase >= 0 ? "stale" : "searching");
    ui.hotStat.textContent = String(state.hotPages.length);
    ui.pokeCount.textContent = String(state.totalWrites);
    ui.undo.disabled = !(state.ready && state.lastLayer.length);
    ui.restore.disabled = !(state.ready && state.quickSnapshot);
  }

  function recordBytes(addr, len, layer) {
    const u8 = heap();
    if (!u8 || addr < 0 || addr + len > u8.length) return null;
    const old = Array.from(u8.slice(addr, addr + len));
    layer.push({ addr, old });
    return old;
  }

  function writeByte(addr, value, layer) {
    const u8 = heap();
    if (!u8 || addr < 0 || addr >= u8.length) return false;
    recordBytes(addr, 1, layer);
    u8[addr] = value & 255;
    state.totalWrites++;
    return true;
  }

  function writeI16(addr, value, layer) {
    const i16 = H16();
    if (!i16 || addr < 0 || addr + 2 > heap().length) return false;
    recordBytes(addr, 2, layer);
    i16[addr >> 1] = value | 0;
    state.totalWrites++;
    return true;
  }

  function writeU16(addr, value, layer) {
    const u16 = HU16();
    if (!u16 || addr < 0 || addr + 2 > heap().length) return false;
    recordBytes(addr, 2, layer);
    u16[addr >> 1] = clamp(value | 0, 0, 65535);
    state.totalWrites++;
    return true;
  }

  function writeF32(addr, value, layer) {
    const f = HF32();
    if (!f || addr < 0 || addr + 4 > heap().length || !Number.isFinite(value)) return false;
    recordBytes(addr, 4, layer);
    f[addr >> 2] = value;
    state.totalWrites++;
    return true;
  }

  function pickHeapAddr(aligned = 1) {
    const u8 = heap();
    if (!u8) return -1;
    if (ui.hotOnly.checked && state.hotPages.length && (ui.target.value === "hot" || ui.target.value === "auto")) {
      const page = state.hotPages[rand(state.hotPages.length)];
      return (page + rand(4096 - aligned)) & ~(aligned - 1);
    }
    const [start, end] = heapRange();
    return (start + rand(Math.max(aligned, end - start - aligned))) & ~(aligned - 1);
  }

  function marioNudge(layer, intensity = 1) {
    const m = readMario();
    if (!m) return false;
    const b = m.base;
    const options = ["speed", "yaw", "x", "y", "z", "cap", "health"];
    const field = options[rand(options.length)];
    const n = intensity;
    if (field === "speed") return writeF32(b + MS_OFF.FWD_VEL, clamp(m.speed + (Math.random() - 0.35) * 2.5 * n, -120, 180), layer);
    if (field === "yaw") return writeI16(b + MS_OFF.FACE_YAW, (m.yaw + rand(6000 * n) - 3000 * n) | 0, layer);
    if (field === "x") return writeF32(b + MS_OFF.POS_X, clamp(m.x + (Math.random() - 0.5) * 18 * n, -25000, 25000), layer);
    if (field === "y") return writeF32(b + MS_OFF.POS_Y, clamp(m.y + Math.random() * 16 * n, -10000, 30000), layer);
    if (field === "z") return writeF32(b + MS_OFF.POS_Z, clamp(m.z + (Math.random() - 0.5) * 18 * n, -25000, 25000), layer);
    if (field === "cap") return writeU16(b + MS_OFF.CAP_TIMER, rand(900), layer);
    if (field === "health") return writeU16(b + MS_OFF.HEALTH, [0x0880, 0x0780, 0x0680, 0x0480][rand(4)], layer);
    return false;
  }

  function randomFloatDrift(layer, intensity = 1) {
    const u8 = heap(), f = HF32();
    if (!u8 || !f) return false;
    let addr = -1, value = 0;
    for (let tries = 0; tries < 10; tries++) {
      addr = pickHeapAddr(4);
      value = f[addr >> 2];
      if (Number.isFinite(value) && Math.abs(value) > 0.001 && Math.abs(value) < 20000) break;
    }
    if (addr < 0 || !Number.isFinite(value) || Math.abs(value) > 20000) return false;
    const factor = 1 + (Math.random() - 0.5) * 0.08 * intensity;
    return writeF32(addr, clamp(value * factor + (Math.random() - 0.5) * intensity, -30000, 30000), layer);
  }

  function corruptOnce(layer, mode = ui.mode.value, intensity = Number(ui.strength.value)) {
    const u8 = heap();
    if (!u8) return false;
    const target = ui.target.value;
    if ((target === "mario" || target === "auto") && Math.random() < 0.68) {
      if (marioNudge(layer, Math.max(1, intensity / 4))) return true;
    }
    if (mode === "float") return randomFloatDrift(layer, Math.max(1, intensity / 5));
    let addr = pickHeapAddr(mode === "swap" ? 1 : 1);
    if (addr < 0) return false;
    const old = u8[addr];
    if (mode === "bitflip") return writeByte(addr, old ^ (1 << rand(ui.crashGuard.checked ? 4 : 8)), layer);
    if (mode === "xor") return writeByte(addr, old ^ (1 + rand(ui.crashGuard.checked ? 15 : 255)), layer);
    if (mode === "swap") {
      const addr2 = clamp(addr + (Math.random() < 0.5 ? 1 : -1), 0, u8.length - 1);
      const a = u8[addr], b = u8[addr2];
      writeByte(addr, b, layer); writeByte(addr2, a, layer); return true;
    }
    if (mode === "zeroff") return writeByte(addr, Math.random() < 0.5 ? 0 : 255, layer);
    return writeByte(addr, clamp(old + rand(7) - 3, 0, 255), layer);
  }

  function safeWriteBudget(multiplier = 1) {
    const strength = Number(ui.strength.value);
    const cap = Number(ui.writeCap.value);
    const guardCap = ui.crashGuard.checked ? 28 : 256;
    const warm = Date.now() - state.bootTime > 9000;
    const earlyCap = warm || !ui.crashGuard.checked ? guardCap : 8;
    return clamp(Math.round(Math.min(cap, strength * multiplier, earlyCap)), 1, ui.aiUnsafe.checked ? 512 : 256);
  }

  function applyBlast(multiplier = 1, mode = ui.mode.value) {
    if (!state.ready) return;
    if (ui.autoSnapshot.checked && !state.quickSnapshot) takeSnapshot(false);
    lightProbe();
    const layer = [];
    const count = safeWriteBudget(multiplier);
    let ok = 0;
    for (let i = 0; i < count; i++) if (corruptOnce(layer, mode, Number(ui.strength.value))) ok++;
    if (ok) {
      state.lastLayer = layer;
      log(`Applied ${ok} write${ok === 1 ? "" : "s"}.`, ok > 24 ? "warn" : "good");
    } else {
      log("No live target found; probe or enter gameplay first.", "warn");
    }
    updateStats();
  }

  function startCorruptor() {
    if (!state.ready) return;
    if (state.armed) { stopCorruptor(); return; }
    state.armed = true;
    ui.arm.textContent = "Disarm";
    setStatus("Armed", "warn");
    const tick = () => {
      if (!state.armed) return;
      applyBlast(0.45);
      state.timer = window.setTimeout(tick, 1000 / clamp(Number(ui.speed.value), 1, 20));
    };
    tick();
  }

  function stopCorruptor() {
    state.armed = false;
    ui.arm.textContent = "Arm";
    if (state.timer) clearTimeout(state.timer);
    state.timer = 0;
    if (state.ready) setStatus("Ready", "ready");
  }

  function tiltPulse() {
    if (!state.ready) return;
    stopCorruptor();
    let pulses = ui.crashGuard.checked ? 5 : 12;
    const mode = ui.mode.value === "nudges" ? "float" : ui.mode.value;
    const run = () => {
      if (pulses-- <= 0) { setStatus("Ready", "ready"); return; }
      applyBlast(0.8, mode);
      setStatus("Tilt pulse", "warn");
      setTimeout(run, ui.crashGuard.checked ? 140 : 70);
    };
    run();
  }

  function undoLast() {
    const u8 = heap();
    if (!u8 || !state.lastLayer.length) return;
    for (let i = state.lastLayer.length - 1; i >= 0; i--) {
      const r = state.lastLayer[i];
      if (r.addr >= 0 && r.addr + r.old.length <= u8.length) u8.set(r.old, r.addr);
    }
    log(`Undid ${state.lastLayer.length} recorded write(s).`, "good");
    state.lastLayer = [];
    updateStats();
  }

  function panic() {
    stopCorruptor();
    undoLast();
    setStatus("Panic stopped", "warn");
    log("Panic: stopped loop and undid last layer. Reload if the game itself is already wedged.", "warn");
  }

  function takeSnapshot(verbose = true) {
    const u8 = heap();
    if (!u8) return false;
    try {
      state.quickSnapshot = new Uint8Array(u8);
      ui.restore.disabled = false;
      if (verbose) log(`Quick snapshot saved (${fmtBytes(u8.length)}).`, "good");
      return true;
    } catch (e) {
      log(`Snapshot failed: ${e.message}`, "bad");
      return false;
    }
  }

  function restoreSnapshot() {
    const u8 = heap();
    if (!u8 || !state.quickSnapshot) return;
    if (state.quickSnapshot.length !== u8.length) { log("Snapshot size mismatch after heap change.", "bad"); return; }
    stopCorruptor();
    u8.set(state.quickSnapshot);
    log("Quick snapshot restored.", "good");
    updateStats();
  }

  function saveNamedState() {
    const u8 = heap();
    if (!u8) return;
    const name = (ui.stateName.value || `State ${state.heapStates.length + 1}`).trim().slice(0, 28);
    try {
      state.heapStates.unshift({ name, time: new Date(), bytes: new Uint8Array(u8) });
      state.heapStates = state.heapStates.slice(0, 3);
      ui.stateName.value = "";
      renderStates();
      log(`Saved state: ${name}.`, "good");
    } catch (e) {
      log(`Save state failed: ${e.message}`, "bad");
    }
  }

  function restoreNamedState(index) {
    const u8 = heap();
    const s = state.heapStates[index];
    if (!u8 || !s) return;
    stopCorruptor();
    if (s.bytes.length !== u8.length) { log("State size mismatch.", "bad"); return; }
    u8.set(s.bytes);
    log(`Restored state: ${s.name}.`, "good");
  }

  function renderStates() {
    if (!state.heapStates.length) { ui.stateList.innerHTML = `<span class="empty">No states yet.</span>`; return; }
    ui.stateList.innerHTML = "";
    state.heapStates.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "stateRow";
      row.innerHTML = `<div><strong></strong><small>${s.time.toLocaleTimeString()} · ${fmtBytes(s.bytes.length)}</small></div><button type="button">Load</button><button type="button">X</button>`;
      row.querySelector("strong").textContent = s.name;
      row.children[1].onclick = () => restoreNamedState(i);
      row.children[2].onclick = () => { state.heapStates.splice(i, 1); renderStates(); };
      ui.stateList.appendChild(row);
    });
  }

  function readTelemetry() {
    const m = readMario();
    return {
      heapBytes: heap()?.byteLength || 0,
      marioState: m ? {
        baseHex: `0x${m.base.toString(16)}`,
        position: [Math.round(m.x), Math.round(m.y), Math.round(m.z)],
        speed: Math.round(m.speed * 10) / 10,
        healthHex: `0x${m.health.toString(16)}`,
        coins: m.coins, stars: m.stars, lives: m.lives,
        actionHex: `0x${(m.action >>> 0).toString(16)}`,
      } : null,
      hotPages: state.hotPages.slice(0, 16).map(p => `0x${p.toString(16)}`),
      settings: { target: ui.target.value, mode: ui.mode.value, crashGuard: ui.crashGuard.checked, cap: Number(ui.writeCap.value) },
    };
  }

  function screenshotDataUrl() {
    try {
      const c = document.createElement("canvas");
      c.width = 320; c.height = 240;
      c.getContext("2d").drawImage(ui.canvas, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.55);
    } catch (e) {
      log(`Screenshot capture failed: ${e.message}`, "warn");
      return null;
    }
  }

  function parseReturnedJson(text) {
    const clean = String(text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    try { return JSON.parse(clean); } catch {}
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("AI did not return JSON.");
  }

  function getPollenKey() {
    return ui.pollenKey.value.trim() || localStorage.getItem(POLLEN_KEY) || "";
  }

  async function requestAiPlan(apply = false) {
    const key = getPollenKey();
    if (!key) { log("Connect Pollen or paste a user key first.", "warn"); ui.aiOut.textContent = "Missing Pollen key."; return; }
    await probeAll(false);
    const telemetry = readTelemetry();
    const prompt = ui.aiPrompt.value.trim() || "make the game look funny but keep it playable";
    const schema = `Return only JSON with this schema:
{"name":"short name","risk":"low|medium|high","explanation":"short","actions":[
 {"type":"mario","field":"speed|yaw|x|y|z|health|capTimer","op":"add|set|mul|jitter","value":number,"repeat":1-12},
 {"type":"hotpoke","mode":"nudges|bitflip|xor|float","count":1-64,"intensity":1-10},
 {"type":"saveState","name":"optional name"}
]}
Rules: no JavaScript, no code execution, no unbounded loops. Prefer mario actions when MarioState exists. For visual weirdness like big head/stretchy arms, use hotpoke float/nudges with modest count; exact body-part scaling is not guaranteed without symbols.`;

    const textContent = `You are an RTC-style corruption planner for a Super Mario 64 WASM/decomp build. User request: ${prompt}\n\nTelemetry:\n${JSON.stringify(telemetry)}\n\n${schema}`;
    let content = textContent;
    const img = ui.aiVision.checked ? screenshotDataUrl() : null;
    if (img) content = [{ type: "text", text: textContent }, { type: "image_url", image_url: { url: img } }];

    ui.aiOut.textContent = "Asking Pollinations…";
    try {
      const res = await fetch(POLLEN_API, {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Pollinations-Safe": "privacy,secrets" },
        body: JSON.stringify({ model: ui.aiModel.value, messages: [{ role: "system", content: "You generate safe bounded JSON memory-corruption plans for a web game toy." }, { role: "user", content }] })
      });
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
        throw new Error(msg);
      }
      const json = await res.json();
      const txt = json.choices?.[0]?.message?.content || "";
      const plan = parseReturnedJson(txt);
      state.lastPlan = plan;
      ui.aiOut.textContent = JSON.stringify(plan, null, 2);
      log(`AI plan ready: ${plan.name || "unnamed"}.`, "good");
      if (apply) applyAiPlan(plan);
    } catch (e) {
      ui.aiOut.textContent = `AI error: ${e.message}`;
      log(`AI error: ${e.message}`, "bad");
    }
  }

  function applyMarioAction(a, layer) {
    const m = readMario();
    if (!m) return false;
    const map = { speed: MS_OFF.FWD_VEL, yaw: MS_OFF.FACE_YAW, x: MS_OFF.POS_X, y: MS_OFF.POS_Y, z: MS_OFF.POS_Z, health: MS_OFF.HEALTH, capTimer: MS_OFF.CAP_TIMER };
    const field = map[a.field];
    if (field === undefined) return false;
    const repeat = clamp(Number(a.repeat || 1), 1, ui.aiUnsafe.checked ? 64 : 12);
    let ok = 0;
    for (let i = 0; i < repeat; i++) {
      const base = m.base + field;
      const value = Number(a.value || 0);
      if (["speed", "x", "y", "z"].includes(a.field)) {
        const f = HF32(); const old = f[base >> 2];
        let next = old;
        if (a.op === "set") next = value;
        else if (a.op === "mul") next = old * clamp(value, -8, 8);
        else if (a.op === "jitter") next = old + (Math.random() - 0.5) * Math.abs(value || 12);
        else next = old + value;
        if (writeF32(base, clamp(next, -30000, 30000), layer)) ok++;
      } else if (a.field === "yaw") {
        const old = H16()[base >> 1];
        const next = a.op === "set" ? value : old + (a.op === "jitter" ? rand(Math.abs(value || 4096)) - Math.abs(value || 4096) / 2 : value);
        if (writeI16(base, next, layer)) ok++;
      } else {
        const old = HU16()[base >> 1];
        const next = a.op === "set" ? value : old + value;
        if (writeU16(base, next, layer)) ok++;
      }
    }
    return ok > 0;
  }

  function applyAiPlan(plan = state.lastPlan) {
    if (!state.ready || !plan) return;
    if (ui.autoSnapshot.checked && !state.quickSnapshot) takeSnapshot(false);
    const layer = [];
    const maxActions = ui.aiUnsafe.checked ? 24 : 8;
    const actions = Array.isArray(plan.actions) ? plan.actions.slice(0, maxActions) : [];
    let writesBefore = state.totalWrites;
    for (const a of actions) {
      if (!a || typeof a !== "object") continue;
      if (a.type === "mario") applyMarioAction(a, layer);
      if (a.type === "hotpoke") {
        const oldTarget = ui.target.value, oldMode = ui.mode.value;
        ui.target.value = "hot";
        ui.mode.value = ["nudges", "bitflip", "xor", "float"].includes(a.mode) ? a.mode : "nudges";
        const count = clamp(Number(a.count || 4), 1, ui.aiUnsafe.checked ? 256 : 48);
        for (let i = 0; i < count; i++) corruptOnce(layer, ui.mode.value, clamp(Number(a.intensity || 3), 1, 10));
        ui.target.value = oldTarget; ui.mode.value = oldMode;
      }
      if (a.type === "saveState") {
        ui.stateName.value = String(a.name || plan.name || "AI corruption").slice(0, 28);
        saveNamedState();
      }
    }
    if (layer.length) state.lastLayer = layer;
    log(`AI applied ${state.totalWrites - writesBefore} write(s).`, "good");
    updateStats();
  }

  function handleAuthReturn() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const key = hash.get("api_key") || hash.get("access_token");
    const err = hash.get("error");
    if (err) log(`Pollen auth denied: ${err}`, "warn");
    if (key) {
      localStorage.setItem(POLLEN_KEY, key);
      ui.pollenKey.placeholder = "saved user key loaded";
      log("Pollen user key connected.", "good");
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  function connectPollen() {
    const appKey = ui.appKey.value.trim();
    if (appKey) localStorage.setItem(APP_KEY, appKey);
    const params = new URLSearchParams({
      redirect_uri: location.origin + location.pathname,
      models: "openai,openai-fast,gpt-5.5,qwen-vision,qwen-vision-pro",
      budget: "5",
      expiry: "7",
      state: Math.random().toString(36).slice(2),
    });
    if (appKey) params.set("client_id", appKey);
    location.href = `${POLLEN_AUTH}?${params}`;
  }

  function wire() {
    document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tabPanel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $(`tab-${btn.dataset.tab}`).classList.add("active");
    }));
    [ui.strength, ui.speed, ui.writeCap, ui.start, ui.end, ui.mode, ui.target, ui.crashGuard, ui.protectRuntime, ui.hotOnly, ui.autoSnapshot, ui.aiModel, ui.appKey].forEach(el => el.addEventListener("input", syncOutputs));
    ui.preset.addEventListener("change", () => applyPreset(ui.preset.value));
    ui.bootDefault.addEventListener("click", bootDefault);
    ui.wasmFile.addEventListener("change", (e) => bootPicked(e.target.files?.[0]));
    ui.reload.addEventListener("click", () => location.reload());
    ui.focus.addEventListener("click", () => ui.canvas.focus({ preventScroll: true }));
    ui.fullscreen.addEventListener("click", () => ui.shell.requestFullscreen?.());
    ui.arm.addEventListener("click", startCorruptor);
    ui.blast.addEventListener("click", () => applyBlast(1.5));
    ui.tilt.addEventListener("click", tiltPulse);
    ui.panic.addEventListener("click", panic);
    ui.probe.addEventListener("click", () => probeAll(true));
    ui.undo.addEventListener("click", undoLast);
    ui.snapshot.addEventListener("click", () => takeSnapshot(true));
    ui.restore.addEventListener("click", restoreSnapshot);
    ui.saveState.addEventListener("click", saveNamedState);
    ui.pollenSave.addEventListener("click", () => {
      const key = ui.pollenKey.value.trim();
      if (!key) return;
      localStorage.setItem(POLLEN_KEY, key);
      ui.pollenKey.value = "";
      ui.pollenKey.placeholder = "saved user key loaded";
      log("Saved Pollen user key locally in this browser.", "good");
    });
    ui.pollenAuth.addEventListener("click", connectPollen);
    ui.aiPlan.addEventListener("click", () => requestAiPlan(false));
    ui.aiApply.addEventListener("click", () => state.lastPlan ? applyAiPlan(state.lastPlan) : requestAiPlan(true));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") panic();
      if (e.key.toLowerCase() === "b" && !e.repeat && state.ready) applyBlast(1);
    });
  }

  function init() {
    ui.env.textContent = location.protocol === "file:" ? "Local file mode: pick WASM." : "Static mode: ./sm64.wasm should sit beside this page.";
    loadSettings();
    handleAuthReturn();
    syncOutputs();
    wire();
    renderStates();
    setStatus("Ready", "idle");
    window.CartriTilt64 = { probe: probeAll, readTelemetry, applyAiPlan, stop: stopCorruptor, panic, state };
  }

  init();
})();

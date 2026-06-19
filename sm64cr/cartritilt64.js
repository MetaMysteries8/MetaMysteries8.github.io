(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const DEFAULT_WASM = "./sm64.wasm";
  const SETTINGS_KEY = "cartritilt64.pro.settings.v1";
  const POLLEN_KEY = "cartritilt64.pollen.userKey";
  const APP_KEY = "cartritilt64.pollen.appKey";
  const POLLEN_AUTH = "https://enter.pollinations.ai/authorize";
  const POLLEN_BASE = "https://gen.pollinations.ai";
  const POLLEN_API = `${POLLEN_BASE}/v1/chat/completions`;
  const POLLEN_TEXT_MODELS = `${POLLEN_BASE}/text/models`;
  const POLLEN_ALL_MODELS = `${POLLEN_BASE}/models`;
  const POLLEN_ACCOUNT_BALANCE = `${POLLEN_BASE}/account/balance`;
  const POLLEN_ACCOUNT_USAGE_DAILY = `${POLLEN_BASE}/account/usage/daily`;
  const POLLEN_ACCOUNT_KEY = `${POLLEN_BASE}/account/key`;

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
    focus: $("focusBtn"), uiInput: $("uiInputBtn"), fullscreen: $("fullscreenBtn"),
    arm: $("armBtn"), blast: $("blastBtn"), tilt: $("tiltBtn"), panic: $("panicBtn"),
    probe: $("probeBtn"), undo: $("undoBtn"), snapshot: $("snapshotBtn"), restore: $("restoreBtn"),
    preset: $("presetSelect"), target: $("targetSelect"), mode: $("modeSelect"), strength: $("strength"),
    speed: $("speed"), writeCap: $("writeCap"), start: $("rangeStart"), end: $("rangeEnd"),
    crashGuard: $("crashGuard"), protectRuntime: $("protectRuntime"), hotOnly: $("hotOnly"), autoSnapshot: $("autoSnapshot"),
    strengthOut: $("strengthOut"), speedOut: $("speedOut"), capOut: $("capOut"), rangeOut: $("rangeOut"),
    heapStat: $("heapStat"), marioStat: $("marioStat"), hotStat: $("hotStat"), pokeCount: $("pokeCount"),
    checkpointStat: $("checkpointStat"), inputStat: $("inputStat"),
    pollenAuth: $("pollenAuthBtn"), pollenKey: $("pollenKey"), pollenSave: $("pollenSaveBtn"),
    modelsRefresh: $("modelsRefreshBtn"), keyCheck: $("keyCheckBtn"), accountStat: $("accountStat"), modelMeta: $("modelMeta"),
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
    checkpoints: [],
    checkpointTimer: 0,
    lastCheckpointAt: 0,
    heapStates: [],
    bootTime: 0,
    marioBase: -1,
    marioScanAt: 0,
    marioScanCursor: 0x400,
    hotPages: [],
    prevPageHashes: new Map(),
    lastProbeAt: 0,
    lastPlan: null,
    queuedPlan: null,
    selectedWasm: null,
    models: [],
    keyboardMode: "ui",
    lastWriteAt: 0,
    ramp: 0,
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
      aiModel: ui.aiModel.value, appKey: ui.appKey.value.trim(), keyboardMode: state.keyboardMode,
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
      if (data.keyboardMode) state.keyboardMode = data.keyboardMode;
      const savedKey = localStorage.getItem(POLLEN_KEY);
      if (savedKey) ui.pollenKey.placeholder = "saved user key loaded";
    } catch {}
  }

  function applyPreset(name) {
    if (name === "manual") return;
    const p = {
      safe:   { strength: 2, speed: 1, cap: 3,  mode: "nudges", target: "mario", guard: true, hot: true, range: [24, 78] },
      medium: { strength: 4, speed: 2, cap: 6, mode: "float", target: "auto", guard: true, hot: true, range: [22, 82] },
      wild:   { strength: 8, speed: 4, cap: 14, mode: "bitflip", target: "hot", guard: true, hot: true, range: [18, 88] },
    }[name];
    if (!p) return;
    ui.strength.value = p.strength; ui.speed.value = p.speed; ui.writeCap.value = p.cap;
    ui.mode.value = p.mode; ui.target.value = p.target; ui.crashGuard.checked = p.guard; ui.hotOnly.checked = p.hot;
    ui.start.value = p.range[0]; ui.end.value = p.range[1]; syncOutputs();
  }

  function enableRuntime(enabled) {
    [ui.arm, ui.blast, ui.tilt, ui.panic, ui.probe, ui.snapshot].forEach(b => b.disabled = !enabled);
    ui.restore.disabled = !(enabled && (state.quickSnapshot || state.checkpoints.length));
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
        if (!state.checkpointTimer) state.checkpointTimer = setInterval(() => maybeAutoCheckpoint("auto"), 5000);
        setTimeout(() => { probeAll(false); createCheckpoint("boot stable", "boot", true); }, 900);
        if (state.queuedPlan) log("AI plan is queued. Press Apply/Queue after gameplay starts to apply it.", "warn");
        log("SM64 initialized. Corruption now uses staged, domain-safe writes by default.", "good");
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
    if (ui.checkpointStat) ui.checkpointStat.textContent = String((state.checkpoints?.length || 0) + (state.heapStates?.length || 0));
    if (ui.inputStat) ui.inputStat.textContent = state.keyboardMode === "game" ? "Game" : "UI";
    ui.undo.disabled = !(state.ready && state.lastLayer.length);
    ui.restore.disabled = !(state.ready && (state.checkpoints.length || state.quickSnapshot));
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
    const tries = ui.crashGuard.checked ? 24 : 64;
    for (let t = 0; t < tries; t++) {
      addr = pickHeapAddr(4);
      if (addr < 0 || addr + 4 > u8.length) continue;
      value = f[addr >> 2];
      // Only drift floats that look like live gameplay numbers, not pointers/NaNs/code-ish data.
      if (Number.isFinite(value) && Math.abs(value) > 0.002 && Math.abs(value) < 12000) break;
      addr = -1;
    }
    if (addr < 0) return false;
    const tiny = ui.crashGuard.checked ? 0.012 : 0.035;
    const factor = 1 + (Math.random() - 0.5) * tiny * clamp(intensity, 1, 8);
    const add = (Math.random() - 0.5) * clamp(intensity, 1, 8) * (ui.crashGuard.checked ? 0.35 : 1.25);
    return writeF32(addr, clamp(value * factor + add, -18000, 18000), layer);
  }

  function softByteNudge(layer, intensity = 1) {
    const u8 = heap();
    if (!u8) return false;
    const addr = pickHeapAddr(1);
    if (addr < 0) return false;
    const old = u8[addr];
    // Tiny drift beats destructive byte chaos in WASM. It makes effects visible without smashing pointers as often.
    const delta = rand(ui.crashGuard.checked ? 3 : 9) - (ui.crashGuard.checked ? 1 : 4);
    if (delta === 0) return false;
    return writeByte(addr, clamp(old + delta * Math.max(1, Math.round(intensity / 8)), 0, 255), layer);
  }

  function lowBitTap(layer) {
    const u8 = heap();
    if (!u8) return false;
    const addr = pickHeapAddr(1);
    if (addr < 0) return false;
    const old = u8[addr];
    const mask = 1 << rand(ui.crashGuard.checked ? 2 : 4);
    return writeByte(addr, old ^ mask, layer);
  }

  function corruptOnce(layer, mode = ui.mode.value, intensity = Number(ui.strength.value)) {
    const u8 = heap();
    if (!u8) return false;
    const target = ui.target.value;
    const safe = ui.crashGuard.checked && !ui.aiUnsafe.checked;

    // In WASM, MarioState/typed-value nudges are far safer than emulator-style random RAM vandalism.
    if (target === "mario" || target === "auto") {
      const chance = target === "mario" ? 1 : (safe ? 0.92 : 0.72);
      if (Math.random() < chance && marioNudge(layer, Math.max(1, intensity / (safe ? 7 : 4)))) return true;
      if (target === "mario") return false;
    }

    if (mode === "float" || mode === "swap" || (target === "hot" && Math.random() < 0.65)) {
      return randomFloatDrift(layer, Math.max(1, intensity / (safe ? 8 : 5)));
    }

    if (safe) {
      // Destructive engines are translated into low-bit/tiny-byte versions while crash guard is on.
      if (mode === "bitflip" || mode === "xor") return lowBitTap(layer);
      if (mode === "zeroff") return softByteNudge(layer, intensity);
      return softByteNudge(layer, intensity);
    }

    const addr = pickHeapAddr(1);
    if (addr < 0) return false;
    const old = u8[addr];
    if (mode === "bitflip") return writeByte(addr, old ^ (1 << rand(6)), layer);
    if (mode === "xor") return writeByte(addr, old ^ (1 + rand(63)), layer);
    if (mode === "swap") {
      const addr2 = clamp(addr + (Math.random() < 0.5 ? 1 : -1), 0, u8.length - 1);
      const a = u8[addr], b = u8[addr2];
      writeByte(addr, b, layer); writeByte(addr2, a, layer); return true;
    }
    if (mode === "zeroff") return writeByte(addr, Math.random() < 0.5 ? 0 : 255, layer);
    return softByteNudge(layer, intensity);
  }

  function safeWriteBudget(multiplier = 1) {
    const strength = Number(ui.strength.value);
    const cap = Number(ui.writeCap.value);
    const safe = ui.crashGuard.checked && !ui.aiUnsafe.checked;
    const warm = Date.now() - state.bootTime > 12000;
    state.ramp = clamp(state.ramp + 0.2, 0, warm ? 1 : 0.45);
    const base = safe ? Math.max(1, strength / 8) : Math.max(1, strength / 3);
    const guardCap = safe ? (warm ? 8 : 3) : 96;
    return clamp(Math.round(Math.min(cap, base * multiplier * Math.max(0.35, state.ramp), guardCap)), 1, ui.aiUnsafe.checked ? 256 : 32);
  }

  function applyBlast(multiplier = 1, mode = ui.mode.value, opts = {}) {
    if (!state.ready) return;
    const safe = ui.crashGuard.checked && !ui.aiUnsafe.checked;
    const minGap = safe ? 220 : 70;
    if (!opts.force && Date.now() - state.lastWriteAt < minGap) return;
    if (opts.manual || multiplier >= 1) maybeAutoCheckpoint("pre-blast");
    lightProbe();
    const layer = [];
    const count = safeWriteBudget(multiplier);
    let ok = 0;
    for (let i = 0; i < count; i++) if (corruptOnce(layer, mode, Number(ui.strength.value))) ok++;
    if (ok) {
      state.lastLayer = layer;
      state.lastWriteAt = Date.now();
      log(`Applied ${ok} staged write${ok === 1 ? "" : "s"}.`, ok > 10 ? "warn" : "good");
    } else {
      log("No safe live target found yet. Probe or enter gameplay first.", "warn");
    }
    updateStats();
  }

  function startCorruptor() {
    if (!state.ready) return;
    if (state.armed) { stopCorruptor(); return; }
    maybeAutoCheckpoint("pre-blast");
    state.armed = true;
    state.ramp = 0;
    ui.arm.textContent = "Disarm";
    setStatus("Armed", "warn");
    const tick = () => {
      if (!state.armed) return;
      applyBlast(0.38, ui.mode.value);
      const rate = clamp(Number(ui.speed.value), 1, ui.crashGuard.checked ? 8 : 20);
      state.timer = window.setTimeout(tick, 1000 / rate);
    };
    state.timer = window.setTimeout(tick, 350);
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
    maybeAutoCheckpoint("pre-blast");
    let pulses = ui.crashGuard.checked ? 3 : 8;
    const mode = ui.mode.value === "nudges" ? "float" : ui.mode.value;
    const run = () => {
      if (pulses-- <= 0) { setStatus("Ready", "ready"); return; }
      applyBlast(ui.crashGuard.checked ? 0.55 : 0.9, mode, { force: true });
      setStatus("Tilt pulse", "warn");
      setTimeout(run, ui.crashGuard.checked ? 260 : 110);
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
    if (state.checkpoints.length) restoreCheckpoint(0);
    else undoLast();
    setStatus("Panic restored", "warn");
    log("Panic: stopped loop and restored the newest full-heap checkpoint. If the WASM thread is already hard-locked, reload is still the browser-level escape.", "warn");
  }

  function makeHeapCopy() {
    const u8 = heap();
    if (!u8) return null;
    return new Uint8Array(u8);
  }

  function createCheckpoint(name = "checkpoint", kind = "manual", quiet = false) {
    const u8 = heap();
    if (!u8) return false;
    try {
      const cp = { name, kind, time: new Date(), bytes: new Uint8Array(u8) };
      state.checkpoints.unshift(cp);
      const max = ui.aiUnsafe.checked ? 8 : 5;
      state.checkpoints = state.checkpoints.slice(0, max);
      state.quickSnapshot = cp.bytes;
      state.lastCheckpointAt = Date.now();
      if (!quiet) log(`Checkpoint saved: ${name} (${fmtBytes(u8.length)}).`, "good");
      renderStates();
      updateStats();
      return true;
    } catch (e) {
      log(`Checkpoint failed: ${e.message}`, "bad");
      return false;
    }
  }

  function maybeAutoCheckpoint(reason = "auto") {
    if (!state.ready || !ui.autoSnapshot.checked) return false;
    const minGap = reason === "pre-blast" ? 1200 : 4500;
    if (Date.now() - state.lastCheckpointAt < minGap) return false;
    return createCheckpoint(reason === "pre-blast" ? "before blast" : "stable auto", reason, true);
  }

  function takeSnapshot(verbose = true) {
    return createCheckpoint(verbose ? "manual snapshot" : "auto snapshot", verbose ? "manual" : "auto", !verbose);
  }

  function restoreSnapshot() {
    restoreCheckpoint(0);
  }

  function restoreCheckpoint(index = 0) {
    const u8 = heap();
    const cp = state.checkpoints[index] || (state.quickSnapshot ? { name: "quick snapshot", bytes: state.quickSnapshot } : null);
    if (!u8 || !cp) return false;
    if (cp.bytes.length !== u8.length) { log("Checkpoint size mismatch after heap change.", "bad"); return false; }
    stopCorruptor();
    state.lastLayer = [];
    u8.set(cp.bytes);
    state.ramp = 0;
    log(`Restored checkpoint: ${cp.name}.`, "good");
    updateStats();
    return true;
  }

  function saveNamedState() {
    const u8 = heap();
    if (!u8) return;
    const name = (ui.stateName.value || `State ${state.heapStates.length + 1}`).trim().slice(0, 28);
    try {
      state.heapStates.unshift({ name, time: new Date(), bytes: new Uint8Array(u8) });
      state.heapStates = state.heapStates.slice(0, ui.aiUnsafe.checked ? 8 : 4);
      ui.stateName.value = "";
      renderStates();
      log(`Saved named state: ${name}.`, "good");
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
    state.lastLayer = [];
    log(`Restored named state: ${s.name}.`, "good");
    updateStats();
  }

  function deleteCheckpoint(index) {
    state.checkpoints.splice(index, 1);
    state.quickSnapshot = state.checkpoints[0]?.bytes || null;
    renderStates();
    updateStats();
  }

  function renderStates() {
    if (!ui.stateList) return;
    ui.stateList.innerHTML = "";
    const frag = document.createDocumentFragment();
    const addHeader = (text) => {
      const h = document.createElement("span");
      h.className = "empty";
      h.textContent = text;
      frag.appendChild(h);
    };
    if (!state.checkpoints.length && !state.heapStates.length) {
      ui.stateList.innerHTML = `<span class="empty">No restore points yet.</span>`;
      return;
    }
    if (state.checkpoints.length) {
      addHeader("Restore points");
      state.checkpoints.forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "stateRow";
        row.innerHTML = `<div><strong></strong><small>${s.time.toLocaleTimeString()} · ${s.kind || "heap"} · ${fmtBytes(s.bytes.length)}</small></div><button type="button">Load</button><button type="button">X</button>`;
        row.querySelector("strong").textContent = s.name;
        row.children[1].onclick = () => restoreCheckpoint(i);
        row.children[2].onclick = () => deleteCheckpoint(i);
        frag.appendChild(row);
      });
    }
    if (state.heapStates.length) {
      addHeader("Named saves");
      state.heapStates.forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "stateRow";
        row.innerHTML = `<div><strong></strong><small>${s.time.toLocaleTimeString()} · ${fmtBytes(s.bytes.length)}</small></div><button type="button">Load</button><button type="button">X</button>`;
        row.querySelector("strong").textContent = s.name;
        row.children[1].onclick = () => restoreNamedState(i);
        row.children[2].onclick = () => { state.heapStates.splice(i, 1); renderStates(); };
        frag.appendChild(row);
      });
    }
    ui.stateList.appendChild(frag);
  }

  function readTelemetry() {
    const m = readMario();
    return {
      booted: state.booted, ready: state.ready,
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
      checkpoints: state.checkpoints.length,
      namedStates: state.heapStates.length,
      selectedModel: ui.aiModel.value,
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


  function modelId(m) {
    return String(m?.id || m?.name || m?.model || m?.slug || "").trim();
  }

  function hasVision(m) {
    const id = modelId(m).toLowerCase();
    const caps = JSON.stringify(m?.capabilities || m?.modalities || m || {}).toLowerCase();
    return /vision|image/.test(id) || caps.includes("image") || caps.includes("vision");
  }

  function modelCostLabel(m) {
    const txt = JSON.stringify(m || {}).toLowerCase();
    if (txt.includes("paid") || txt.includes("price") || txt.includes("cost")) return "priced";
    return "cost unknown";
  }

  function describeModel(m) {
    const bits = [];
    if (hasVision(m)) bits.push("vision"); else bits.push("text");
    const caps = m?.capabilities || {};
    for (const k of ["tool_calling", "reasoning", "web_search", "code_execution"]) if (caps[k]) bits.push(k.replace("_", " "));
    bits.push(modelCostLabel(m));
    return bits.join(" · ");
  }

  function normalizeModelList(json) {
    const raw = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []));
    const seen = new Set();
    const out = [];
    for (const m of raw) {
      const id = modelId(m);
      if (!id || seen.has(id)) continue;
      seen.add(id); out.push(m);
    }
    return out;
  }

  async function loadTextModels(preferCurrent = true) {
    const current = ui.aiModel.value;
    if (ui.modelMeta) ui.modelMeta.textContent = "Loading live model list…";
    try {
      let res = await fetch(POLLEN_TEXT_MODELS, { cache: "no-store" });
      if (!res.ok) res = await fetch(POLLEN_ALL_MODELS, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const models = normalizeModelList(await res.json()).filter(m => modelId(m));
      state.models = models;
      const texty = models.filter(m => {
        const s = JSON.stringify(m).toLowerCase();
        return !s.includes('audio-only') && !s.includes('image-only') && !s.includes('embedding');
      });
      ui.aiModel.innerHTML = "";
      for (const m of (texty.length ? texty : models)) {
        const opt = document.createElement("option");
        opt.value = modelId(m);
        opt.textContent = `${modelId(m)}${hasVision(m) ? " 👁" : ""}`;
        opt.title = describeModel(m);
        ui.aiModel.appendChild(opt);
      }
      if (preferCurrent && current && [...ui.aiModel.options].some(o => o.value === current)) ui.aiModel.value = current;
      else if ([...ui.aiModel.options].some(o => o.value === "openai-fast")) ui.aiModel.value = "openai-fast";
      updateModelMeta();
      log(`Loaded ${ui.aiModel.options.length} Pollinations text model(s).`, "good");
    } catch (e) {
      if (ui.modelMeta) ui.modelMeta.textContent = `Model list failed: ${e.message}`;
      log(`Could not load Pollinations models: ${e.message}`, "warn");
    }
  }

  function currentModelInfo() {
    const id = ui.aiModel.value;
    return state.models.find(m => modelId(m) === id) || { id };
  }

  function updateModelMeta() {
    const m = currentModelInfo();
    if (ui.modelMeta) ui.modelMeta.textContent = describeModel(m);
    if (ui.aiVision && ui.aiVision.checked && !hasVision(m)) {
      log("Selected model does not look vision-capable; screenshot will be skipped unless the endpoint accepts it anyway.", "warn");
    }
  }

  async function checkPollenAccount() {
    const key = getPollenKey();
    if (!key) { ui.accountStat.textContent = "No key"; log("Paste/connect a Pollen user key first.", "warn"); return; }
    ui.accountStat.textContent = "Checking…";
    const auth = { "Authorization": `Bearer ${key}` };
    const parts = [];
    try {
      const keyRes = await fetch(POLLEN_ACCOUNT_KEY, { headers: auth, cache: "no-store" });
      if (keyRes.ok) {
        const j = await keyRes.json();
        parts.push(j.type || j.prefix || "key ok");
      } else parts.push(`key ${keyRes.status}`);
    } catch { parts.push("key ?"); }
    try {
      const balRes = await fetch(POLLEN_ACCOUNT_BALANCE, { headers: auth, cache: "no-store" });
      if (balRes.ok) {
        const b = await balRes.json();
        const val = b.balance ?? b.pollen ?? b.remaining ?? b.budget ?? JSON.stringify(b).slice(0, 40);
        parts.push(`balance ${val}`);
      } else parts.push(`balance ${balRes.status}`);
    } catch { parts.push("balance ?"); }
    try {
      const useRes = await fetch(POLLEN_ACCOUNT_USAGE_DAILY, { headers: auth, cache: "no-store" });
      if (useRes.ok) parts.push("usage ok");
      else if (useRes.status === 403) parts.push("usage scope missing");
      else parts.push(`usage ${useRes.status}`);
    } catch { parts.push("usage ?"); }
    ui.accountStat.textContent = parts.join(" · ");
    log(`Pollen account: ${parts.join(" · ")}`, "good");
  }

  async function requestAiPlan(apply = false) {
    const key = getPollenKey();
    if (!key) { log("Connect Pollen or paste a user key first.", "warn"); ui.aiOut.textContent = "Missing Pollen key."; return; }
    if (state.ready) await probeAll(false);
    const telemetry = readTelemetry();
    const prompt = ui.aiPrompt.value.trim() || "make the game look funny but keep it playable";
    const schema = `Return only JSON with this schema:
{"name":"short name","risk":"low|medium|high","explanation":"short","actions":[
 {"type":"mario","field":"speed|yaw|x|y|z|health|capTimer","op":"add|set|mul|jitter","value":number,"repeat":1-12},
 {"type":"hotpoke","mode":"nudges|bitflip|xor|float","count":1-64,"intensity":1-10},
 {"type":"saveState","name":"optional name"}
]}
Rules: no JavaScript, no code execution, no unbounded loops. Prefer mario actions when MarioState exists. If game is not booted yet, still produce a plan that can be queued for later. For visual weirdness like big head/stretchy arms, use hotpoke float/nudges with modest count; exact body-part scaling is not guaranteed without symbols.`;

    const textContent = `You are an RTC-style corruption planner for a Super Mario 64 WASM/decomp build. User request: ${prompt}\n\nTelemetry:\n${JSON.stringify(telemetry)}\n\n${schema}`;
    let content = textContent;
    const modelInfo = currentModelInfo();
    const img = (state.ready && ui.aiVision.checked && hasVision(modelInfo)) ? screenshotDataUrl() : null;
    if (ui.aiVision.checked && !img) log("Screenshot skipped: game not ready, canvas blocked, or selected model is not vision-capable.", "warn");
    if (img) content = [{ type: "text", text: textContent }, { type: "image_url", image_url: { url: img } }];

    ui.aiOut.textContent = "Asking Pollinations…";
    try {
      const res = await fetch(POLLEN_API, {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Pollinations-Safe": "privacy,secrets" },
        body: JSON.stringify({
          model: ui.aiModel.value,
          messages: [{ role: "system", content: "You generate safe bounded JSON memory-corruption plans for a web game toy. Return JSON only." }, { role: "user", content }],
          temperature: 0.4
        })
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

  function applyAiPlan(plan = state.lastPlan || state.queuedPlan) {
    if (!plan) return;
    if (!state.ready) {
      state.queuedPlan = plan;
      ui.aiOut.textContent = `${JSON.stringify(plan, null, 2)}\n\nQueued. Boot the game, enter gameplay, then press Apply/Queue again.`;
      log("AI plan queued before boot.", "good");
      return;
    }
    maybeAutoCheckpoint("pre-blast");
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
        const count = clamp(Number(a.count || 4), 1, ui.aiUnsafe.checked ? 96 : 18);
        for (let i = 0; i < count; i++) corruptOnce(layer, ui.mode.value, clamp(Number(a.intensity || 3), 1, ui.aiUnsafe.checked ? 10 : 6));
        ui.target.value = oldTarget; ui.mode.value = oldMode;
      }
      if (a.type === "saveState") {
        ui.stateName.value = String(a.name || plan.name || "AI corruption").slice(0, 28);
        saveNamedState();
      }
    }
    if (layer.length) state.lastLayer = layer;
    state.queuedPlan = null;
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
      models: ui.aiModel.value || "openai-fast",
      scope: "usage",
      budget: "5",
      expiry: "7",
      state: Math.random().toString(36).slice(2),
    });
    if (appKey) params.set("client_id", appKey);
    location.href = `${POLLEN_AUTH}?${params}`;
  }


  function setKeyboardMode(mode) {
    state.keyboardMode = mode === "game" ? "game" : "ui";
    if (state.keyboardMode === "game") {
      ui.canvas.focus({ preventScroll: true });
      ui.focus.textContent = "Game Input";
      if (ui.uiInput) ui.uiInput.textContent = "UI Input";
    } else {
      try { ui.canvas.blur(); } catch {}
      ui.focus.textContent = "Game Input";
      if (ui.uiInput) ui.uiInput.textContent = "UI Locked";
    }
    updateStats();
  }

  function isTextEntry(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function captureUiKeyboard(e) {
    if (e.key === "Escape") { panic(); return; }
    if (isTextEntry(e.target) || state.keyboardMode !== "game") {
      // SM64's canvas/key handlers can be greedy. Stop UI typing from leaking into the game.
      e.stopImmediatePropagation();
      if (e.key.toLowerCase() === "b" && !isTextEntry(e.target) && !e.repeat && state.ready) applyBlast(1, ui.mode.value, { manual: true });
    }
  }

  function wire() {
    document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tabPanel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $(`tab-${btn.dataset.tab}`).classList.add("active");
    }));
    [ui.strength, ui.speed, ui.writeCap, ui.start, ui.end, ui.mode, ui.target, ui.crashGuard, ui.protectRuntime, ui.hotOnly, ui.autoSnapshot, ui.aiModel, ui.appKey].forEach(el => el && el.addEventListener("input", syncOutputs));
    ui.aiModel.addEventListener("change", () => { updateModelMeta(); saveSettings(); });
    ui.preset.addEventListener("change", () => applyPreset(ui.preset.value));
    ui.bootDefault.addEventListener("click", bootDefault);
    ui.wasmFile.addEventListener("change", (e) => bootPicked(e.target.files?.[0]));
    ui.reload.addEventListener("click", () => location.reload());
    ui.focus.addEventListener("click", () => setKeyboardMode("game"));
    if (ui.uiInput) ui.uiInput.addEventListener("click", () => setKeyboardMode("ui"));
    ui.canvas.addEventListener("pointerdown", () => setKeyboardMode("game"));
    document.querySelector(".panel")?.addEventListener("pointerdown", () => setKeyboardMode("ui"), { capture: true });
    ui.fullscreen.addEventListener("click", () => ui.shell.requestFullscreen?.());
    ui.arm.addEventListener("click", startCorruptor);
    ui.blast.addEventListener("click", () => applyBlast(1.15, ui.mode.value, { manual: true, force: true }));
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
    if (ui.modelsRefresh) ui.modelsRefresh.addEventListener("click", () => loadTextModels(false));
    if (ui.keyCheck) ui.keyCheck.addEventListener("click", checkPollenAccount);
    ui.aiPlan.addEventListener("click", () => requestAiPlan(false));
    ui.aiApply.addEventListener("click", () => (state.lastPlan || state.queuedPlan) ? applyAiPlan(state.lastPlan || state.queuedPlan) : requestAiPlan(true));
    document.addEventListener("keydown", captureUiKeyboard, true);
  }

  function init() {
    ui.env.textContent = location.protocol === "file:" ? "Local file mode: pick WASM." : "Static mode: ./sm64.wasm should sit beside this page.";
    loadSettings();
    handleAuthReturn();
    syncOutputs();
    wire();
    renderStates();
    setKeyboardMode("ui");
    loadTextModels(true);
    setStatus("Ready", "idle");
    window.CartriTilt64 = { probe: probeAll, readTelemetry, applyAiPlan, stop: stopCorruptor, panic, state };
  }

  init();
})();

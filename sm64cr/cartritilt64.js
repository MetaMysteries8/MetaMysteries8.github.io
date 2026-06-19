(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const DEFAULT_WASM_URL = "./sm64.wasm";
  const SETTINGS_KEY = "cartritilt64.settings.rtc-v5";
  const MiB = 1024 * 1024;
  const HOT_PAGE = 512;
  const HOT_KEEP = 320;

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
    canvas: $("canvas"),
    screenShell: $("screenShell"),
    overlay: $("bootOverlay"),
    status: $("runtimeStatus"),
    light: $("runtimeLight"),
    envNote: $("envNote"),
    log: $("log"),
    wasmFile: $("wasmFile"),
    bootPicked: $("bootPickedBtn"),
    bootDefault: $("bootDefaultBtn"),
    bootDefaultSide: $("bootDefaultSideBtn"),
    reload: $("reloadBtn"),
    fullscreen: $("fullscreenBtn"),
    focus: $("focusBtn"),
    arm: $("armBtn"),
    blast: $("blastBtn"),
    tilt: $("tiltBtn"),
    panic: $("panicBtn"),
    snapshot: $("snapshotBtn"),
    restore: $("restoreBtn"),
    undo: $("undoBtn"),
    mode: $("modeSelect"),
    target: $("targetSelect"),
    strength: $("strength"),
    speed: $("speed"),
    tiltBias: $("tiltBias"),
    rangeStart: $("rangeStart"),
    rangeEnd: $("rangeEnd"),
    protectLow: $("protectLow"),
    smartGuard: $("smartGuard"),
    visualFx: $("visualFx"),
    autoBoot: $("autoBoot"),
    strengthOut: $("strengthOut"),
    speedOut: $("speedOut"),
    tiltOut: $("tiltOut"),
    startOut: $("startOut"),
    endOut: $("endOut"),
    dropZone: $("dropZone"),
    liveTarget: $("liveTarget"),
    pokeCount: $("pokeCount"),
  };

  const state = {
    booted: false,
    ready: false,
    armed: false,
    corruptTimer: 0,
    watchdogTimer: 0,
    selectedWasm: null,
    selectedWasmName: "",
    snapshot: null,
    snapshotTime: 0,
    totalPokes: 0,
    scriptLoaded: false,
    lastLayer: [],
    marioBase: -1,
    marioScanCursor: 0x400,
    lastMarioScan: 0,
    hotHashes: new Map(),
    hotScores: new Map(),
    hotPages: [],
    hotScanCursor: 0,
    lastHotScan: 0,
    heapBuffer: null,
    views: null,
  };

  const randInt = (max) => Math.floor(Math.random() * Math.max(1, max));
  const chance = (p) => Math.random() < p;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const hex = (n) => `0x${(n >>> 0).toString(16)}`;

  function log(message, kind = "info") {
    if (!ui.log) return;
    const time = new Date().toLocaleTimeString();
    const prefix = kind === "bad" ? "!!" : kind === "good" ? "OK" : "--";
    ui.log.textContent += `[${time}] ${prefix} ${message}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function setStatus(message, tone = "idle") {
    ui.status.textContent = message;
    ui.light.className = `light ${tone}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KiB", "MiB", "GiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function currentEnvironmentNote() {
    if (location.protocol === "file:") return "Local mode: pick/drop sm64.wasm so no fetch is needed.";
    if (location.pathname.endsWith("/sm64cr/") || location.pathname.includes("/sm64cr/")) return "Drop-in /sm64cr/ mode: relative files beside index.html.";
    if (location.hostname.endsWith("github.io")) return "GitHub Pages static mode: ./sm64.wasm beside this page.";
    return "Static mode: no backend needed.";
  }

  function heap() {
    return window.Module && window.Module.HEAPU8 ? window.Module.HEAPU8 : null;
  }

  function refreshViews() {
    const mem = heap();
    if (!mem) return null;
    if (state.heapBuffer !== mem.buffer) {
      state.heapBuffer = mem.buffer;
      state.views = {
        u8: mem,
        i8: window.Module.HEAP8,
        u16: window.Module.HEAPU16,
        i16: window.Module.HEAP16,
        u32: window.Module.HEAPU32,
        f32: window.Module.HEAPF32,
      };
      log(`Heap view refreshed: ${formatBytes(mem.byteLength)}.`);
    }
    return state.views;
  }

  function saveSettings() {
    const data = {
      mode: ui.mode.value,
      target: ui.target.value,
      strength: ui.strength.value,
      speed: ui.speed.value,
      tiltBias: ui.tiltBias.value,
      rangeStart: ui.rangeStart.value,
      rangeEnd: ui.rangeEnd.value,
      protectLow: ui.protectLow.checked,
      smartGuard: ui.smartGuard.checked,
      visualFx: ui.visualFx.checked,
      autoBoot: ui.autoBoot.checked,
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch (_) {}
  }

  function loadSettings() {
    try {
      const data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if (data.mode) ui.mode.value = data.mode;
      if (data.target) ui.target.value = data.target;
      ["strength", "speed", "tiltBias", "rangeStart", "rangeEnd"].forEach((key) => {
        if (data[key] !== undefined && ui[key]) ui[key].value = String(data[key]);
      });
      ["protectLow", "smartGuard", "visualFx", "autoBoot"].forEach((key) => {
        if (typeof data[key] === "boolean" && ui[key]) ui[key].checked = data[key];
      });
    } catch (_) {}
  }

  function syncOutputs() {
    let start = Number(ui.rangeStart.value);
    let end = Number(ui.rangeEnd.value);
    if (start >= end) {
      if (document.activeElement === ui.rangeStart) end = clamp(start + 1, 1, 100);
      else start = clamp(end - 1, 0, 98);
      ui.rangeStart.value = String(start);
      ui.rangeEnd.value = String(end);
    }
    ui.strengthOut.value = ui.strength.value;
    ui.speedOut.value = `${ui.speed.value}/s`;
    ui.tiltOut.value = `${ui.tiltBias.value}%`;
    ui.startOut.value = `${ui.rangeStart.value}%`;
    ui.endOut.value = `${ui.rangeEnd.value}%`;
    saveSettings();
  }

  function enableRuntimeButtons(enabled) {
    [ui.arm, ui.blast, ui.tilt, ui.panic, ui.snapshot].forEach((button) => { button.disabled = !enabled; });
    ui.restore.disabled = !(enabled && state.snapshot);
    ui.undo.disabled = !(enabled && state.lastLayer.length);
  }

  function installModule(options) {
    const existing = window.Module;
    if (existing && existing.calledRun) {
      log("The runtime already ran. Use Reset page to boot a different WASM.", "bad");
      return false;
    }

    const wasmUrl = options.wasmUrl || DEFAULT_WASM_URL;
    const wasmBinary = options.wasmBinary || null;

    window.Module = {
      canvas: ui.canvas,
      noInitialRun: false,
      locateFile(path, prefix) {
        const normalized = String(path).replace(/\\/g, "/");
        if (normalized.endsWith(".wasm")) return wasmUrl;
        return `${prefix || ""}${path}`;
      },
      setStatus(text) { if (text) setStatus(text, "idle"); },
      print(text) { log(String(text)); },
      printErr(text) { log(String(text), "bad"); },
      onAbort(reason) {
        setStatus("Runtime aborted — reload to retry", "bad");
        log(`Runtime aborted: ${reason}`, "bad");
        stopCorruptor();
      },
      onRuntimeInitialized() {
        state.ready = true;
        refreshViews();
        setStatus(`Runtime ready — heap ${formatBytes(heap()?.byteLength || 0)}`, "ready");
        ui.overlay.classList.add("hidden");
        enableRuntimeButtons(true);
        ui.canvas.focus({ preventScroll: true });
        startWatchdog();
        log("SM64 runtime initialized. Hot RAM scanner is warming up.", "good");
      },
    };

    if (wasmBinary) {
      window.Module.wasmBinary = wasmBinary;
      log(`Using picked WASM in memory (${formatBytes(wasmBinary.byteLength)}).`, "good");
    } else {
      log(`Using static WASM URL: ${wasmUrl}`);
    }
    return true;
  }

  function bootWith(options = {}) {
    if (state.booted) {
      log("Already booted. Use Reset page to switch WASM files.", "bad");
      return;
    }
    state.booted = true;
    setStatus("Booting SM64 WASM…", "idle");
    if (!installModule(options)) return;

    const script = document.createElement("script");
    script.src = "./sm64.js";
    script.async = true;
    script.onload = () => { state.scriptLoaded = true; };
    script.onerror = () => {
      setStatus("Could not load ./sm64.js", "bad");
      log("Put sm64.js beside index.html, then reload.", "bad");
    };
    document.body.appendChild(script);
  }

  function bootStaticWasm() {
    if (location.protocol === "file:") {
      log("file:// usually blocks ./sm64.wasm fetch. Use Pick/drop WASM instead.", "bad");
      setStatus("Pick/drop WASM for local mode", "bad");
      return;
    }
    bootWith({ wasmUrl: DEFAULT_WASM_URL });
  }

  async function rememberPickedFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".wasm")) {
      log(`That file is not a .wasm file: ${file.name}`, "bad");
      return;
    }
    state.selectedWasmName = file.name;
    try {
      const bytes = await file.arrayBuffer();
      state.selectedWasm = bytes;
      log(`Selected ${file.name} (${formatBytes(bytes.byteLength)}).`, "good");
      setStatus(`Selected ${file.name} — press Boot picked`, "idle");
    } catch (error) {
      log(`Could not read WASM file: ${error.message}`, "bad");
    }
  }

  async function bootPickedWasm() {
    const file = ui.wasmFile.files && ui.wasmFile.files[0];
    if (file && (!state.selectedWasm || file.name !== state.selectedWasmName)) await rememberPickedFile(file);
    if (!state.selectedWasm) {
      log("Pick/drop a .wasm first, or boot ./sm64.wasm on your site.", "bad");
      return;
    }
    bootWith({ wasmBinary: state.selectedWasm });
  }

  function targetRegion() {
    const views = refreshViews();
    if (!views) return null;
    const length = views.u8.byteLength;
    let start = Math.floor(length * (Number(ui.rangeStart.value) / 100));
    let end = Math.floor(length * (Number(ui.rangeEnd.value) / 100));
    if (ui.protectLow.checked) start = Math.max(start, 2 * MiB);
    if (ui.smartGuard.checked) start = Math.max(start, 4 * MiB);
    end = Math.min(end, length - 64 * 1024);
    if (end <= start) {
      start = Math.max(4 * MiB, Math.floor(length * 0.25));
      end = Math.max(start + HOT_PAGE, Math.floor(length * 0.85));
    }
    return { views, start, end, length: end - start };
  }

  function looksLikeMario(b) {
    const v = refreshViews();
    if (!v || b < 0 || b + 0xC0 > v.u8.length) return false;
    const health = v.u16[(b + MS_OFF.HEALTH) >> 1];
    const wedges = health >> 8;
    if (wedges < 1 || wedges > 8 || health < 0x0100 || health > 0x0880) return false;
    const lives = v.i8[b + MS_OFF.LIVES];
    if (lives < 1 || lives > 99) return false;
    const stars = v.i16[(b + MS_OFF.STARS) >> 1];
    const coins = v.i16[(b + MS_OFF.COINS) >> 1];
    if (stars < 0 || stars > 120 || coins < 0 || coins > 999) return false;
    const action = v.u32[(b + MS_OFF.ACTION) >> 2];
    if (action < 0x40) return false;
    const x = v.f32[(b + MS_OFF.POS_X) >> 2];
    const y = v.f32[(b + MS_OFF.POS_Y) >> 2];
    const z = v.f32[(b + MS_OFF.POS_Z) >> 2];
    if (![x, y, z].every(Number.isFinite)) return false;
    if (Math.abs(x) > 20000 || Math.abs(y) > 20000 || Math.abs(z) > 20000) return false;
    if (Math.abs(x) < 1 && Math.abs(z) < 1) return false;
    const speed = v.f32[(b + MS_OFF.FWD_VEL) >> 2];
    if (!Number.isFinite(speed) || Math.abs(speed) > 350) return false;
    return true;
  }

  function scanMarioBaseBudget(ms = 5) {
    if (!state.ready) return;
    if (state.marioBase !== -1 && looksLikeMario(state.marioBase)) return;
    const v = refreshViews();
    if (!v) return;
    const end = Math.min(v.u8.length - 0xC0, 64 * MiB);
    const deadline = performance.now() + ms;
    let b = Math.max(0x400, state.marioScanCursor || 0x400);
    for (; b < end; b += 4) {
      if (looksLikeMario(b)) {
        state.marioBase = b;
        state.marioScanCursor = b;
        log(`MarioState found at ${hex(b)}. Visible corruptions unlocked.`, "good");
        return;
      }
      if ((b & 0x7ff) === 0 && performance.now() > deadline) break;
    }
    state.marioScanCursor = b >= end ? 0x400 : b;
  }

  function hashPage(u8, start, end) {
    let h = 2166136261 >>> 0;
    const lim = Math.min(start + HOT_PAGE, end, u8.length);
    let seen = 0;
    let mixed = 0;
    for (let i = start; i < lim; i += 32) {
      const x = u8[i];
      h ^= x;
      h = Math.imul(h, 16777619) >>> 0;
      seen += x;
      mixed |= x;
    }
    // Ignore totally blank-looking pages; they make boring/freeze-prone targets.
    if (mixed === 0 || seen === 0) return 0;
    return h >>> 0;
  }

  function surveyHotPagesBudget(ms = 6) {
    const region = targetRegion();
    if (!region) return;
    const { u8 } = region.views;
    const deadline = performance.now() + ms;
    let p = state.hotScanCursor || region.start;
    if (p < region.start || p >= region.end) p = region.start;
    p -= p % HOT_PAGE;

    for (; p < region.end - HOT_PAGE; p += HOT_PAGE) {
      const h = hashPage(u8, p, region.end);
      const old = state.hotHashes.get(p);
      if (h && old && old !== h) {
        state.hotScores.set(p, Math.min(20, (state.hotScores.get(p) || 0) + 3));
      } else if (state.hotScores.has(p)) {
        const next = state.hotScores.get(p) - 0.08;
        if (next <= 0) state.hotScores.delete(p);
        else state.hotScores.set(p, next);
      }
      if (h) state.hotHashes.set(p, h);
      if ((p & 0x3fff) === 0 && performance.now() > deadline) break;
    }

    state.hotScanCursor = p >= region.end - HOT_PAGE ? region.start : p;
    state.hotPages = [...state.hotScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, HOT_KEEP)
      .map(([addr]) => addr);
  }

  function readMarioState() {
    if (state.marioBase === -1 || !looksLikeMario(state.marioBase)) return null;
    const v = refreshViews();
    const b = state.marioBase;
    const health = v.u16[(b + MS_OFF.HEALTH) >> 1];
    return {
      base: b,
      x: v.f32[(b + MS_OFF.POS_X) >> 2],
      y: v.f32[(b + MS_OFF.POS_Y) >> 2],
      z: v.f32[(b + MS_OFF.POS_Z) >> 2],
      speed: v.f32[(b + MS_OFF.FWD_VEL) >> 2],
      yaw: v.i16[(b + MS_OFF.FACE_YAW) >> 1],
      coins: v.i16[(b + MS_OFF.COINS) >> 1],
      stars: v.i16[(b + MS_OFF.STARS) >> 1],
      lives: v.i8[b + MS_OFF.LIVES],
      health: health >> 8,
      action: v.u32[(b + MS_OFF.ACTION) >> 2],
    };
  }

  function pushLayerByte(layer, addr, oldValue) {
    if (layer.length < 20000) layer.push({ addr, old: oldValue });
  }

  function writeByte(addr, next, layer) {
    const v = refreshViews();
    if (!v || addr < 0 || addr >= v.u8.length) return false;
    const old = v.u8[addr];
    pushLayerByte(layer, addr, old);
    v.u8[addr] = next & 0xff;
    return true;
  }

  function chooseHeapAddress(region) {
    const bias = Number(ui.tiltBias.value) / 100;
    const randomAddress = region.start + randInt(region.length);
    if (bias <= 0.01) return randomAddress;
    const t = performance.now() / 900;
    const sweep = (Math.sin(t) + 1) / 2;
    const hotCenter = region.start + Math.floor(region.length * sweep);
    const spread = Math.max(128, Math.floor(region.length * (0.32 - bias * 0.27)));
    const hotAddress = clamp(hotCenter + randInt(spread * 2) - spread, region.start, region.end - 1);
    return chance(bias) ? hotAddress : randomAddress;
  }

  function chooseHotAddress(region) {
    if (state.hotPages.length) {
      const page = state.hotPages[randInt(Math.min(state.hotPages.length, 80))];
      return clamp(page + randInt(HOT_PAGE), region.start, region.end - 1);
    }
    return chooseHeapAddress(region);
  }

  function chooseMarioByteAddress() {
    if (state.marioBase === -1 || !looksLikeMario(state.marioBase)) return -1;
    const fields = [
      [MS_OFF.FACE_YAW, 2], [MS_OFF.POS_X, 4], [MS_OFF.POS_Y, 4], [MS_OFF.POS_Z, 4],
      [MS_OFF.FWD_VEL, 4], [MS_OFF.COINS, 2], [MS_OFF.HEALTH, 2], [MS_OFF.CAP_TIMER, 2],
    ];
    const [off, size] = fields[randInt(fields.length)];
    return state.marioBase + off + randInt(size);
  }

  function chooseAddress(region, requestedTarget) {
    const target = requestedTarget || ui.target.value;
    if (target === "mario") {
      const mario = chooseMarioByteAddress();
      return mario !== -1 ? mario : chooseHotAddress(region);
    }
    if (target === "hot") return chooseHotAddress(region);
    if (target === "heap") return chooseHeapAddress(region);
    // Auto: usually visible Mario state, then hot pages, then safe heap.
    if (state.marioBase !== -1 && chance(0.58)) {
      const mario = chooseMarioByteAddress();
      if (mario !== -1) return mario;
    }
    if (state.hotPages.length && chance(0.78)) return chooseHotAddress(region);
    return chooseHeapAddress(region);
  }

  function mutateByteAt(addr, mode, layer) {
    const v = refreshViews();
    if (!v) return false;
    const old = v.u8[addr];
    switch (mode) {
      case "bitflip":
        return writeByte(addr, old ^ (1 << randInt(8)), layer);
      case "xor":
        return writeByte(addr, old ^ (1 + randInt(255)), layer);
      case "swap": {
        const region = targetRegion();
        if (!region) return false;
        const b = chooseAddress(region, ui.target.value);
        const other = v.u8[b];
        pushLayerByte(layer, addr, old);
        pushLayerByte(layer, b, other);
        v.u8[addr] = other;
        v.u8[b] = old;
        return true;
      }
      case "zeroff":
        return writeByte(addr, chance(0.5) ? 0x00 : 0xff, layer);
      case "numeric":
      case "tilt":
      default: {
        const delta = mode === "numeric" ? randInt(33) - 16 : randInt(9) - 4;
        return writeByte(addr, old + delta, layer);
      }
    }
  }

  function writeF32(byteOffset, value, layer) {
    const v = refreshViews();
    if (!v || byteOffset < 0 || byteOffset + 4 >= v.u8.length) return false;
    for (let i = 0; i < 4; i += 1) pushLayerByte(layer, byteOffset + i, v.u8[byteOffset + i]);
    v.f32[byteOffset >> 2] = value;
    return true;
  }

  function writeI16(byteOffset, value, layer) {
    const v = refreshViews();
    if (!v || byteOffset < 0 || byteOffset + 2 >= v.u8.length) return false;
    for (let i = 0; i < 2; i += 1) pushLayerByte(layer, byteOffset + i, v.u8[byteOffset + i]);
    v.i16[byteOffset >> 1] = value;
    return true;
  }

  function writeU16(byteOffset, value, layer) {
    const v = refreshViews();
    if (!v || byteOffset < 0 || byteOffset + 2 >= v.u8.length) return false;
    for (let i = 0; i < 2; i += 1) pushLayerByte(layer, byteOffset + i, v.u8[byteOffset + i]);
    v.u16[byteOffset >> 1] = value;
    return true;
  }

  function mutateMarioSemantic(mode, layer, power = 1) {
    const s = readMarioState();
    if (!s) return false;
    const b = s.base;
    const v = refreshViews();
    const wobble = Math.max(1, Number(ui.strength.value) / 8) * power;
    const pick = randInt(mode === "numeric" || mode === "tilt" ? 7 : 10);

    if (pick === 0) return writeF32(b + MS_OFF.FWD_VEL, clamp(s.speed + (randInt(31) - 15) * wobble, -120, 160), layer);
    if (pick === 1) return writeI16(b + MS_OFF.FACE_YAW, (s.yaw + randInt(16384) - 8192) & 0xffff, layer);
    if (pick === 2) return writeF32(b + MS_OFF.POS_Y, clamp(s.y + (randInt(121) - 30) * wobble, -12000, 20000), layer);
    if (pick === 3) return writeF32(b + MS_OFF.POS_X, clamp(s.x + (randInt(101) - 50) * wobble, -20000, 20000), layer);
    if (pick === 4) return writeF32(b + MS_OFF.POS_Z, clamp(s.z + (randInt(101) - 50) * wobble, -20000, 20000), layer);
    if (pick === 5) return writeI16(b + MS_OFF.COINS, clamp(s.coins + randInt(9) - 3, 0, 999), layer);
    if (pick === 6) return writeU16(b + MS_OFF.CAP_TIMER, randInt(1200), layer);
    if (pick === 7) return writeU16(b + MS_OFF.HEALTH, clamp((randInt(8) + 1) << 8, 0x0100, 0x0880), layer);
    if (pick === 8) return mutateByteAt(b + randInt(0xB8), mode, layer);
    return mutateByteAt(chooseMarioByteAddress(), mode, layer);
  }

  function applyBlastUnit(layer, forceMode = "", forceTarget = "", power = 1) {
    const region = targetRegion();
    if (!region) return false;
    const mode = forceMode || ui.mode.value;
    const target = forceTarget || ui.target.value;
    // Semantic Mario writes are the "actually visible" path; byte pokes provide RTC-ish chaos.
    if ((target === "mario" || target === "auto") && state.marioBase !== -1 && chance(target === "mario" ? 0.72 : 0.42)) {
      if (mutateMarioSemantic(mode, layer, power)) return true;
    }
    const addr = chooseAddress(region, target);
    return mutateByteAt(addr, mode, layer);
  }

  function corruptOnce(multiplier = 1, forceMode = "", forceTarget = "") {
    if (!state.ready) return;
    scanMarioBaseBudget(2.5);
    surveyHotPagesBudget(3);
    const base = Number(ui.strength.value);
    const budget = Math.max(1, Math.floor(base * multiplier));
    const layer = [];
    let made = 0;
    for (let i = 0; i < budget; i += 1) {
      if (applyBlastUnit(layer, forceMode, forceTarget, multiplier > 4 ? 1.35 : 1)) made += 1;
    }
    if (layer.length) {
      state.lastLayer = layer;
      ui.undo.disabled = false;
    }
    state.totalPokes += made;
    ui.pokeCount.textContent = state.totalPokes.toLocaleString();
    updateLiveTarget();
    if (ui.visualFx.checked) pulseFx();
  }

  function startCorruptor() {
    if (!state.ready) return;
    state.armed = true;
    ui.arm.textContent = "Disarm";
    const hz = Number(ui.speed.value);
    const interval = Math.max(22, Math.floor(1000 / hz));
    clearInterval(state.corruptTimer);
    state.corruptTimer = window.setInterval(() => corruptOnce(1), interval);
    setStatus(`Armed — ${hz}/s`, "ready");
    log(`Armed ${ui.mode.options[ui.mode.selectedIndex].text} on ${ui.target.options[ui.target.selectedIndex].text}.`);
  }

  function stopCorruptor() {
    state.armed = false;
    ui.arm.textContent = "Arm";
    clearInterval(state.corruptTimer);
    state.corruptTimer = 0;
    ui.screenShell.classList.remove("fx", "tilted");
    if (state.ready) setStatus(`Ready — ${state.totalPokes.toLocaleString()} pokes`, "ready");
  }

  function blast() {
    if (!state.ready) return;
    corruptOnce(12, "numeric", "auto");
    corruptOnce(18, "bitflip", state.hotPages.length ? "hot" : "heap");
    log(`Blast layer applied. ${state.lastLayer.length.toLocaleString()} bytes can be undone once.`, "good");
  }

  function tiltCartridge() {
    if (!state.ready) return;
    ui.screenShell.classList.add("tilted");
    log("Cart tilt: pulsing MarioState + hot RAM, no main-loop pause.", "good");
    for (let i = 0; i < 8; i += 1) {
      window.setTimeout(() => corruptOnce(i < 3 ? 5 : 3, i % 2 ? "tilt" : "numeric", "auto"), i * 72);
    }
    window.setTimeout(() => {
      ui.screenShell.classList.remove("tilted");
      if (ui.visualFx.checked && state.armed) ui.screenShell.classList.add("fx");
    }, 720);
  }

  function pulseFx() {
    ui.screenShell.classList.add("fx");
    window.clearTimeout(pulseFx.timer);
    pulseFx.timer = window.setTimeout(() => {
      if (!state.armed) ui.screenShell.classList.remove("fx");
    }, 150);
  }

  function takeSnapshot() {
    const mem = heap();
    if (!mem) return;
    try {
      state.snapshot = new Uint8Array(mem);
      state.snapshotTime = Date.now();
      ui.restore.disabled = false;
      log(`Heap snapshot saved (${formatBytes(state.snapshot.byteLength)}).`, "good");
    } catch (error) {
      log(`Snapshot failed: ${error.message}`, "bad");
    }
  }

  function restoreSnapshot() {
    const mem = heap();
    if (!mem || !state.snapshot) return;
    const bytes = Math.min(mem.byteLength, state.snapshot.byteLength);
    mem.set(state.snapshot.subarray(0, bytes));
    log(`Snapshot restored (${formatBytes(bytes)} copied).`, "good");
  }

  function undoLastLayer() {
    const v = refreshViews();
    if (!v || !state.lastLayer.length) return;
    for (let i = state.lastLayer.length - 1; i >= 0; i -= 1) {
      const item = state.lastLayer[i];
      if (item.addr >= 0 && item.addr < v.u8.length) v.u8[item.addr] = item.old;
    }
    log(`Undid last blast layer (${state.lastLayer.length.toLocaleString()} byte writes).`, "good");
    state.lastLayer = [];
    ui.undo.disabled = true;
  }

  function updateLiveTarget() {
    const parts = [];
    if (state.marioBase !== -1 && looksLikeMario(state.marioBase)) {
      const s = readMarioState();
      parts.push(`Mario ${hex(state.marioBase)}`);
      if (s) parts.push(`❤${s.health}/8 🪙${s.coins} spd ${Math.round(s.speed)}`);
    } else {
      parts.push("Mario scan…");
    }
    if (state.hotPages.length) parts.push(`${state.hotPages.length} hot pages`);
    else parts.push("hot RAM warming");
    ui.liveTarget.textContent = parts.join(" | ");
  }

  function startWatchdog() {
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = window.setInterval(() => {
      if (!state.ready) return;
      refreshViews();
      scanMarioBaseBudget(8);
      surveyHotPagesBudget(8);
      updateLiveTarget();
    }, 550);
  }

  function installDropHandling() {
    const prevent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
      ui.dropZone.addEventListener(eventName, prevent);
      document.body.addEventListener(eventName, prevent);
    });
    ui.dropZone.addEventListener("dragenter", () => ui.dropZone.classList.add("dragging"));
    ui.dropZone.addEventListener("dragover", () => ui.dropZone.classList.add("dragging"));
    ui.dropZone.addEventListener("dragleave", () => ui.dropZone.classList.remove("dragging"));
    ui.dropZone.addEventListener("drop", async (event) => {
      ui.dropZone.classList.remove("dragging");
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) await rememberPickedFile(file);
    });
  }

  async function maybeAutoBoot() {
    if (!ui.autoBoot.checked || location.protocol === "file:" || state.booted) return;
    try {
      const response = await fetch(DEFAULT_WASM_URL, { method: "HEAD", cache: "no-store" });
      if (response.ok) {
        log("Auto-boot found ./sm64.wasm.", "good");
        bootWith({ wasmUrl: DEFAULT_WASM_URL });
      } else {
        log("Auto-boot did not find ./sm64.wasm. Manual boot is ready.");
      }
    } catch (_) {
      log("Auto-boot HEAD check failed. Manual boot is ready.");
    }
  }

  function bind() {
    [ui.strength, ui.speed, ui.tiltBias, ui.rangeStart, ui.rangeEnd].forEach((input) => {
      input.addEventListener("input", () => {
        syncOutputs();
        if (input === ui.speed && state.armed) startCorruptor();
      });
    });
    [ui.mode, ui.target, ui.protectLow, ui.smartGuard, ui.visualFx, ui.autoBoot].forEach((input) => {
      input.addEventListener("change", () => {
        saveSettings();
        if (input === ui.visualFx && !ui.visualFx.checked) ui.screenShell.classList.remove("fx", "tilted");
      });
    });

    ui.bootDefault.addEventListener("click", bootStaticWasm);
    ui.bootDefaultSide.addEventListener("click", bootStaticWasm);
    ui.bootPicked.addEventListener("click", bootPickedWasm);
    ui.wasmFile.addEventListener("change", async () => {
      const file = ui.wasmFile.files && ui.wasmFile.files[0];
      if (file) await rememberPickedFile(file);
    });
    ui.reload.addEventListener("click", () => window.location.reload());
    ui.arm.addEventListener("click", () => (state.armed ? stopCorruptor() : startCorruptor()));
    ui.blast.addEventListener("click", blast);
    ui.tilt.addEventListener("click", tiltCartridge);
    ui.panic.addEventListener("click", () => {
      stopCorruptor();
      log("Panic stop hit. Use undo/snapshot/reload to recover changed bytes.", "bad");
    });
    ui.snapshot.addEventListener("click", takeSnapshot);
    ui.restore.addEventListener("click", restoreSnapshot);
    ui.undo.addEventListener("click", undoLastLayer);
    ui.focus.addEventListener("click", () => ui.canvas.focus({ preventScroll: true }));
    ui.fullscreen.addEventListener("click", () => {
      if (ui.canvas.requestFullscreen) ui.canvas.requestFullscreen();
      else if (window.Module && window.Module.requestFullscreen) window.Module.requestFullscreen(true, true);
    });
  }

  window.CartriTilt64 = {
    state,
    scanMario: () => { scanMarioBaseBudget(50); updateLiveTarget(); return state.marioBase; },
    hotPages: () => state.hotPages.slice(),
    readMarioState,
    blast,
    stop: stopCorruptor,
  };

  window.addEventListener("error", (event) => log(`Browser error: ${event.message}`, "bad"));
  window.addEventListener("unhandledrejection", (event) => log(`Promise error: ${event.reason && event.reason.message ? event.reason.message : event.reason}`, "bad"));

  loadSettings();
  syncOutputs();
  bind();
  installDropHandling();
  ui.envNote.textContent = currentEnvironmentNote();
  log("CartriTilt64 RTC-style build loaded. Boot, wait until Mario is controllable, then snapshot and corrupt.");
  maybeAutoBoot();
})();

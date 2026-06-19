(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const DEFAULT_WASM_URL = "./sm64.wasm";
  const SETTINGS_KEY = "cartritilt64.settings.dropin-sm64cr.v4";

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
    mode: $("modeSelect"),
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
  };

  const state = {
    booted: false,
    ready: false,
    armed: false,
    corruptTimer: 0,
    selectedWasm: null,
    selectedWasmName: "",
    snapshot: null,
    snapshotTime: 0,
    totalPokes: 0,
    lastHeapBytes: 0,
    scriptLoaded: false,
  };

  const randInt = (max) => Math.floor(Math.random() * Math.max(1, max));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function log(message, kind = "info") {
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
    if (location.protocol === "file:") {
      return "Local file mode: pick/drop sm64.wasm; browsers usually block direct ./sm64.wasm fetch from disk.";
    }
    if (location.hostname.endsWith("github.io")) {
      return "Hosted mode: put sm64.wasm beside this page and boot ./sm64.wasm.";
    }
    if (location.protocol === "http:" || location.protocol === "https:") {
      return "Static web mode: works from /sm64cr/ or any folder if sm64.js and sm64.wasm are beside index.html.";
    }
    return "Static mode ready.";
  }

  function saveSettings() {
    const data = {
      mode: ui.mode.value,
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
    [ui.arm, ui.blast, ui.tilt, ui.panic, ui.snapshot].forEach((button) => {
      button.disabled = !enabled;
    });
    ui.restore.disabled = !(enabled && state.snapshot);
  }

  function heap() {
    return window.Module && window.Module.HEAPU8 ? window.Module.HEAPU8 : null;
  }

  function installModule(options) {
    const existing = window.Module;
    if (existing && existing.calledRun) {
      log("The Emscripten runtime already ran. Use Hard reset page to boot a different WASM.", "bad");
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
      setStatus(text) {
        if (text) setStatus(text, "idle");
      },
      print(text) { log(String(text)); },
      printErr(text) { log(String(text), "bad"); },
      onAbort(reason) {
        setStatus("Runtime aborted — reload to retry", "bad");
        log(`Runtime aborted: ${reason}`, "bad");
        stopCorruptor();
      },
      onRuntimeInitialized() {
        state.ready = true;
        state.lastHeapBytes = heap()?.byteLength || 0;
        setStatus(`Runtime ready — heap ${formatBytes(state.lastHeapBytes)}`, "ready");
        ui.overlay.classList.add("hidden");
        enableRuntimeButtons(true);
        ui.canvas.focus({ preventScroll: true });
        log("SM64 runtime initialized. Corrupt responsibly; reload fixes the universe.", "good");
      },
    };

    if (wasmBinary) {
      window.Module.wasmBinary = wasmBinary;
      log(`Using in-memory WASM binary (${formatBytes(wasmBinary.byteLength)}).`, "good");
    } else {
      log(`Using static WASM URL: ${wasmUrl}`);
    }

    return true;
  }

  function bootWith(options = {}) {
    if (state.booted) {
      log("Already booted. Use Hard reset page if you want to switch WASM files.", "bad");
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

  async function bootStaticWasm() {
    if (location.protocol === "file:") {
      log("Direct ./sm64.wasm boot is usually blocked from file://. Use Pick/drop WASM instead, or deploy to your site.", "bad");
      setStatus("Pick/drop WASM for local file mode", "bad");
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
      log(`Selected ${file.name} (${formatBytes(bytes.byteLength)}). This boot path does not fetch the WASM.`, "good");
      setStatus(`Selected ${file.name} — press Boot picked WASM`, "idle");
    } catch (error) {
      log(`Could not read WASM file: ${error.message}`, "bad");
    }
  }

  async function bootPickedWasm() {
    const file = ui.wasmFile.files && ui.wasmFile.files[0];
    if (file && (!state.selectedWasm || file.name !== state.selectedWasmName)) await rememberPickedFile(file);
    if (!state.selectedWasm) {
      log("Pick or drop a .wasm file first, or boot using ./sm64.wasm on your hosted site.", "bad");
      return;
    }
    bootWith({ wasmBinary: state.selectedWasm });
  }

  function targetRegion() {
    const mem = heap();
    if (!mem) return null;

    const length = mem.byteLength;
    const startPercent = Number(ui.rangeStart.value) / 100;
    const endPercent = Number(ui.rangeEnd.value) / 100;

    let start = Math.floor(length * startPercent);
    let end = Math.floor(length * endPercent);

    if (ui.protectLow.checked) start = Math.max(start, 2 * 1024 * 1024);
    if (ui.smartGuard.checked) start = Math.max(start, 4 * 1024 * 1024);
    end = Math.min(end, length - 65536);

    if (end <= start) {
      start = Math.max(0, Math.floor(length * 0.35));
      end = Math.max(start + 1, Math.floor(length * 0.90));
    }

    return { mem, start, end, length: end - start };
  }

  function tiltedAddress(region) {
    const bias = Number(ui.tiltBias.value) / 100;
    const randomAddress = region.start + randInt(region.length);
    if (bias <= 0.01) return randomAddress;

    const t = performance.now() / 1100;
    const sweep = (Math.sin(t) + 1) / 2;
    const hotCenter = region.start + Math.floor(region.length * sweep);
    const spread = Math.max(64, Math.floor(region.length * (0.35 - bias * 0.32)));
    const hotAddress = clamp(hotCenter + randInt(spread * 2) - spread, region.start, region.end - 1);

    return Math.random() < bias ? hotAddress : randomAddress;
  }

  function pokeByte(region, forceMode) {
    const mem = region.mem;
    const mode = forceMode || ui.mode.value;
    const a = tiltedAddress(region);
    const old = mem[a];

    switch (mode) {
      case "nibble":
        mem[a] = old ^ (1 << randInt(8));
        break;
      case "drift": {
        const delta = randInt(17) - 8;
        mem[a] = (old + delta) & 0xff;
        break;
      }
      case "static":
        mem[a] = old ^ randInt(256);
        break;
      case "swap": {
        const b = tiltedAddress(region);
        const temp = mem[a];
        mem[a] = mem[b];
        mem[b] = temp;
        break;
      }
      case "void":
        mem[a] = Math.random() < 0.5 ? 0x00 : 0xff;
        break;
      case "sparkle":
        if (Math.random() < 0.75) mem[a] = old ^ (1 << randInt(4));
        else mem[a] = (old + (Math.random() < 0.5 ? 1 : -1)) & 0xff;
        break;
      default:
        mem[a] = old ^ 0x01;
    }
  }

  function corruptOnce(multiplier = 1, forceMode = "") {
    if (!state.ready) return;
    const region = targetRegion();
    if (!region) return;

    const base = Number(ui.strength.value);
    const pokes = Math.max(1, Math.floor(base * multiplier));
    for (let i = 0; i < pokes; i += 1) pokeByte(region, forceMode);

    state.totalPokes += pokes;
    if (ui.visualFx.checked) pulseFx();
  }

  function startCorruptor() {
    if (!state.ready) return;
    state.armed = true;
    ui.arm.textContent = "Disarm corrupter";
    const hz = Number(ui.speed.value);
    const interval = Math.max(16, Math.floor(1000 / hz));
    clearInterval(state.corruptTimer);
    state.corruptTimer = window.setInterval(() => corruptOnce(1), interval);
    setStatus(`Corrupter armed — ${hz}/s`, "ready");
    log(`Armed: ${ui.mode.options[ui.mode.selectedIndex].text}`);
  }

  function stopCorruptor() {
    state.armed = false;
    ui.arm.textContent = "Arm corrupter";
    clearInterval(state.corruptTimer);
    state.corruptTimer = 0;
    ui.screenShell.classList.remove("fx", "tilted");
    if (state.ready) setStatus(`Runtime ready — ${state.totalPokes.toLocaleString()} pokes made`, "ready");
  }

  function blast() {
    corruptOnce(45, "static");
    corruptOnce(12, ui.mode.value);
    log(`BLAST delivered. Total pokes: ${state.totalPokes.toLocaleString()}`, "good");
  }

  function tiltCartridge() {
    if (!state.ready) return;
    ui.screenShell.classList.add("tilted");

    try { if (window.Module.pauseMainLoop) window.Module.pauseMainLoop(); } catch (_) {}

    for (let i = 0; i < 6; i += 1) {
      window.setTimeout(() => corruptOnce(30, i % 2 ? "swap" : "drift"), i * 70);
    }

    window.setTimeout(() => {
      try { if (window.Module.resumeMainLoop) window.Module.resumeMainLoop(); } catch (_) {}
      ui.screenShell.classList.remove("tilted");
      if (ui.visualFx.checked && state.armed) ui.screenShell.classList.add("fx");
    }, 520);

    log("You tilted the cartridge. Reality made a crunch noise.", "good");
  }

  function pulseFx() {
    ui.screenShell.classList.add("fx");
    window.clearTimeout(pulseFx.timer);
    pulseFx.timer = window.setTimeout(() => {
      if (!state.armed) ui.screenShell.classList.remove("fx");
    }, 180);
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
        log("Auto-boot found ./sm64.wasm on this static host.", "good");
        bootWith({ wasmUrl: DEFAULT_WASM_URL });
      } else {
        log("Auto-boot did not find ./sm64.wasm. Use the picker or add it beside index.html.");
      }
    } catch (_) {
      log("Auto-boot check could not reach ./sm64.wasm. Manual boot is still available.");
    }
  }

  function bind() {
    [ui.strength, ui.speed, ui.tiltBias, ui.rangeStart, ui.rangeEnd].forEach((input) => {
      input.addEventListener("input", () => {
        syncOutputs();
        if (input === ui.speed && state.armed) startCorruptor();
      });
    });
    [ui.mode, ui.protectLow, ui.smartGuard, ui.visualFx, ui.autoBoot].forEach((input) => {
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
      log("Panic stop hit. Memory changes already made are not magically un-poked.", "bad");
    });
    ui.snapshot.addEventListener("click", takeSnapshot);
    ui.restore.addEventListener("click", restoreSnapshot);
    ui.focus.addEventListener("click", () => ui.canvas.focus({ preventScroll: true }));
    ui.fullscreen.addEventListener("click", () => {
      if (ui.canvas.requestFullscreen) ui.canvas.requestFullscreen();
      else if (window.Module && window.Module.requestFullscreen) window.Module.requestFullscreen(true, true);
    });
  }

  window.addEventListener("error", (event) => {
    log(`Browser error: ${event.message}`, "bad");
  });
  window.addEventListener("unhandledrejection", (event) => {
    log(`Promise error: ${event.reason && event.reason.message ? event.reason.message : event.reason}`, "bad");
  });

  loadSettings();
  syncOutputs();
  bind();
  installDropHandling();
  ui.envNote.textContent = currentEnvironmentNote();
  log("CartriTilt64 loaded. Place sm64.wasm beside this page and boot, or use the picker.");
  maybeAutoBoot();
})();

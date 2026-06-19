(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const DEFAULT_WASM_URL = './sm64.wasm';
  const RUNNER_URL = './game-runner.html';
  const SETTINGS_KEY = 'cartritilt64.supervisor.v1';

  const ui = {
    frame: $('runnerFrame'),
    shell: $('screenShell'),
    overlay: $('bootOverlay'),
    status: $('runtimeStatus'),
    light: $('runtimeLight'),
    log: $('log'),
    wasmFile: $('wasmFile'),
    bootDefault: $('bootDefaultBtn'),
    bootDefaultSide: $('bootDefaultSideBtn'),
    bootPicked: $('bootPickedBtn'),
    dropZone: $('dropZone'),
    focus: $('focusBtn'),
    fullscreen: $('fullscreenBtn'),
    detach: $('detachBtn'),
    arm: $('armBtn'),
    blast: $('blastBtn'),
    tilt: $('tiltBtn'),
    panic: $('panicBtn'),
    softPanic: $('softPanicBtn'),
    forceReboot: $('forceRebootBtn'),
    snapshot: $('snapshotBtn'),
    restore: $('restoreBtn'),
    undo: $('undoBtn'),
    resetUi: $('resetUiBtn'),
    mode: $('modeSelect'),
    target: $('targetSelect'),
    strength: $('strength'),
    speed: $('speed'),
    tiltBias: $('tiltBias'),
    rangeStart: $('rangeStart'),
    rangeEnd: $('rangeEnd'),
    protectLow: $('protectLow'),
    smartGuard: $('smartGuard'),
    crashGuard: $('crashGuard'),
    autoRecover: $('autoRecover'),
    visualFx: $('visualFx'),
    autoBoot: $('autoBoot'),
    strengthOut: $('strengthOut'),
    speedOut: $('speedOut'),
    tiltOut: $('tiltOut'),
    startOut: $('startOut'),
    endOut: $('endOut'),
    liveTarget: $('liveTarget'),
    runnerHealth: $('runnerHealth'),
    pokeCount: $('pokeCount'),
  };

  const state = {
    session: Math.random().toString(36).slice(2),
    wasmBuffer: null,
    wasmName: '',
    booted: false,
    ready: false,
    armed: false,
    tilted: false,
    detached: false,
    popup: null,
    lastHeartbeat: 0,
    lastAck: 0,
    freezeCount: 0,
    rebooting: false,
    hasSnapshot: false,
    hasUndo: false,
    totalPokes: 0,
    watchdog: 0,
  };

  function log(message, kind = 'info') {
    const time = new Date().toLocaleTimeString();
    const prefix = kind === 'bad' ? '!!' : kind === 'good' ? 'OK' : kind === 'warn' ? '??' : '--';
    ui.log.textContent += `[${time}] ${prefix} ${message}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function setStatus(message, tone = 'idle') {
    ui.status.textContent = message;
    ui.light.className = `light ${tone}`;
  }

  function syncOutputs() {
    let start = Number(ui.rangeStart.value);
    let end = Number(ui.rangeEnd.value);
    if (start >= end) {
      if (document.activeElement === ui.rangeStart) end = Math.min(100, start + 1);
      else start = Math.max(0, end - 1);
      ui.rangeStart.value = String(start);
      ui.rangeEnd.value = String(end);
    }
    ui.strengthOut.value = ui.strength.value;
    ui.speedOut.value = `${ui.speed.value}/s`;
    ui.tiltOut.value = `${ui.tiltBias.value}%`;
    ui.startOut.value = `${ui.rangeStart.value}%`;
    ui.endOut.value = `${ui.rangeEnd.value}%`;
    saveSettings();
    send('settings', settings());
  }

  function settings() {
    return {
      mode: ui.mode.value,
      target: ui.target.value,
      strength: Number(ui.strength.value),
      speed: Number(ui.speed.value),
      tiltBias: Number(ui.tiltBias.value),
      rangeStart: Number(ui.rangeStart.value),
      rangeEnd: Number(ui.rangeEnd.value),
      protectLow: ui.protectLow.checked,
      smartGuard: ui.smartGuard.checked,
      crashGuard: ui.crashGuard.checked,
      visualFx: ui.visualFx.checked,
    };
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
      crashGuard: ui.crashGuard.checked,
      autoRecover: ui.autoRecover.checked,
      visualFx: ui.visualFx.checked,
      autoBoot: ui.autoBoot.checked,
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch (_) {}
  }

  function loadSettings() {
    try {
      const data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      ['mode', 'target'].forEach((key) => { if (data[key] && ui[key]) ui[key].value = data[key]; });
      ['strength', 'speed', 'tiltBias', 'rangeStart', 'rangeEnd'].forEach((key) => {
        if (data[key] !== undefined && ui[key]) ui[key].value = String(data[key]);
      });
      ['protectLow', 'smartGuard', 'crashGuard', 'autoRecover', 'visualFx', 'autoBoot'].forEach((key) => {
        if (typeof data[key] === 'boolean' && ui[key]) ui[key].checked = data[key];
      });
    } catch (_) {}
  }

  function enableRuntimeButtons(enabled) {
    [ui.arm, ui.blast, ui.tilt, ui.panic, ui.softPanic, ui.snapshot].forEach((button) => { button.disabled = !enabled; });
    ui.restore.disabled = !(enabled && state.hasSnapshot);
    ui.undo.disabled = !(enabled && state.hasUndo);
  }

  function runnerWindow() {
    if (state.detached && state.popup && !state.popup.closed) return state.popup;
    return ui.frame && ui.frame.contentWindow ? ui.frame.contentWindow : null;
  }

  function send(cmd, payload = {}) {
    const target = runnerWindow();
    if (!target) return false;
    try {
      target.postMessage({ source: 'cartritilt64-supervisor', session: state.session, cmd, payload }, '*');
      return true;
    } catch (err) {
      log(`send failed: ${err.message || err}`, 'bad');
      return false;
    }
  }

  function createFrame() {
    state.session = Math.random().toString(36).slice(2);
    const old = ui.frame;
    const frame = document.createElement('iframe');
    frame.id = 'runnerFrame';
    frame.className = 'runnerFrame';
    frame.title = 'CartriTilt64 isolated SM64 runner';
    frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-popups allow-modals');
    frame.setAttribute('allow', 'autoplay; fullscreen');
    frame.allowFullscreen = true;
    frame.src = `${RUNNER_URL}?session=${encodeURIComponent(state.session)}&t=${Date.now()}`;
    old.replaceWith(frame);
    ui.frame = frame;
    frame.addEventListener('load', () => {
      if (state.wasmBuffer) sendBoot();
    });
  }

  function sendBoot() {
    if (!state.wasmBuffer) {
      log('No WASM loaded. Pick a file or boot ./sm64.wasm first.', 'bad');
      return;
    }
    createFrameIfMissing();
    state.booted = true;
    state.ready = false;
    state.armed = false;
    state.tilted = false;
    state.hasSnapshot = false;
    state.hasUndo = false;
    state.totalPokes = 0;
    state.lastHeartbeat = performance.now();
    state.lastAck = 0;
    ui.overlay.classList.add('hidden');
    ui.runnerHealth.textContent = 'booting';
    ui.liveTarget.textContent = 'heap warming up';
    ui.pokeCount.textContent = '0';
    enableRuntimeButtons(false);
    setStatus('Booting runner…', 'idle');
    const copy = state.wasmBuffer.slice(0);
    const ok = send('boot', { wasmBinary: copy, wasmName: state.wasmName || 'sm64.wasm', settings: settings() });
    if (ok) log(`Boot sent to isolated runner (${state.wasmName || './sm64.wasm'}).`, 'good');
  }

  function createFrameIfMissing() {
    if (!ui.frame || !ui.frame.contentWindow) createFrame();
  }

  async function bootDefault() {
    setStatus('Fetching ./sm64.wasm…', 'idle');
    log('Fetching ./sm64.wasm from this folder.');
    try {
      const response = await fetch(DEFAULT_WASM_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.wasmBuffer = await response.arrayBuffer();
      state.wasmName = './sm64.wasm';
      state.detached = false;
      sendBoot();
    } catch (err) {
      setStatus('Pick WASM file', 'bad');
      log(`Could not fetch ./sm64.wasm: ${err.message || err}. Use the picker/drop zone.`, 'bad');
    }
  }

  async function bootFile(file) {
    if (!file) return;
    setStatus('Reading WASM…', 'idle');
    try {
      state.wasmBuffer = await file.arrayBuffer();
      state.wasmName = file.name || 'picked sm64.wasm';
      state.detached = false;
      sendBoot();
    } catch (err) {
      setStatus('File read failed', 'bad');
      log(`Could not read WASM: ${err.message || err}`, 'bad');
    }
  }

  function softPanic() {
    send('panic', {});
    ui.shell.classList.remove('fx', 'tilted');
    state.armed = false;
    state.tilted = false;
    ui.arm.textContent = 'Arm';
    ui.tilt.textContent = 'Tilt';
    log('Soft panic sent. If the runner is hung, use Force reboot or wait for auto-recover.', 'warn');
  }

  function forceReboot(reason = 'manual') {
    if (!state.wasmBuffer) {
      ui.overlay.classList.remove('hidden');
      setStatus('No WASM loaded', 'bad');
      return;
    }
    if (state.rebooting) return;
    state.rebooting = true;
    log(`Killing runner and creating a fresh one (${reason}).`, reason === 'manual' ? 'warn' : 'bad');
    setStatus('Rebooting runner…', 'bad');
    ui.shell.classList.remove('fx', 'tilted');
    state.ready = false;
    state.armed = false;
    state.tilted = false;
    enableRuntimeButtons(false);
    try { if (state.popup && !state.popup.closed) state.popup.close(); } catch (_) {}
    state.popup = null;
    state.detached = false;
    createFrame();
    setTimeout(() => {
      state.rebooting = false;
      sendBoot();
    }, 300);
  }

  function openDetached() {
    if (!state.wasmBuffer) {
      log('Boot or pick sm64.wasm before opening a detached runner.', 'bad');
      return;
    }
    const popup = window.open(`${RUNNER_URL}?session=${encodeURIComponent(state.session)}&detached=1&t=${Date.now()}`, 'CartriTilt64Runner', 'popup,width=960,height=720');
    if (!popup) {
      log('Popup/tab blocked. Use the iframe runner or allow popups for this site.', 'bad');
      return;
    }
    state.popup = popup;
    state.detached = true;
    state.ready = false;
    setStatus('Detached runner booting…', 'idle');
    log('Detached runner opened. This is the strongest anti-crash mode because the controller tab is separate.', 'good');
    setTimeout(sendBoot, 600);
  }

  function toggleArm() {
    state.armed = !state.armed;
    ui.arm.textContent = state.armed ? 'Disarm' : 'Arm';
    send(state.armed ? 'arm' : 'disarm', { settings: settings() });
  }

  function toggleTilt() {
    state.tilted = !state.tilted;
    ui.tilt.textContent = state.tilted ? 'Untilt' : 'Tilt';
    ui.shell.classList.toggle('tilted', state.tilted && ui.visualFx.checked);
    send(state.tilted ? 'tiltStart' : 'tiltStop', { settings: settings() });
  }

  function hardPanic() {
    softPanic();
    const before = state.lastAck;
    setTimeout(() => {
      if (!state.ready || state.lastAck === before || performance.now() - state.lastHeartbeat > 1500) {
        forceReboot('panic timeout');
      }
    }, 750);
  }

  function onRunnerMessage(event) {
    const data = event.data || {};
    if (data.source !== 'cartritilt64-runner') return;
    if (data.session && data.session !== state.session) return;
    const p = data.payload || {};
    if (data.type === 'hello') {
      state.lastHeartbeat = performance.now();
      if (state.wasmBuffer) sendBoot();
    }
    if (data.type === 'log') log(p.message || '', p.kind || 'info');
    if (data.type === 'status') setStatus(p.message || 'Runner', p.tone || 'idle');
    if (data.type === 'ready') {
      state.ready = true;
      state.lastHeartbeat = performance.now();
      state.lastAck = performance.now();
      enableRuntimeButtons(true);
      ui.runnerHealth.textContent = 'ready';
      ui.overlay.classList.add('hidden');
      setStatus('Ready', 'ready');
      log('Runner runtime initialized. Corruptions are now sent through postMessage.', 'good');
    }
    if (data.type === 'heartbeat') {
      state.lastHeartbeat = performance.now();
      state.lastAck = state.lastHeartbeat;
      ui.runnerHealth.textContent = p.state || 'alive';
      ui.liveTarget.textContent = p.target || 'scanning';
      if (typeof p.totalPokes === 'number') {
        state.totalPokes = p.totalPokes;
        ui.pokeCount.textContent = String(p.totalPokes);
      }
      if (typeof p.hasSnapshot === 'boolean') state.hasSnapshot = p.hasSnapshot;
      if (typeof p.hasUndo === 'boolean') state.hasUndo = p.hasUndo;
      if (state.ready) enableRuntimeButtons(true);
    }
    if (data.type === 'ack') {
      state.lastAck = performance.now();
      if (p.cmd === 'panic') {
        state.armed = false; state.tilted = false;
        ui.arm.textContent = 'Arm'; ui.tilt.textContent = 'Tilt';
        ui.shell.classList.remove('fx', 'tilted');
      }
      if (p.cmd === 'snapshot') state.hasSnapshot = true;
      if (p.cmd === 'restore') state.hasSnapshot = true;
      if (p.cmd === 'undo') state.hasUndo = false;
      enableRuntimeButtons(state.ready);
    }
    if (data.type === 'crash') {
      log(`Runner reported a crash: ${p.message || 'unknown error'}`, 'bad');
      setStatus('Runner crashed', 'bad');
      if (ui.autoRecover.checked) forceReboot('reported crash');
    }
  }

  function watchdogTick() {
    if (!state.booted || state.rebooting) return;
    const age = performance.now() - state.lastHeartbeat;
    if (state.ready && age > 2600) {
      ui.runnerHealth.textContent = `silent ${(age / 1000).toFixed(1)}s`;
      setStatus('Runner may be frozen', 'bad');
    }
    if (state.ready && age > 5200) {
      state.freezeCount += 1;
      log(`Heartbeat missing for ${(age / 1000).toFixed(1)}s. Runner likely hung inside WASM.`, 'bad');
      if (ui.autoRecover.checked) forceReboot('watchdog freeze');
    }
  }

  function wireEvents() {
    ui.bootDefault.addEventListener('click', bootDefault);
    ui.bootDefaultSide.addEventListener('click', bootDefault);
    ui.bootPicked.addEventListener('click', () => ui.wasmFile.click());
    ui.wasmFile.addEventListener('change', () => bootFile(ui.wasmFile.files && ui.wasmFile.files[0]));
    ui.forceReboot.addEventListener('click', () => forceReboot('manual'));
    ui.detach.addEventListener('click', openDetached);
    ui.focus.addEventListener('click', () => send('focus', {}));
    ui.fullscreen.addEventListener('click', () => {
      const el = ui.shell;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else el.requestFullscreen?.().catch((err) => log(`Fullscreen failed: ${err.message || err}`, 'bad'));
    });
    ui.arm.addEventListener('click', toggleArm);
    ui.tilt.addEventListener('click', toggleTilt);
    ui.blast.addEventListener('click', () => {
      ui.shell.classList.toggle('fx', ui.visualFx.checked);
      send('blast', { settings: settings() });
      setTimeout(() => ui.shell.classList.remove('fx'), 550);
    });
    ui.panic.addEventListener('click', hardPanic);
    ui.softPanic.addEventListener('click', softPanic);
    ui.snapshot.addEventListener('click', () => send('snapshot', {}));
    ui.restore.addEventListener('click', () => send('restore', {}));
    ui.undo.addEventListener('click', () => send('undo', {}));
    ui.resetUi.addEventListener('click', () => {
      try { localStorage.removeItem(SETTINGS_KEY); } catch (_) {}
      location.reload();
    });
    ['mode', 'target', 'strength', 'speed', 'tiltBias', 'rangeStart', 'rangeEnd', 'protectLow', 'smartGuard', 'crashGuard', 'autoRecover', 'visualFx', 'autoBoot'].forEach((key) => {
      ui[key].addEventListener('input', syncOutputs);
      ui[key].addEventListener('change', syncOutputs);
    });
    ['dragenter', 'dragover'].forEach((type) => ui.dropZone.addEventListener(type, (ev) => {
      ev.preventDefault(); ui.dropZone.classList.add('dragging');
    }));
    ['dragleave', 'drop'].forEach((type) => ui.dropZone.addEventListener(type, (ev) => {
      ev.preventDefault(); ui.dropZone.classList.remove('dragging');
    }));
    ui.dropZone.addEventListener('drop', (ev) => bootFile(ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]));
    window.addEventListener('message', onRunnerMessage);
  }

  function bootShell() {
    loadSettings();
    syncOutputs();
    wireEvents();
    createFrame();
    enableRuntimeButtons(false);
    state.watchdog = setInterval(watchdogTick, 1000);
    setStatus('Supervisor ready', 'idle');
    log('Supervisor loaded. The game runs in a sandboxed child runner instead of this UI page.', 'good');
    if (ui.autoBoot.checked && location.protocol !== 'file:') setTimeout(bootDefault, 250);
  }

  bootShell();
})();

const GEN_BASE = "https://gen.pollinations.ai";
const MEDIA_BASE = "https://media.pollinations.ai";
const ENTER_BASE = "https://enter.pollinations.ai";
const CLIENT_ID = "pk_VIepF2clCLKh5xiX";
const REALTIME_MODEL = "gpt-realtime-2";
// Seconds of lookahead kept between the playback clock and now, so a late audio
// delta over a jittery (often mobile) connection can't open an audible gap.
const PLAYBACK_JITTER = 0.16;
const CODER_SYSTEM_PROMPT = [
  "You are a coding assistant embedded in a voice agent. Your reply is parsed by software, so follow this output contract exactly.",
  "",
  "RUNNABLE WEB PROJECTS (any app, page, game, tool, demo, or visualization the user could open in a browser):",
  "1. Return exactly ONE complete, self-contained HTML document.",
  "2. Wrap the document in a single fenced block that opens with ```html on its own line and closes with ``` on its own line. Use no other ```html blocks.",
  "3. The document must start with `<!doctype html>` and contain <html>, <head>, and <body>.",
  "4. Inline ALL CSS in <style> and ALL JavaScript in <script>. No external files, imports, bundlers, build steps, or CDN URLs unless the user explicitly asks.",
  "5. Put no prose before the code block. After the closing ```, add at most two short sentences describing the result.",
  "",
  "STANDALONE NON-WEB FILES (a script, module, config, stylesheet, query, etc. in any language — Python, JS, TS, CSS, SQL, Go, Rust, shell, JSON, YAML, Markdown, …):",
  "- Return the complete file as a SINGLE fenced block tagged with its language, e.g. ```python … ``` or ```css … ```. It will be saved to the gallery as a downloadable file with the correct extension.",
  "- Put no prose before the block. After the closing ```, add at most two short sentences.",
  "- If it helps, name the file on the fence info line, e.g. ```python title=scraper.py — but the language tag alone is enough.",
  "",
  "SHORT SNIPPETS / EXPLANATIONS / DEBUGGING (not a whole file):",
  "- Answer normally in prose with standard fenced code blocks. These are shown inline, not saved as files.",
  "- Reserve the ```html block for one full runnable document only.",
  "",
  "ALWAYS: never invent or hardcode secret API keys or credentials; use clearly named placeholders.",
].join("\n");

const WIDGET_GUIDE = [
  "Rules:",
  "- Inline ALL CSS and JS. No external files, imports, CDNs, fonts, or network requests.",
  "- DARK THEME ONLY. The host card is dark. Set `color-scheme: dark`, a dark/transparent page background (never white or light), and light text (~#eef1ff). Style inputs/buttons explicitly dark — do not rely on default (bright) form-control styling. Accent with one or two colors, not large bright fills.",
  "- Be fluid and bounded: fill 100% width, never exceed it; keep height ~240-420px (scrolls if taller); use box-sizing:border-box and avoid fixed pixel widths.",
  "- Make it genuinely interactive and useful for the spec (controls, canvas, calculations, live editing).",
  "- No secret keys, no alert() spam, no infinite loops.",
  "",
  "PERSISTENT STORAGE — the host injects a global `WidgetStore` you SHOULD use so the user's data survives reloads, saving, and downloading:",
  "  WidgetStore.load()        -> returns the previously saved data object (or null on first run). Restore your UI from it on startup.",
  "  WidgetStore.save(obj)     -> persist the current data object. Call it whenever the user edits something (e.g. a spreadsheet cell, a list, settings).",
  "  WidgetStore.requestDownload() -> ask the host to download this widget as a standalone file.",
  "Build data-backed tools (spreadsheets, trackers, note pads, editors) on top of WidgetStore so nothing is lost.",
  "",
  "MEDIA ASSETS — `WidgetStore.assets` is an array of the gallery items the user attached: each is { kind:'image'|'video'|'audio', name, prompt, url }.",
  "Use `item.url` directly as the src of <img>/<video>/<audio>. The urls are self-contained (data URLs) so they keep working after download.",
].join("\n");

const WIDGET_SYSTEM_PROMPT = [
  "You build ONE small, self-contained, interactive HTML widget/mini-app that gets embedded in a card inside a dark, glassy web app.",
  "Output exactly one complete HTML document inside a single ```html code block, then nothing else.",
  WIDGET_GUIDE,
].join("\n");

const WIDGET_EDIT_SYSTEM_PROMPT = [
  "You are editing an EXISTING self-contained HTML widget/mini-app. You will be given its current full document and a change request.",
  "Apply the requested changes and return the COMPLETE updated document inside a single ```html code block, then nothing else.",
  "Preserve everything that still works; only change what the request implies. Keep using the injected WidgetStore for persistence (do not remove saved-data handling).",
  WIDGET_GUIDE,
].join("\n");

const state = {
  apiKey: localStorage.getItem("pollinations_api_key") || "",
  mode: "realtime",
  realtime: null,
  realtimeHealthTimer: null,
  balanceTimer: null,
  mediaRecorder: null,
  gibber: null,
  chunks: [],
  generationActive: 0,
  generationQueue: [],
  genJobs: [],
  modelMeta: { text: [], image: [], audio: [], embeddings: [] },
  stoppingRealtime: false,
  messages: JSON.parse(localStorage.getItem("conversation") || "[]"),
  memory: JSON.parse(localStorage.getItem("agent_memory") || "[]"),
  workspace: JSON.parse(localStorage.getItem("workspace") || "[]"),
  settings: JSON.parse(localStorage.getItem("settings") || "{}"),
  mcps: JSON.parse(localStorage.getItem("mcp_servers") || "[]"),
  flags: JSON.parse(localStorage.getItem("feature_flags") || "{}"),
  camera: null,
  pendingImages: [],
  workspaceIndex: 0,
  bargeThreshold: clampGate(Number(localStorage.getItem("barge_threshold") ?? 0.085)),
  micClaimed: false, // once a mode grabs the mic, switching modes needs a refresh
  stageView: "orb",
  lastError: null, // most recent API/generation failure, for the network_issue tool
};

// Mic noise gate for realtime barge-in: the local RMS a sound must exceed (while
// the model is speaking) to count as the user interrupting. User-tunable.
function clampGate(value) {
  return Number.isFinite(value) ? Math.min(0.4, Math.max(0.01, value)) : 0.085;
}

function setBargeThreshold(value) {
  state.bargeThreshold = clampGate(value);
  localStorage.setItem("barge_threshold", String(state.bargeThreshold));
}

// Feature toggles surfaced in the Config panel. Defaults chosen so the app works
// out of the box; the user can disable any of them.
const FLAG_DEFAULTS = {
  endConversation: true,   // let the agent stop the session when the user asks
  voiceInterrupt: true,    // barge-in: user speech cuts off the model in realtime
  autosaveUploads: true,   // uploaded images land in the gallery automatically
  camera: false,           // allow attaching live camera frames in realtime
  saveToDisk: true,        // desktop: mirror generated media to real files
  allowShell: false,       // desktop: let the agent run shell commands (with approval)
};

// ---------------------------------------------------------------------------
// Native (desktop) bridge — progressive enhancement. Inside the Tauri desktop
// shell, window.__TAURI__ is injected (withGlobalTauri) and we light up the
// filesystem + shell + local-storage tools. On the web (GitHub Pages) it's null
// and nothing changes: one codebase, two capability tiers.
// ---------------------------------------------------------------------------
const NATIVE = (() => {
  const t = typeof window !== "undefined" ? window.__TAURI__ : null;
  const invoke = t && ((t.core && t.core.invoke) || t.invoke);
  return invoke ? { invoke: (cmd, args) => invoke(cmd, args) } : null;
})();
function nativeAvailable() { return !!NATIVE; }
async function nativeInvoke(cmd, args) {
  if (!NATIVE) throw new Error("Native bridge unavailable (this is the web build).");
  return NATIVE.invoke(cmd, args || {});
}

// Reflect desktop vs web in the Config panel and show the active workspace folder.
async function renderDesktopStatus() {
  if (!el.desktopStatus) return;
  if (!nativeAvailable()) {
    el.desktopStatus.textContent = "Web mode — download the desktop app for local files, a real coding agent, and shell access.";
    el.desktopControls?.classList.add("hidden");
    return;
  }
  el.desktopControls?.classList.remove("hidden");
  let root = "";
  try { root = await nativeInvoke("workspace_root"); } catch { /* not chosen yet */ }
  el.desktopStatus.textContent = root
    ? `Desktop mode — full features on. Workspace: ${root}`
    : "Desktop mode — choose a workspace folder to store files and generated media.";
}

async function pickWorkspaceFolder() {
  if (!nativeAvailable()) return;
  try { await nativeInvoke("pick_workspace"); await renderDesktopStatus(); }
  catch (error) { addMessage("system", `Could not set workspace folder: ${(error && error.message) || error}`); }
}

function flag(name) {
  return state.flags[name] ?? FLAG_DEFAULTS[name] ?? false;
}

function setFlag(name, value) {
  state.flags[name] = !!value;
  localStorage.setItem("feature_flags", JSON.stringify(state.flags));
}

function wireFlag(id, name) {
  const box = document.querySelector(`#${id}`);
  if (!box) return;
  box.checked = flag(name);
  box.addEventListener("change", () => setFlag(name, box.checked));
}

const el = {
  authState: document.querySelector("#authState"),
  keyHealth: document.querySelector("#keyHealth"),
  pollenBalance: document.querySelector("#pollenBalance"),
  connectByop: document.querySelector("#connectByop"),
  clearKey: document.querySelector("#clearKey"),
  modeRealtime: document.querySelector("#modeRealtime"),
  modePush: document.querySelector("#modePush"),
  modeGibber: document.querySelector("#modeGibber"),
  mainAction: document.querySelector("#mainAction"),
  stopAction: document.querySelector("#stopAction"),
  orb: document.querySelector("#orb"),
  orbBlob: document.querySelector(".orb-blob"),
  orbBars: document.querySelector(".orb-bars"),
  orbRings: document.querySelector(".orb-rings"),
  orbDots: document.querySelector(".orb-dots"),
  orbPoof: document.querySelector(".orb-poof"),
  orbLabel: document.querySelector(".orb-label"),
  mediaDock: document.querySelector("#mediaDock"),
  genDock: document.querySelector("#genDock"),
  realtimeStatus: document.querySelector("#realtimeStatus"),
  modelAudio: document.querySelector("#modelAudio"),
  transcript: document.querySelector("#transcript"),
  textForm: document.querySelector("#textForm"),
  textInput: document.querySelector("#textInput"),
  imageInput: document.querySelector("#imageInput"),
  attachImage: document.querySelector("#attachImage"),
  attachStrip: document.querySelector("#attachStrip"),
  inlineChat: document.querySelector("#inlineChat"),
  inlineTranscript: document.querySelector("#inlineTranscript"),
  inlineTextForm: document.querySelector("#inlineTextForm"),
  inlineTextInput: document.querySelector("#inlineTextInput"),
  inlineImageInput: document.querySelector("#inlineImageInput"),
  inlineAttachImage: document.querySelector("#inlineAttachImage"),
  inlineAttachStrip: document.querySelector("#inlineAttachStrip"),
  chatToggle: document.querySelector("#chatToggle"),
  desktopStatus: document.querySelector("#desktopStatus"),
  desktopControls: document.querySelector("#desktopControls"),
  pickWorkspace: document.querySelector("#pickWorkspace"),
  cameraToggle: document.querySelector("#cameraToggle"),
  cameraPreview: document.querySelector("#cameraPreview"),
  clearConversation: document.querySelector("#clearConversation"),
  clearWorkspace: document.querySelector("#clearWorkspace"),
  adaptiveWorkspace: document.querySelector("#adaptiveWorkspace"),
  workspaceMode: document.querySelector("#workspaceMode"),
  clearGallery: document.querySelector("#clearGallery"),
  gallery: document.querySelector("#gallery"),
  mcpForm: document.querySelector("#mcpForm"),
  mcpName: document.querySelector("#mcpName"),
  mcpUrl: document.querySelector("#mcpUrl"),
  mcpList: document.querySelector("#mcpList"),
  modelStatus: document.querySelector("#modelStatus"),
  soundToggle: document.querySelector("#soundToggle"),
  soundVolume: document.querySelector("#soundVolume"),
  bargeGate: document.querySelector("#bargeGate"),
  memoryList: document.querySelector("#memoryList"),
  clearMemory: document.querySelector("#clearMemory"),
  widgetList: document.querySelector("#widgetList"),
  clearWidgets: document.querySelector("#clearWidgets"),
  navButtons: document.querySelectorAll(".nav-button"),
  drawerCloses: document.querySelectorAll(".drawer-close"),
};

const fields = [
  "uiStyle",
  "themePreset",
  "layoutPreset",
  "personalityPreset",
  "textModel",
  "searchModel",
  "realtimeVoice",
  "coderModel",
  "sttModel",
  "ttsModel",
  "ttsVoice",
  "embeddingModel",
  "imageModel",
  "videoModel",
  "audioModel",
  "imageSize",
  "imageCount",
  "videoAspect",
  "videoDuration",
  "videoCount",
  "videoAudio",
  "musicDuration",
  "audioCount",
];

// ---------------------------------------------------------------------------
// Interface sound engine. One looping channel for "busy" states (ref-counted so
// overlapping generations don't double-play) plus one-shot earcons. Decoded via
// Web Audio for gapless looping; resumes on first user gesture (autoplay policy).
// ---------------------------------------------------------------------------
const SOUND_FILES = {
  convoStart: "sounds/1_ConvoStart.ogg",
  generationLoop: "sounds/2_GenerationLoop.ogg",
  error: "sounds/3_Error.ogg",
  genComplete: "sounds/4_GenComplete.ogg",
  convoEnd: "sounds/5_ConvoEnd.ogg",
  inputReq: "sounds/6_InputReq.ogg",
  messageReceive: "sounds/7_MessageReceive.ogg",
  messageSend: "sounds/8_MessageSend.ogg",
  connect: "sounds/9_Connect.ogg",
};

const sound = {
  ctx: null,
  master: null,
  buffers: {},
  loopRefs: 0,
  loopNode: null,
  loopGain: null,
  muted: localStorage.getItem("sound_muted") === "1",
  volume: clamp01(Number(localStorage.getItem("sound_volume") ?? 0.7)),
};

function clamp01(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.7;
}

function initSound() {
  try {
    sound.ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return;
  }
  sound.master = sound.ctx.createGain();
  sound.master.gain.value = sound.muted ? 0 : sound.volume;
  sound.master.connect(sound.ctx.destination);
  const resume = () => sound.ctx?.resume?.().catch(() => {});
  window.addEventListener("pointerdown", resume);
  window.addEventListener("keydown", resume);
  Object.entries(SOUND_FILES).forEach(async ([key, url]) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      sound.buffers[key] = await sound.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      /* missing/undecodable sound: stay silent for that cue */
    }
  });
}

function playSound(key) {
  const { ctx, master } = sound;
  const buffer = sound.buffers[key];
  if (!ctx || !master || !buffer || sound.muted) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(master);
  node.start();
}

function startLoop() {
  sound.loopRefs += 1;
  if (sound.loopNode || sound.muted) return;
  const { ctx, master } = sound;
  const buffer = sound.buffers.generationLoop;
  if (!ctx || !master || !buffer) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  node.connect(gain);
  gain.connect(master);
  node.start();
  gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.18);
  sound.loopNode = node;
  sound.loopGain = gain;
}

function stopLoop(force) {
  sound.loopRefs = force ? 0 : Math.max(0, sound.loopRefs - 1);
  if (sound.loopRefs > 0) return;
  const { ctx, loopNode, loopGain } = sound;
  sound.loopNode = null;
  sound.loopGain = null;
  if (!ctx || !loopNode) return;
  const now = ctx.currentTime;
  try {
    loopGain.gain.cancelScheduledValues(now);
    loopGain.gain.setValueAtTime(loopGain.gain.value, now);
    loopGain.gain.linearRampToValueAtTime(0, now + 0.2);
    loopNode.stop(now + 0.24);
  } catch {
    /* node may already be stopped */
  }
}

function setSoundMuted(muted) {
  sound.muted = muted;
  localStorage.setItem("sound_muted", muted ? "1" : "0");
  if (sound.master) sound.master.gain.value = muted ? 0 : sound.volume;
  if (muted) stopLoop(true);
  if (el.soundToggle) el.soundToggle.textContent = muted ? "🔇" : "🔊";
}

function setSoundVolume(value) {
  sound.volume = clamp01(value);
  localStorage.setItem("sound_volume", String(sound.volume));
  if (sound.master && !sound.muted) sound.master.gain.value = sound.volume;
}

async function busy(task) {
  startLoop();
  try {
    return await task();
  } finally {
    stopLoop();
  }
}

function init() {
  loadSettings();
  applyPresets();
  initSound();
  captureByopReturn();
  bindEvents();
  renderAuth();
  renderMessages();
  renderWorkspace();
  renderMcpServers();
  renderMemory();
  renderGallery();
  renderSavedWidgets();
  loadLiveModels();
  checkKeyHealth();
  startBalancePolling();
  startVizLoop();
}

function bindEvents() {
  el.connectByop.addEventListener("click", connectByop);
  el.clearKey.addEventListener("click", clearApiKey);
  el.modeRealtime.addEventListener("click", () => setMode("realtime"));
  el.modePush.addEventListener("click", () => setMode("push"));
  el.modeGibber.addEventListener("click", () => setMode("gibber"));
  el.mainAction.addEventListener("click", handleMainAction);
  el.stopAction.addEventListener("click", stopAll);
  el.textForm?.addEventListener("submit", handleTextSubmit);
  el.attachImage?.addEventListener("click", () => el.imageInput?.click());
  el.imageInput?.addEventListener("change", () => handleImageUpload([...el.imageInput.files]).finally(() => { el.imageInput.value = ""; }));
  el.inlineTextForm?.addEventListener("submit", handleTextSubmit);
  el.inlineAttachImage?.addEventListener("click", () => el.inlineImageInput?.click());
  el.inlineImageInput?.addEventListener("change", () => handleImageUpload([...el.inlineImageInput.files]).finally(() => { el.inlineImageInput.value = ""; }));
  el.chatToggle?.addEventListener("click", () => setStageView(state.stageView === "chat" ? "orb" : "chat"));
  setStageView(localStorage.getItem("stage_view") === "chat" ? "chat" : "orb");
  el.cameraToggle?.addEventListener("click", toggleCamera);
  el.clearConversation?.addEventListener("click", clearConversation);
  el.clearWorkspace.addEventListener("click", clearWorkspace);
  el.clearGallery.addEventListener("click", clearGallery);
  el.mcpForm.addEventListener("submit", addMcpServer);
  el.soundToggle.textContent = sound.muted ? "🔇" : "🔊";
  el.soundToggle.addEventListener("click", () => setSoundMuted(!sound.muted));
  el.soundVolume.value = String(Math.round(sound.volume * 100));
  el.soundVolume.addEventListener("input", () => setSoundVolume(Number(el.soundVolume.value) / 100));
  if (el.bargeGate) {
    el.bargeGate.value = String(Math.round(state.bargeThreshold * 100));
    el.bargeGate.addEventListener("input", () => setBargeThreshold(Number(el.bargeGate.value) / 100));
  }
  el.clearMemory.addEventListener("click", () => forgetMemory({ all: true }));
  el.clearWidgets?.addEventListener("click", clearSavedWidgets);
  wireFlag("flagEndConversation", "endConversation");
  wireFlag("flagVoiceInterrupt", "voiceInterrupt");
  wireFlag("flagAutosaveUploads", "autosaveUploads");
  wireFlag("flagCamera", "camera");
  wireFlag("flagSaveToDisk", "saveToDisk");
  wireFlag("flagAllowShell", "allowShell");
  el.pickWorkspace?.addEventListener("click", pickWorkspaceFolder);
  renderDesktopStatus();
  window.addEventListener("message", handleWidgetMessage);
  el.navButtons.forEach((button) => { if (button.dataset.drawer) button.addEventListener("click", () => toggleDrawer(button.dataset.drawer)); });
  el.drawerCloses.forEach((button) => button.addEventListener("click", closeDrawers));
  el.scrim = document.createElement("div");
  el.scrim.className = "drawer-scrim";
  el.scrim.addEventListener("click", closeDrawers);
  document.body.append(el.scrim);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawers(); });
  fields.forEach((id) => document.querySelector(`#${id}`).addEventListener("change", () => {
    saveSettings();
    applyPresets();
  }));
}

function captureByopReturn() {
  const params = new URLSearchParams(location.hash.slice(1));
  const apiKey = params.get("api_key") || params.get("access_token");
  const error = params.get("error");
  if (apiKey) {
    state.apiKey = apiKey;
    localStorage.setItem("pollinations_api_key", apiKey);
    history.replaceState(null, "", location.pathname + location.search);
    addMessage("system", "Connected with your BYOP key. You can revoke it from the Pollinations dashboard.");
    playSound("connect");
    checkKeyHealth();
    startBalancePolling();
  } else if (error) {
    addMessage("system", `BYOP authorization failed: ${error}`);
  }
}

function connectByop() {
  const params = new URLSearchParams({
    redirect_uri: location.href.split("#")[0],
    client_id: CLIENT_ID,
    scope: "generate usage",
    state: crypto.randomUUID(),
  });
  location.href = `${ENTER_BASE}/authorize?${params}`;
}

async function loadLiveModels() {
  const lists = await Promise.allSettled([
    fetchModels("/text/models"),
    fetchModels("/image/models"),
    fetchModels("/audio/models"),
    fetchModels("/embeddings/models"),
  ]);
  const [text, image, audio, embeddings] = lists.map((result) => result.status === "fulfilled" ? result.value : []);
  state.modelMeta = { text, image, audio, embeddings };
  fillSelect("textModel", text.map(modelName), "openai");
  fillSelect("searchModel", searchModelsOnly().map(modelName), "gemini-search");
  fillSelect("coderModel", text.map(modelName), "qwen-coder");
  fillSelect("imageModel", imageModelsOnly().map(modelName), "flux");
  fillSelect("videoModel", videoModelsOnly().map(modelName), "ltx-2");
  const tts = ttsModelsOnly();
  const music = musicModelsOnly();
  const stt = sttModelsOnly();
  fillSelect("audioModel", music.map(modelName), defaultModelName(music, "elevenmusic"));
  fillSelect("ttsModel", tts.map(modelName), defaultModelName(tts, "elevenflash", "qwen-tts", "elevenlabs"));
  fillSelect("sttModel", stt.map(modelName), defaultModelName(stt, "whisper"));
  fillSelect("embeddingModel", embeddings.map(modelName), "openai-3-small");
  // A previously-saved invalid audio model (e.g. the old "openai-audio") breaks
  // TTS/music; force the selection back to a real model from the live list.
  coerceSelect("audioModel", music, defaultModelName(music, "elevenmusic"));
  coerceSelect("ttsModel", tts, defaultModelName(tts, "elevenflash", "qwen-tts", "elevenlabs"));
  coerceSelect("sttModel", stt, defaultModelName(stt, "whisper"));
  const loaded = [text, image, audio, embeddings].filter((items) => items.length).length;
  el.modelStatus.textContent = loaded
    ? `Loaded live model dropdowns from ${loaded}/4 Pollinations model endpoints.`
    : "Could not load live model dropdowns. Defaults are still available.";
}

async function fetchModels(path) {
  const res = await fetch(`${GEN_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
}

function modelName(row) {
  if (!row) return "";
  if (typeof row === "string") return row;
  return row.id || row.name || row.model || row.alias || "";
}

function modelText(row) {
  return JSON.stringify(row || {}).toLowerCase();
}

function imageModelsOnly() {
  return state.modelMeta.image.filter((model) => !isVideoModel(model));
}

function videoModelsOnly() {
  return state.modelMeta.image.filter(isVideoModel);
}

function searchModelsOnly() {
  const list = state.modelMeta.text || [];
  const search = list.filter((model) => model?.capabilities?.web_search || /search|perplexity/i.test(modelName(model) || ""));
  return search.length ? search : list;
}

// Split the live audio model list by role. TTS models carry a voice list (or a
// speech-y name); music/sfx and speech-to-text are matched by name. This is what
// fixes TTS picking a non-existent model like the old hardcoded "openai-audio".
function audioModelsByKind() {
  const list = state.modelMeta.audio || [];
  const tts = [];
  const music = [];
  const stt = [];
  for (const model of list) {
    const name = (modelName(model) || "").toLowerCase();
    const voices = model.voices || model.supported_voices || model.supportedVoices || model.voice;
    const hasVoices = Array.isArray(voices) ? voices.length > 0 : Boolean(voices);
    if (/whisper|scribe|universal|transcri|\bstt\b/.test(name)) stt.push(model);
    else if (/music|acestep|stable-audio|sfx|song|sound-?effect/.test(name)) music.push(model);
    else if (hasVoices || /tts|eleven|qwen-tts|speech|voice|narrat/.test(name)) tts.push(model);
    else music.push(model);
  }
  return { tts, music, stt };
}

function ttsModelsOnly() { return audioModelsByKind().tts; }
function musicModelsOnly() { return audioModelsByKind().music; }
function sttModelsOnly() { return audioModelsByKind().stt; }

function defaultModelName(list, ...preferred) {
  const names = list.map(modelName).filter(Boolean);
  for (const name of preferred) if (names.includes(name)) return name;
  return names[0] || preferred[0];
}

function ttsModelName() {
  const current = value("ttsModel");
  const names = ttsModelsOnly().map(modelName);
  if (names.length && !names.includes(current)) return defaultModelName(ttsModelsOnly(), "elevenflash", "qwen-tts", "elevenlabs");
  return current || "elevenflash";
}

// Force a select onto a valid live model when its saved value isn't real anymore.
function coerceSelect(id, liveList, fallback) {
  if (!liveList.length) return;
  const names = liveList.map(modelName);
  const select = document.querySelector(`#${id}`);
  if (!select || names.includes(select.value)) return;
  select.value = names.includes(fallback) ? fallback : names[0];
  saveSettings();
}

function searchModel() {
  const current = value("searchModel");
  if (current) return current;
  const list = state.modelMeta.text || [];
  const found = list.find((model) => model?.capabilities?.web_search) || list.find((model) => /search|perplexity/i.test(modelName(model) || ""));
  return modelName(found) || "gemini-search";
}

function isVideoModel(model) {
  const name = (modelName(model) || "").toLowerCase();
  // Image-only models can contain video-ish substrings (e.g. wan-image, gptimage,
  // grok-imagine, nova-canvas); never treat those as video.
  if (/image|imagine|canvas/.test(name)) return false;
  const text = modelText(model);
  return /video|veo|\bwan\b|wan-|seedance|ltx|reel|p-video/.test(`${name} ${text}`);
}

// True only when the model can actually take a source/reference image (image edit
// or image-to-video). Metadata from /image/models is authoritative; the name
// fallback lists known editing/i2v families and deliberately avoids the bare word
// "image" (every image model contains it, which made the old check always true).
function supportsImageInput(modelNameValue) {
  const name = String(modelNameValue || "").toLowerCase();
  const model = state.modelMeta.image.find((entry) => modelName(entry) === modelNameValue);
  if (model && typeof model === "object") {
    const caps = model.capabilities || model.capability || {};
    if (caps.image_to_image || caps.image_input || caps.imageInput || caps.img2img || caps.edit || caps.editing || caps.inpainting || caps.reference) return true;
    const inputs = []
      .concat(model.input_modalities || model.inputModalities || [])
      .concat(model.modalities && model.modalities.input ? model.modalities.input : [])
      .concat(Array.isArray(model.input) ? model.input : []);
    if (inputs.some((m) => /image/i.test(String(m)))) return true;
    if (model.image === true || model.imageToImage === true || model.reference === true || model.supportsImage === true) return true;
    const params = model.params || model.parameters || model.supportedParams || [];
    if (Array.isArray(params) && params.some((p) => /^image$/i.test(String(p)))) return true;
  }
  return /kontext|nanobanana|nano-banana|gptimage|gpt-image|p-image-edit|qwen-image|seedream|grok-imagine|i2v|img2img|image-?edit|veo|seedance|\bwan\b|wan-|ltx|kling|grok-video|reel/.test(name);
}

function fillSelect(id, names, fallback) {
  const select = document.querySelector(`#${id}`);
  const current = state.settings[id] || select.value || fallback;
  const options = [...new Set([current, fallback, ...names].filter(Boolean))];
  select.innerHTML = "";
  for (const name of options) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  select.value = options.includes(current) ? current : fallback;
}

function clearApiKey() {
  state.apiKey = "";
  localStorage.removeItem("pollinations_api_key");
  stopBalancePolling();
  renderAuth();
}

function renderAuth() {
  el.authState.textContent = state.apiKey ? "Connected" : "Not connected";
  el.authState.classList.toggle("danger", !state.apiKey);
  if (!state.apiKey) {
    setKeyHealth("Connect BYOP to check key status.", "idle");
    setBalanceText("Pollen --");
  }
}

function openDrawer(id) {
  document.querySelectorAll(".drawer").forEach((drawer) => drawer.classList.toggle("active", drawer.id === id));
  // Only drawer-bound nav buttons reflect drawer state; the Chat toggle's active
  // state is owned by setStageView (inline chat), so leave it alone.
  el.navButtons.forEach((button) => { if (button.dataset.drawer) button.classList.toggle("active", button.dataset.drawer === id); });
  el.scrim?.classList.add("active");
}

function toggleDrawer(id) {
  const open = document.getElementById(id)?.classList.contains("active");
  if (open) closeDrawers();
  else openDrawer(id);
}

function closeDrawers() {
  document.querySelectorAll(".drawer").forEach((drawer) => drawer.classList.remove("active"));
  el.navButtons.forEach((button) => { if (button.dataset.drawer) button.classList.remove("active"); });
  el.scrim?.classList.remove("active");
}

function applyPresets() {
  document.body.dataset.uistyle = value("uiStyle") || "refine";
  document.body.dataset.theme = value("themePreset") || "aurora";
  document.body.dataset.layout = value("layoutPreset") || "focus";
  document.body.dataset.personality = value("personalityPreset") || "operator";
}

async function checkKeyHealth() {
  if (!state.apiKey) return;
  setKeyHealth("Checking key status and balance...", "idle");
  const [keyResult, balanceResult] = await Promise.allSettled([
    fetchAccountJson("/account/key"),
    fetchAccountJson("/account/balance"),
  ]);
  if (keyResult.status === "rejected") {
    setKeyHealth("Key check failed. Reconnect BYOP or verify the key has account access.", "warning");
    return;
  }
  const key = keyResult.value;
  const balance = balanceResult.status === "fulfilled" ? balanceResult.value : null;
  const keyType = key.type || key.keyType || (state.apiKey.startsWith("sk_") ? "user key" : "publishable");
  const balanceText = formatBalance(balance);
  if (balanceText) setBalanceText(balanceText);
  setKeyHealth(`Key valid: ${keyType}${balanceText ? ` / ${balanceText}` : ""}.`, "healthy");
}

function startBalancePolling() {
  if (!state.apiKey) return;
  stopBalancePolling();
  refreshBalance();
  state.balanceTimer = setInterval(refreshBalance, 15000);
}

function stopBalancePolling() {
  clearInterval(state.balanceTimer);
  state.balanceTimer = null;
}

async function refreshBalance() {
  if (!state.apiKey) return;
  try {
    const balance = await fetchAccountJson("/account/balance");
    const text = formatBalance(balance);
    if (text) setBalanceText(text);
  } catch (error) {
    setBalanceText("Pollen unavailable");
  }
}

async function fetchAccountJson(path) {
  const res = await fetch(`${GEN_BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

function formatBalance(balance) {
  if (!balance || typeof balance !== "object") return "";
  const amount = balance.balance ?? balance.pollen ?? balance.remaining ?? balance.amount;
  if (amount === undefined || amount === null) return "";
  const num = Number(amount);
  const shown = Number.isFinite(num) ? (Math.round(num * 100) / 100).toLocaleString() : amount;
  return `${shown} pollen`;
}

function setBalanceText(text) {
  el.pollenBalance.textContent = text;
}

function setKeyHealth(text, stateName) {
  el.keyHealth.textContent = text;
  el.keyHealth.classList.toggle("healthy", stateName === "healthy");
  el.keyHealth.classList.toggle("warning", stateName === "warning");
}

function setMode(mode) {
  // Once a mode has claimed the microphone, switching live tends to leave the mic
  // in a bad state (half-released streams, doubled getUserMedia, echo loops). So we
  // lock the mode after first use and require a refresh to switch — a clean slate.
  // Same-mode clicks are ignored; different-mode clicks explain the refresh rule.
  if (state.micClaimed) {
    if (mode !== state.mode) promptRefreshToSwitchMode();
    return;
  }
  stopAll();
  state.mode = mode;
  el.modeRealtime.classList.toggle("active", mode === "realtime");
  el.modePush.classList.toggle("active", mode === "push");
  el.modeGibber.classList.toggle("active", mode === "gibber");
  el.mainAction.textContent = mode === "realtime" ? "Start realtime" : mode === "gibber" ? "Start gibberlink" : "Hold to talk";
}

// Called right after a mode successfully acquires the mic. Locks the mode toggle.
function claimMic() {
  if (state.micClaimed) return;
  state.micClaimed = true;
  lockModeToggle();
}

// Lock the whole mode toggle once the mic is claimed. Buttons stay tappable (so a
// tap can explain the refresh rule, including on touch where there's no tooltip) but
// setMode ignores them. The .active one stays marked so you see which mode you're in.
function lockModeToggle() {
  [el.modeRealtime, el.modeGibber, el.modePush].forEach((button) => {
    if (!button) return;
    button.classList.add("locked");
    button.title = "Refresh the page to switch modes (keeps the microphone clean)";
  });
}

function promptRefreshToSwitchMode() {
  setRealtimeStatus("Refresh the page to switch modes — it keeps the microphone clean.", "warning");
  addMessage("system", "To switch modes (Realtime / Push2Talk / Gibberlink), refresh the page first. Switching live can leave the microphone in a bad state, so each mode starts from a clean slate.");
  playSound("error");
}

async function handleMainAction() {
  if (!requireKey()) return;
  if (state.mode === "realtime") {
    if (state.realtime) stopRealtime();
    else {
      try {
        await startRealtime();
      } catch (error) {
        setRealtimeStatus(error.message || "Realtime failed to start.", "warning");
        addMessage("system", `Realtime failed to start: ${error.message || error}`);
        playSound("error");
        stopRealtime();
      }
    }
    return;
  }
  if (state.mode === "gibber") {
    if (state.gibber) stopGibberlink();
    else {
      try {
        await startGibberlink();
      } catch (error) {
        setRealtimeStatus(error.message || "Gibberlink failed to start.", "warning");
        addMessage("system", `Gibberlink failed to start: ${error.message || error}`);
        playSound("error");
        stopGibberlink();
      }
    }
    return;
  }
  if (state.mediaRecorder?.state === "recording") stopPushRecording();
  else await startPushRecording();
}

function requireKey() {
  if (state.apiKey) return true;
  addMessage("system", "Connect BYOP first so requests spend the user's own Pollen, not a bundled secret.");
  return false;
}

async function startRealtime() {
  state.stoppingRealtime = false;
  setRealtimeStatus("Requesting microphone...", "live");
  const audioContext = new AudioContext({ sampleRate: 24000 });
  // Mobile browsers (iOS Safari especially) start audio contexts suspended and will
  // chop or drop scheduled playback until resumed inside a user gesture. The Start
  // button is that gesture, so resume here.
  await audioContext.resume().catch(() => {});
  const output = audioContext.createMediaStreamDestination();
  el.modelAudio.srcObject = output.stream;
  el.modelAudio.playsInline = true;
  await el.modelAudio.play().catch(() => {});

  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  claimMic();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const mutedMonitor = audioContext.createGain();
  mutedMonitor.gain.value = 0;
  const analyser = makeOrbAnalyser(audioContext);
  source.connect(analyser); // mic drives the orb while listening
  const socket = new WebSocket(`${GEN_BASE.replace("https", "wss")}/v1/realtime?model=${REALTIME_MODEL}&key=${encodeURIComponent(state.apiKey)}`);

  state.realtime = { socket, stream, audioContext, processor, output, mutedMonitor, analyser, nextStart: audioContext.currentTime, gotSession: false, gotAudio: false, retriedWithoutVoice: false, handledCalls: new Set(), scheduled: [], responseActive: false, bargeFrames: 0, audioTailUntil: 0 };
  setOrb("listening");
  startOrbViz(analyser);
  el.mainAction.textContent = "Stop realtime";
  setRealtimeStatus("Opening realtime socket...", "live");

  socket.addEventListener("open", () => {
    setRealtimeStatus("Socket open. Configuring audio session...", "live");
    socket.send(JSON.stringify({ type: "session.update", session: realtimeSessionConfig(true) }));
    source.connect(processor);
    processor.connect(mutedMonitor);
    mutedMonitor.connect(audioContext.destination);
    state.realtimeHealthTimer = setTimeout(() => {
      if (state.realtime && !state.realtime.gotAudio) {
        setRealtimeStatus("Connected, but no model audio yet. Speak a short phrase or switch to Push2Talk if this stays silent.", "warning");
      }
    }, 12000);
  });

  processor.onaudioprocess = (event) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const rt = state.realtime;
    const input = event.inputBuffer.getChannelData(0);
    // While the model is speaking, the mic still picks up its voice (imperfect echo
    // cancellation). Forwarding that makes the server VAD think the user spoke, so
    // it answers itself — endlessly when left idle. Gate the mic during playback;
    // only a sustained, loud local sound (a real barge-in) breaks through.
    const modelSpeaking = rt && (rt.responseActive || rt.scheduled.length > 0 || rt.audioContext.currentTime < (rt.audioTailUntil || 0));
    if (modelSpeaking) {
      if (!flag("voiceInterrupt")) { if (rt) rt.bargeFrames = 0; return; }
      let sum = 0;
      for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      if (rms < state.bargeThreshold) { rt.bargeFrames = 0; return; } // echo / room tone: ignore
      rt.bargeFrames = (rt.bargeFrames || 0) + 1;
      if (rt.bargeFrames < 2) return; // need it sustained to count as a barge-in
      interruptRealtime();
      rt.bargeFrames = 0;
    } else if (rt) {
      rt.bargeFrames = 0;
    }
    const pcm = floatToPcm16(input);
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: arrayBufferToBase64(pcm.buffer) }));
  };

  socket.addEventListener("message", (event) => handleRealtimeEvent(JSON.parse(event.data)));
  socket.addEventListener("close", (event) => handleRealtimeClose(event));
  socket.addEventListener("error", () => {
    setRealtimeStatus("Realtime socket error. Push2Talk is available as a fallback.", "warning");
    addMessage("system", "Realtime socket error. Try Push2Talk if the browser/network blocks WebSockets.");
  });
}

function handleRealtimeEvent(event) {
  if (event.type === "session.created" || event.type === "session.updated") {
    if (state.realtime && !state.realtime.gotSession) playSound("convoStart");
    if (state.realtime) state.realtime.gotSession = true;
    setRealtimeStatus("Realtime ready. Speak naturally.", "ready");
  }
  if ((event.type === "response.audio.delta" || event.type === "response.output_audio.delta") && event.delta) {
    if (state.realtime) state.realtime.gotAudio = true;
    setRealtimeStatus("Model voice playing.", "ready");
    setOrb("speaking");
    playPcmDelta(event.delta);
  }
  if (event.type === "response.audio_transcript.done" && event.transcript) addMessage("agent", event.transcript);
  if (event.type === "response.output_audio_transcript.done" && event.transcript) addMessage("agent", event.transcript);
  if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) addMessage("user", event.transcript);
  if (event.type === "input_audio_buffer.speech_started") {
    setOrb("user");
    setRealtimeStatus("Listening...", "live");
    // Barge-in: the user started talking over the model — cut its audio short and
    // cancel the in-flight response so it actually stops instead of talking past.
    const rt = state.realtime;
    if (flag("voiceInterrupt") && rt && (rt.scheduled.length || rt.responseActive)) interruptRealtime();
  }
  if (event.type === "input_audio_buffer.speech_stopped") setRealtimeStatus("Thinking...", "live");
  if (event.type === "response.function_call_arguments.done") {
    const rt = state.realtime;
    // Guard against the same function call being dispatched twice (which caused
    // the occasional double image/video generation).
    if (rt && event.call_id && rt.handledCalls.has(event.call_id)) return;
    if (rt && event.call_id) rt.handledCalls.add(event.call_id);
    runTool(event.name, JSON.parse(event.arguments || "{}"), event.call_id);
  }
  if (event.type === "response.created") {
    if (state.realtime) state.realtime.responseActive = true;
    setOrb("thinking");
    setRealtimeStatus("Thinking...", "live");
  }
  if (event.type === "error") {
    const message = event.error?.message || "Realtime returned an error.";
    // Interrupting races the server: cancelling a response that just finished
    // yields a harmless "no active response" / cancellation error. Ignore quietly.
    if (/cancel|no active response|already (cancel|complet|done|finish)|response_cancel/i.test(message)) return;
    if (/voice/i.test(message) && /unknown|unsupported|invalid|not (allowed|supported)|param/i.test(message) && state.realtime && !state.realtime.retriedWithoutVoice) {
      state.realtime.retriedWithoutVoice = true;
      state.realtime.socket.send(JSON.stringify({ type: "session.update", session: realtimeSessionConfig(false) }));
      setRealtimeStatus("Voice setting unsupported here; continuing with default realtime voice.", "warning");
      return;
    }
    setRealtimeStatus(message, "warning");
    playSound("error");
  }
  if (event.type === "response.done" || event.type === "response.cancelled") {
    if (state.realtime) state.realtime.responseActive = false;
    setOrb("listening");
    setRealtimeStatus("Realtime ready. Speak naturally.", "ready");
  }
}

function playPcmDelta(base64) {
  const rt = state.realtime;
  if (!rt) return;
  const bytes = base64ToBytes(base64);
  const view = new DataView(bytes.buffer);
  const samples = bytes.byteLength / 2;
  const buffer = rt.audioContext.createBuffer(1, samples, 24000);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples; i += 1) channel[i] = view.getInt16(i * 2, true) / 32768;
  const source = rt.audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(rt.output);
  if (rt.analyser) source.connect(rt.analyser); // model voice drives the orb while speaking
  // Jitter buffer: chunks arrive over a flaky network at irregular intervals. If we
  // schedule each one right at currentTime, a single late delta leaves an audible gap
  // and the voice "cuts out". Keep a small cushion ahead of the clock so brief hiccups
  // are absorbed; only when we've fully underrun (start of a burst, or playback caught
  // up to real time) do we re-arm the cushion.
  const now = rt.audioContext.currentTime;
  if (rt.nextStart < now + 0.02) rt.nextStart = now + PLAYBACK_JITTER;
  source.start(rt.nextStart);
  rt.nextStart += buffer.duration;
  // Track scheduled chunks so a barge-in can stop them immediately.
  rt.scheduled.push(source);
  source.onended = () => {
    if (state.realtime !== rt) return;
    rt.scheduled = rt.scheduled.filter((node) => node !== source);
    // Keep gating the mic briefly after the last chunk so the echo tail of the
    // model's own voice can't slip through and restart the loop.
    if (!rt.scheduled.length) rt.audioTailUntil = rt.audioContext.currentTime + 0.4;
  };
}

// Stop the model mid-utterance: kill every scheduled audio chunk, reset the
// playback clock, and tell the server to cancel the in-flight response.
function interruptRealtime() {
  const rt = state.realtime;
  if (!rt) return;
  for (const node of rt.scheduled) { try { node.onended = null; node.stop(); node.disconnect(); } catch { /* already ended */ } }
  rt.scheduled = [];
  rt.nextStart = rt.audioContext.currentTime;
  // Only cancel when a response is genuinely in flight, or the server errors with
  // "no active response". Always flush local audio regardless.
  if (rt.responseActive && rt.socket?.readyState === WebSocket.OPEN) {
    rt.socket.send(JSON.stringify({ type: "response.cancel" }));
    rt.responseActive = false;
  }
  setOrb("user");
  setRealtimeStatus("Interrupted — listening...", "live");
}

function stopRealtime() {
  const rt = state.realtime;
  if (!rt) return;
  playSound("convoEnd");
  state.stoppingRealtime = true;
  if (rt.socket?.readyState === WebSocket.OPEN || rt.socket?.readyState === WebSocket.CONNECTING) {
    rt.socket.close();
    return;
  }
  cleanupRealtime();
  setRealtimeStatus("Realtime idle", "idle");
}

function handleRealtimeClose(event) {
  const wasManual = state.stoppingRealtime;
  cleanupRealtime();
  refreshBalance();
  if (wasManual || event.code === 1000) {
    setRealtimeStatus("Realtime idle", "idle");
    return;
  }
  const reason = event.reason ? `: ${event.reason}` : "";
  setRealtimeStatus(`Realtime closed (${event.code || "unknown"})${reason}. Try reconnecting or use Push2Talk.`, "warning");
  addMessage("system", `Realtime closed (${event.code || "unknown"})${reason}.`);
  playSound("error");
}

function cleanupRealtime() {
  const rt = state.realtime;
  if (!rt) return;
  stopCamera(); // camera vision only makes sense during a live session
  clearTimeout(state.realtimeHealthTimer);
  state.realtimeHealthTimer = null;
  rt.processor?.disconnect();
  rt.mutedMonitor?.disconnect();
  rt.stream?.getTracks().forEach((track) => track.stop());
  rt.audioContext?.close();
  state.realtime = null;
  state.stoppingRealtime = false;
  el.mainAction.textContent = "Start realtime";
  stopOrbViz();
  setOrb("idle");
}

function setRealtimeStatus(text, mode) {
  el.realtimeStatus.textContent = text;
  el.realtimeStatus.classList.toggle("ready", mode === "ready");
  el.realtimeStatus.classList.toggle("warning", mode === "warning");
  el.realtimeStatus.classList.toggle("live", mode === "live");
}

async function startPushRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  claimMic();
  state.chunks = [];
  state.mediaRecorder = new MediaRecorder(stream);
  state.mediaRecorder.ondataavailable = (event) => event.data.size && state.chunks.push(event.data);
  state.mediaRecorder.onstop = () => finishPushRecording(stream);
  state.mediaRecorder.start();
  try {
    const vizCtx = new AudioContext();
    const analyser = makeOrbAnalyser(vizCtx);
    vizCtx.createMediaStreamSource(stream).connect(analyser);
    state.pushViz = vizCtx;
    startOrbViz(analyser);
  } catch { /* visualizer is optional */ }
  setOrb("listening");
  el.mainAction.textContent = "Stop recording";
  playSound("convoStart");
}

function stopPushRecording() {
  state.mediaRecorder?.stop();
}

async function finishPushRecording(stream) {
  stream.getTracks().forEach((track) => track.stop());
  stopOrbViz();
  state.pushViz?.close?.().catch(() => {});
  state.pushViz = null;
  setOrb("idle");
  el.mainAction.textContent = "Hold to talk";
  const blob = new Blob(state.chunks, { type: state.mediaRecorder.mimeType || "audio/webm" });
  state.mediaRecorder = null;
  const text = await transcribe(blob);
  if (!text) return;
  addMessage("user", text);
  playSound("messageSend");
  await chat(text, true);
}

async function transcribe(blob) {
  const form = new FormData();
  form.append("model", value("sttModel"));
  form.append("file", blob, "speech.webm");
  const res = await fetch(`${GEN_BASE}/v1/audio/transcriptions`, { method: "POST", headers: authHeaders(), body: form });
  if (!res.ok) return failResponse(res, "Transcription failed.");
  const json = await res.json();
  return json.text || "";
}

// Multi-image upload: each picked image is auto-saved to the gallery (so it is
// reusable as a generation source) and staged to send to the model on next send.
async function handleImageUpload(files) {
  const images = files.filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  for (const file of images) {
    let url;
    try { url = await blobToDataUrl(file); }
    catch { addMessage("system", `Could not read ${file.name || "an image"}.`); continue; }
    let galleryId = null;
    if (flag("autosaveUploads")) {
      // Best-effort: even if the gallery write fails, still attach the image.
      try {
        const item = await saveGalleryItem({ kind: "image", prompt: `Uploaded: ${file.name || "image"}`, model: "upload", blob: file });
        galleryId = item.id;
      } catch { /* gallery unavailable; attachment still works */ }
    }
    state.pendingImages.push({ url, galleryId, name: file.name || "image" });
  }
  renderAttachStrip();
  const where = state.realtime ? "the live agent when you send" : "your next message";
  addMessage("system", `Attached ${images.length} image${images.length > 1 ? "s" : ""}${flag("autosaveUploads") ? " (saved to gallery)" : ""}. They'll go to ${where}.`);
}

function renderAttachStrip() {
  const strips = [el.attachStrip, el.inlineAttachStrip].filter(Boolean);
  for (const strip of strips) {
    strip.innerHTML = "";
    strip.classList.toggle("active", state.pendingImages.length > 0);
    state.pendingImages.forEach((image, index) => {
      const chip = document.createElement("div");
      chip.className = "attach-chip";
      const thumb = document.createElement("img");
      thumb.src = image.url;
      thumb.alt = image.name || "Attached image";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attach-remove";
      remove.textContent = "✕";
      remove.title = "Remove attachment";
      remove.addEventListener("click", () => { state.pendingImages.splice(index, 1); renderAttachStrip(); });
      chip.append(thumb, remove);
      strip.append(chip);
    });
  }
}

function clearPendingImages() {
  state.pendingImages = [];
  renderAttachStrip();
}

// Send a user turn (text and/or images) into the live realtime voice session.
function sendRealtimeUserInput(text, imageUrls) {
  const rt = state.realtime;
  if (!rt || rt.socket?.readyState !== WebSocket.OPEN) return;
  const content = [];
  if (text) content.push({ type: "input_text", text });
  for (const url of imageUrls || []) content.push({ type: "input_image", image_url: url });
  if (!content.length) return;
  rt.socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content } }));
  rt.socket.send(JSON.stringify({ type: "response.create" }));
}

// Live camera sharing (realtime only): periodically push a frame into the session
// so the model can see what the user is doing without forcing a reply each frame.
async function toggleCamera() {
  if (state.camera) return stopCamera();
  if (!flag("camera")) { addMessage("system", "Turn on camera vision in Config first, then start your camera."); return; }
  if (!state.realtime) { addMessage("system", "Start a realtime session first, then share your camera with the agent."); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch {
    addMessage("system", "Camera unavailable or permission denied.");
    return;
  }
  const video = el.cameraPreview;
  video.srcObject = stream;
  video.classList.remove("hidden");
  await video.play().catch(() => {});
  state.camera = { stream, video, canvas: document.createElement("canvas"), timer: null };
  el.cameraToggle?.classList.add("active");
  if (el.cameraToggle) el.cameraToggle.textContent = "Stop camera";
  addMessage("system", "Camera on: the agent now sees your camera live. Talk to it about what it sees.");
  state.camera.timer = setInterval(sendCameraFrame, 2000);
  sendCameraFrame();
}

function sendCameraFrame() {
  const cam = state.camera;
  const rt = state.realtime;
  if (!cam || !rt || rt.socket?.readyState !== WebSocket.OPEN) return;
  const video = cam.video;
  if (!video.videoWidth) return;
  cam.canvas.width = video.videoWidth;
  cam.canvas.height = video.videoHeight;
  cam.canvas.getContext("2d").drawImage(video, 0, 0);
  let url;
  try { url = cam.canvas.toDataURL("image/jpeg", 0.55); } catch { return; }
  // No response.create: frames just enrich context for the model's next reply.
  rt.socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_image", image_url: url }] } }));
}

function stopCamera() {
  const cam = state.camera;
  if (!cam) return;
  clearInterval(cam.timer);
  cam.stream?.getTracks().forEach((track) => track.stop());
  if (cam.video) { cam.video.srcObject = null; cam.video.classList.add("hidden"); }
  state.camera = null;
  el.cameraToggle?.classList.remove("active");
  if (el.cameraToggle) el.cameraToggle.textContent = "Camera";
}

async function handleTextSubmit(event) {
  event.preventDefault();
  if (!requireKey()) return;
  // Either composer (the drawer one or the inline one that replaces the orb) can
  // submit; read from the form that fired and keep both inputs in sync.
  const input = event.currentTarget?.querySelector(".composer-text") || el.textInput;
  const text = (input?.value || "").trim();
  const images = state.pendingImages.slice();
  if (!text && !images.length) return;
  [el.textInput, el.inlineTextInput].forEach((field) => { if (field) field.value = ""; });
  clearPendingImages();
  const label = text || (images.length ? `Sent ${images.length} image${images.length > 1 ? "s" : ""}.` : "");
  addMessage("user", images.length && text ? `${text}  ·  ${images.length} image${images.length > 1 ? "s" : ""}` : label);
  playSound("messageSend");
  // Images go to whichever model is live: the realtime voice model sees them over
  // the socket; otherwise the text model gets them as vision content.
  if (state.realtime) sendRealtimeUserInput(text, images.map((image) => image.url));
  else await chat(text, false, images.map((image) => image.url));
}

async function chat(text, speak, images) {
  const history = state.messages
    .filter((m) => m.role === "user" || m.role === "agent")
    .slice(-12)
    .map((m) => ({ role: m.role === "agent" ? "assistant" : "user", content: m.content }));
  if (images && images.length) {
    // Replace the latest user turn with multimodal content so the model can see.
    const content = [{ type: "text", text: text || "Look at the attached image(s)." }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
    if (history.length && history[history.length - 1].role === "user") history[history.length - 1].content = content;
    else history.push({ role: "user", content });
  } else if (history[history.length - 1]?.content !== text) {
    // The current user turn was already pushed via addMessage(), so it is the last
    // history entry. Only append `text` as a fallback if it is somehow missing.
    history.push({ role: "user", content: text });
  }
  const payload = {
    model: value("textModel"),
    messages: [{ role: "system", content: systemPrompt() }, ...history],
    tools: toolDefinitions().map((tool) => ({ type: "function", function: tool })),
  };
  const result = await busy(() => postJson("/v1/chat/completions", payload));
  if (!result) return;
  const message = result.choices?.[0]?.message;
  if (message?.tool_calls?.length) {
    await handleToolCalls(payload.messages, message, speak);
    return;
  }
  const content = message?.content || "I did not receive a response.";
  addMessage("agent", content);
  playSound("messageReceive");
  if (speak && value("ttsVoice")) await speakText(content);
}

async function handleToolCalls(messages, assistantMessage, speak) {
  const tools = toolDefinitions().map((tool) => ({ type: "function", function: tool }));
  let message = assistantMessage;
  // Loop tool rounds so the text model can chain steps — e.g. list_gallery to find
  // an image, then create_image with that id to edit it. The followup MUST carry
  // the tool list, or the model can never take a second step (this is why editing
  // used to silently fail in chat mode). Cap the rounds so it can't run away.
  for (let round = 0; round < 6 && message?.tool_calls?.length; round += 1) {
    messages.push(message);
    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      const result = await runTool(call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
    const followup = await busy(() => postJson("/v1/chat/completions", { model: value("textModel"), messages, tools }));
    message = followup?.choices?.[0]?.message;
  }
  const content = message?.content || "Done.";
  addMessage("agent", content);
  playSound("messageReceive");
  if (speak && value("ttsVoice")) await speakText(content);
}

async function speakText(text) {
  const model = ttsModelName();
  const voice = value("ttsVoice") || "nova";
  let res;
  try {
    res = await fetch(`${GEN_BASE}/v1/audio/speech`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
    });
  } catch (error) {
    addMessage("system", `Text-to-speech network error: ${error.message || error}`);
    return;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 160);
    addMessage("system", `Text-to-speech failed with ${model} (${res.status}). ${detail} — try another TTS model in Config.`);
    playSound("error");
    return;
  }
  const blob = await res.blob();
  el.modelAudio.srcObject = null;
  el.modelAudio.src = URL.createObjectURL(blob);
  await el.modelAudio.play().catch(() => {});
}

// Suppress accidental duplicate tool invocations (a realtime/text model that
// fires the same expensive call twice in quick succession). Keyed by tool name +
// arguments within a short sliding window.
const recentToolCalls = new Map();
const DEDUPE_TOOLS = new Set(["create_image", "create_video", "create_audio", "build_widget", "ask_coder_model", "web_search"]);
const DEDUPE_WINDOW_MS = 6000;

function stableStringify(obj) {
  if (!obj || typeof obj !== "object") return JSON.stringify(obj ?? null);
  return JSON.stringify(Object.keys(obj).sort().reduce((acc, key) => { acc[key] = obj[key]; return acc; }, {}));
}

function isDuplicateToolCall(name, args) {
  if (!DEDUPE_TOOLS.has(name)) return false;
  const now = Date.now();
  for (const [key, at] of recentToolCalls) if (now - at > DEDUPE_WINDOW_MS) recentToolCalls.delete(key);
  const dedupeKey = `${name}:${stableStringify(args)}`;
  const prior = recentToolCalls.get(dedupeKey);
  recentToolCalls.set(dedupeKey, now);
  return prior != null && now - prior < DEDUPE_WINDOW_MS;
}

function sendRealtimeToolOutput(callId, result, triggerResponse = true) {
  if (!(callId && state.realtime?.socket?.readyState === WebSocket.OPEN)) return;
  state.realtime.socket.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
  }));
  if (triggerResponse) state.realtime.socket.send(JSON.stringify({ type: "response.create" }));
}

async function runTool(name, args, realtimeCallId) {
  if (isDuplicateToolCall(name, args)) {
    const result = { ok: true, deduped: true, note: "An identical request was just issued; the duplicate was skipped." };
    sendRealtimeToolOutput(realtimeCallId, result, false);
    return result;
  }
  const toolId = addToolEvent(name, args);
  vizBurst(name); // a little morph "pop" so you can see the agent act
  let result;
  try {
    if (name === "create_image") {
      const wanted = args.sourceImageIds || args.imageIds || args.editImageIds;
      const sources = await resolveGallerySourceUrls(wanted);
      if (Array.isArray(wanted) && wanted.length && !sources.length) {
        result = { error: "None of those sourceImageIds matched an image in the gallery. Call list_gallery for valid ids, or call request_source_images to have the user upload the image to edit." };
      } else {
        result = await generateMedia("image", args.prompt, value("imageModel"), toolId, sources.length ? { ...args, images: sources } : args);
      }
    }
    else if (name === "create_video") {
      const wanted = args.sourceImageIds || args.imageIds;
      const sources = await resolveGallerySourceUrls(wanted);
      if (Array.isArray(wanted) && wanted.length && !sources.length) {
        result = { error: "None of those sourceImageIds matched an image in the gallery. Call list_gallery for valid ids, or call request_source_images to collect the image to animate." };
      } else {
        result = await generateMedia("video", args.prompt, value("videoModel"), toolId, sources.length ? { ...args, images: sources } : args);
      }
    }
    else if (name === "create_audio") {
      const audioKind = detectLoaderKind("audio", args.prompt, "");
      const model = audioKind === "tts" ? ttsModelName() : value("audioModel");
      result = await generateMedia("audio", args.prompt, model, toolId, args);
    }
    else if (name === "web_search") result = await webSearch(args.query || args.q || args.prompt || "", toolId);
    else if (name === "network_issue" || name === "networkissue" || name === "diagnose_error" || name === "network_error") result = await diagnoseError();
    else if (name === "build_widget") result = await buildWidget(args, toolId);
    else if (name === "edit_widget") result = await editWidget(args, toolId);
    else if (name === "save_widget") result = await saveWidgetTool(args);
    else if (name === "end_conversation") result = endConversationTool();
    else if (name === "ask_coder_model") result = await askCoder(args.task || args.prompt || "", toolId);
    else if (name === "call_mcp_server") result = await callMcp(args.server, args.tool, args.arguments || {}, toolId);
    else if (name === "start_gibberlink") result = await activateGibberlink(args.message || "");
    else if (name === "show_workspace") result = showWorkspace(args, toolId);
    else if (name === "request_source_images") result = requestSourceImages(args, toolId);
    else if (name === "remove_workspace") result = removeWorkspace(args, toolId);
    else if (name === "reorder_workspace") result = reorderWorkspace(args);
    else if (name === "remember") result = rememberFact(args);
    else if (name === "forget") result = forgetMemory(args);
    else if (name === "list_gallery") result = await listGalleryForAgent();
    else if (name === "manage_gallery") result = await manageGallery(args, toolId);
    else if (name === "use_gallery_sources") result = await useGallerySources(args, toolId);
    else if (name === "write_file") result = await nativeWriteFile(args);
    else if (name === "read_file") result = await nativeReadFile(args);
    else if (name === "list_dir") result = await nativeListDir(args);
    else if (name === "run_command") result = await nativeRunCommand(args);
    else if (name === "open_path") result = await nativeOpenPath(args);
    else if (name === "save_media_to_disk") result = await nativeSaveMediaToDisk(args);
    // Models often spell the tool differently (jibberlink, gibber_link, start_jibber...).
    else if (/[gj]ibber.?link|[gj]ibber/i.test(name)) result = await activateGibberlink(args.message || args.text || "");
    else if (/network.?(issue|error|problem)|diagnos|api.?error/i.test(name)) result = await diagnoseError();
    else result = { error: `Unknown tool: ${name}` };
  } catch (error) {
    result = { error: (error && error.message) || String(error) || "Tool failed." };
  }
  updateToolEvent(toolId, result?.error ? "error" : "done", summarizeToolResult(name, result));
  sendRealtimeToolOutput(realtimeCallId, result);
  return result;
}

async function generateMedia(kind, prompt, model, toolId, options = {}) {
  const count = generationCount(kind, options);
  const loaderKind = detectLoaderKind(kind, prompt, model);
  const jobs = [];
  for (let index = 0; index < count; index += 1) {
    // Every item starts as a queued tile; the queue pump flips it to active when
    // a slot frees, so concurrent tiles tile/shrink and waiting ones stay grey.
    const label = count > 1 ? `${labelForKind(loaderKind)} ${index + 1}/${count}` : labelForKind(loaderKind);
    const jobId = genJobStart({ kind: loaderKind, title: label, status: "queued", detail: "Queued…" });
    const position = state.generationQueue.length + Math.max(0, state.generationActive - 1);
    if (state.generationActive >= 2) updateToolEvent(toolId, "queued", `Queued behind ${position} generation${position === 1 ? "" : "s"}.`);
    jobs.push(enqueueGeneration(() => runMediaGeneration(kind, prompt, model, toolId, { ...options, batchIndex: index, batchCount: count, jobId })));
  }
  const results = await Promise.all(jobs);
  if (count === 1) return results[0];
  return { ok: results.every((item) => !item?.error), count, results, galleryIds: results.map((item) => item.galleryId).filter(Boolean) };
}

function generationCount(kind, options) {
  const requested = Number(options.count || options.variations);
  const fallback = Number(value(kind === "image" ? "imageCount" : kind === "video" ? "videoCount" : "audioCount")) || 1;
  const max = kind === "image" ? 4 : kind === "video" ? 2 : 3;
  return Math.max(1, Math.min(max, requested || fallback));
}

function enqueueGeneration(task) {
  return new Promise((resolve) => {
    state.generationQueue.push({ task, resolve });
    pumpGenerationQueue();
  });
}

function pumpGenerationQueue() {
  while (state.generationActive < 2 && state.generationQueue.length) {
    const job = state.generationQueue.shift();
    state.generationActive += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve)
      .catch((error) => job.resolve({ error: (error && error.message) || String(error) || "Generation failed." }))
      .finally(() => {
        state.generationActive -= 1;
        pumpGenerationQueue();
      });
  }
}

async function runMediaGeneration(kind, prompt, model, toolId, options = {}) {
  // A tile may already exist (created queued by generateMedia); otherwise make one
  // so direct callers (source-image form) still get dock feedback.
  let jobId = options.jobId;
  if (kind === "audio" && detectLoaderKind(kind, prompt, model) === "tts") prompt = cleanTtsPrompt(prompt);
  if ((kind === "image" || kind === "video") && options.images?.length && !supportsImageInput(model)) {
    const replacement = sourceCapableModel(kind);
    if (replacement && replacement !== model) {
      updateToolEvent(toolId, "running", `${model} can't take source images; switching to ${replacement}.`);
      model = replacement;
    } else if (!replacement) {
      const message = `No available ${kind} model supports source/reference images, so the ${kind === "video" ? "image-to-video" : "image edit"} was skipped. Pick a ${kind} model that supports reference images.`;
      addMessage("system", message);
      playSound("error");
      if (jobId) genJobEnd(jobId, "No source-capable model.");
      return { error: message };
    }
  }
  const loaderKind = detectLoaderKind(kind, prompt, model);
  if (jobId) genJobActivate(jobId, { kind: loaderKind, detail: `Generating with ${model}…` });
  else jobId = genJobStart({ kind: loaderKind, title: labelForKind(loaderKind), status: "active", detail: `Generating with ${model}…` });
  updateToolEvent(toolId, "running", `Generating ${kind} with ${model}.`);
  const path = kind === "image" ? `/image/${encodeURIComponent(prompt)}` : kind === "video" ? `/video/${encodeURIComponent(prompt)}` : `/audio/${encodeURIComponent(prompt)}`;
  const params = mediaParams(kind, loaderKind, model, options);
  params.set("key", state.apiKey);
  const url = `${GEN_BASE}${path}?${params}`;

  // A stalled request (connection hiccup, model wedged) must not hang forever: it
  // would pin the gen-dock tile "active", keep the loop earcon playing, and jam the
  // concurrency cap. Each attempt aborts on a generous per-kind timeout; a ticker
  // shows elapsed seconds; the dock job is ALWAYS ended so the loop is released.
  // Transient failures retry up to MAX_TRIES; deterministic ones (copyright/policy,
  // auth, out-of-Pollen) stop immediately — retrying them just burns Pollen.
  const timeoutMs = kind === "video" ? 240000 : kind === "audio" ? 150000 : 90000;
  const MAX_TRIES = 3;
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    genJobDetail(jobId, `Generating with ${model}… ${secs}s`);
  }, 1000);
  try {
    let lastDetail = "";
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      // failure is left null on success; otherwise { error, status, blocked, deterministic }.
      let failure = null;
      try {
        const res = await fetch(url, { headers: authHeaders(), signal: controller.signal });
        if (res.ok) {
          const blob = await res.blob();
          // Pollinations sometimes returns 200 with a NON-media body — an error page,
          // a JSON message, or a near-empty placeholder ("generated weird"). Saving
          // that yields a broken gallery item, so treat it as a (retryable) failure.
          const badReason = badMediaBlob(kind, blob);
          if (!badReason) {
            refreshBalance();
            const item = await saveGalleryItem({ kind, prompt, model, blob, remoteUrl: res.url });
            genJobEnd(jobId, `${capitalize(kind)} saved to gallery.`);
            return { ok: true, galleryId: item.id, kind, prompt, model };
          }
          const snippet = await blobTextSnippet(blob);
          const friendly = classifyApiError(200, snippet) || badReason;
          recordApiError(`${kind} generation`, friendly, 200, snippet);
          failure = { error: friendly, status: 200, blocked: /copyright|content policy/i.test(friendly), deterministic: false };
        } else {
          const f = await readApiFailure(res, `${capitalize(kind)} generation failed.`);
          recordApiError(`${kind} generation`, f.error, res.status, f.raw);
          failure = { error: f.error, status: f.status, blocked: f.blocked, deterministic: f.blocked || [400, 401, 402, 403].includes(res.status) };
        }
      } catch (error) {
        const aborted = error && error.name === "AbortError";
        const why = aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : ((error && error.message) || "network failure");
        recordApiError(`${kind} generation`, why, aborted ? "timeout" : "network", "");
        failure = { error: why, status: aborted ? "timeout" : "network", blocked: false, deterministic: false };
      } finally {
        clearTimeout(timeout);
      }
      // Reached only on failure (success returned above).
      lastDetail = failure.error;
      if (failure.deterministic || attempt === MAX_TRIES) {
        const message = failure.deterministic
          ? failure.error
          : `${capitalize(kind)} generation failed after ${attempt} tries — ${failure.error}. Stopped so it doesn't keep wasting Pollen; ask me to diagnose it.`;
        addMessage("system", message);
        playSound("error");
        genJobEnd(jobId, failure.blocked ? "Blocked." : `Failed (tried ${attempt}×).`);
        return { error: message, status: failure.status, blocked: failure.blocked };
      }
      // Backoff before the next attempt; surface the retry on the tool event.
      updateToolEvent(toolId, "running", `Hiccup (${failure.error}). Retry ${attempt + 1}/${MAX_TRIES}…`);
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
    }
    // Unreachable (loop always returns on the last attempt), but keep the job tidy.
    genJobEnd(jobId, "Failed.");
    return { error: lastDetail || `${capitalize(kind)} generation failed.` };
  } finally {
    clearInterval(ticker);
  }
}

function mediaParams(kind, loaderKind, model, options = {}) {
  const params = new URLSearchParams({ model });
  if (kind === "image") {
    const [width, height] = value("imageSize").split("x");
    params.set("width", width || "1024");
    params.set("height", height || "1024");
    params.set("quality", "medium");
    if (options.images?.length) params.set("image", options.images.join("|"));
  }
  if (kind === "video") {
    const aspect = options.aspectRatio || value("videoAspect") || "16:9";
    const [width, height] = aspect === "9:16" ? ["720", "1280"] : ["1280", "720"];
    params.set("width", width);
    params.set("height", height);
    params.set("aspectRatio", aspect);
    params.set("duration", String(options.duration || value("videoDuration") || "6"));
    params.set("audio", String(options.withAudio ?? value("videoAudio") ?? "false"));
    if (options.images?.length) params.set("image", options.images.join("|"));
  }
  if (kind === "audio") {
    params.set("response_format", "mp3");
    if (loaderKind === "tts") params.set("voice", value("ttsVoice") || "nova");
    else params.set("duration", String(options.duration || value("musicDuration") || "30"));
  }
  return params;
}

function sourceCapableModel(kind) {
  // Keep the user's selected model if it already supports source images.
  const current = value(kind === "video" ? "videoModel" : "imageModel");
  if (current && supportsImageInput(current)) return current;
  const list = kind === "video" ? videoModelsOnly() : imageModelsOnly();
  return modelName(list.find((model) => supportsImageInput(modelName(model)))) || "";
}

function cleanTtsPrompt(prompt) {
  return String(prompt || "")
    .replace(/^\s*(a\s+)?(clear|friendly|warm|professional|calm)?\s*voice\s+says\s*[:\-]\s*/i, "")
    .replace(/^\s*(say|speak|read|narrate)\s*[:\-]?\s*/i, "")
    .replace(/^\s*["']|["']\s*$/g, "")
    .trim();
}

async function askCoder(task, toolId) {
  const model = value("coderModel");
  task = String(task || "").trim();
  if (!task) {
    updateToolEvent(toolId, "error", "No coding task was provided.");
    return { error: "No coding task was provided." };
  }
  updateToolEvent(toolId, "running", `Asking ${model} to work on the coding task.`);
  const jobId = genJobStart({ kind: "terminal", title: "Coder", status: "active" });
  genJobTerminal(jobId, [`$ coder-model --model ${model}`, "Booting coding worker...", `Task: ${task.slice(0, 180)}`], false);
  const result = await postJson("/v1/chat/completions", {
    model,
    messages: [
      { role: "system", content: CODER_SYSTEM_PROMPT },
      { role: "user", content: task },
    ],
  });
  if (result?.error) {
    genJobTerminal(jobId, ["Coder request failed.", result.error], true);
    genJobEnd(jobId, "Coder request failed.");
    return { error: result.error };
  }
  const answer = result?.choices?.[0]?.message?.content || "";
  if (!answer) {
    genJobTerminal(jobId, ["No response returned from coder model."], true);
    genJobEnd(jobId, "Coder returned no content.");
    return { error: "Coder model returned no content." };
  }
  const html = extractHtmlProject(answer);
  if (html) {
    const item = await saveGalleryItem({ kind: "project", prompt: task, model, blob: new Blob([html], { type: "text/html" }) });
    genJobTerminal(jobId, ["HTML project detected.", "Saved a runnable project to your gallery.", "Open the Gallery to run or download it."], true);
    genJobEnd(jobId, "Project saved to gallery.");
    return { answer: summarizeCoderAnswer(answer), projectGalleryId: item.id };
  }
  // Non-HTML deliverable: save the largest tagged code block as a real file with
  // the language's extension, so the user can download it as expected.
  const file = extractCodeFile(answer);
  if (file) {
    const filename = file.filename || `${slugify(task) || "snippet"}.${file.ext}`;
    const item = await saveGalleryItem({ kind: "code", prompt: task, model, blob: new Blob([file.code], { type: "text/plain" }), language: file.language, filename });
    genJobTerminal(jobId, [`Detected a ${file.language} file.`, `Saved ${filename} to your gallery.`, "Open the Gallery to view or download it."], true);
    genJobEnd(jobId, `${filename} saved to gallery.`);
    return { answer: summarizeCoderAnswer(answer), codeGalleryId: item.id, language: file.language, filename };
  }
  genJobTerminal(jobId, ["Coder response received.", "Returned guidance / inline snippets."], true);
  genJobEnd(jobId, "Coder returned guidance.");
  return { answer };
}

// File-extension per fenced-code language tag (for saving coder output as files).
const LANGUAGE_EXT = {
  python: "py", py: "py", javascript: "js", js: "js", jsx: "jsx", typescript: "ts", ts: "ts", tsx: "tsx",
  css: "css", scss: "scss", less: "less", html: "html", json: "json", yaml: "yml", yml: "yml", toml: "toml",
  markdown: "md", md: "md", sql: "sql", sh: "sh", bash: "sh", shell: "sh", zsh: "sh", c: "c", h: "h",
  cpp: "cpp", "c++": "cpp", cs: "cs", csharp: "cs", java: "java", kotlin: "kt", kt: "kt", swift: "swift",
  go: "go", golang: "go", rust: "rs", rs: "rs", ruby: "rb", rb: "rb", php: "php", r: "r", lua: "lua",
  dart: "dart", scala: "scala", perl: "pl", dockerfile: "dockerfile", makefile: "mk", ini: "ini",
  xml: "xml", svg: "svg", vue: "vue", graphql: "graphql", proto: "proto", txt: "txt", text: "txt",
};

// Pulls the largest fenced code block out of a coder reply and resolves a sensible
// language + extension + optional filename (from a `title=` / `file=` info string).
function extractCodeFile(text) {
  if (!text) return null;
  const blocks = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(text))) {
    const info = match[1].trim();
    const code = match[2].replace(/\s+$/, "");
    blocks.push({ info, code });
  }
  if (!blocks.length) return null;
  const best = blocks.sort((a, b) => b.code.length - a.code.length)[0];
  if (best.code.trim().length < 12) return null;
  const lang = (best.info.split(/\s+/)[0] || "").toLowerCase();
  const filenameMatch = best.info.match(/(?:title|file|name)\s*=\s*["']?([^\s"']+)/i);
  let filename = filenameMatch ? filenameMatch[1] : "";
  let ext = LANGUAGE_EXT[lang] || (lang && /^[a-z0-9+#]+$/.test(lang) ? lang : "txt");
  let language = lang || "text";
  if (filename) {
    const fileExt = filename.split(".").pop();
    if (fileExt && fileExt !== filename) ext = fileExt.toLowerCase();
  }
  return { code: best.code, language, ext, filename };
}

async function webSearch(query, toolId) {
  query = String(query || "").trim();
  if (!query) return { error: "No search query was provided." };
  const model = searchModel();
  updateToolEvent(toolId, "running", `Searching the web with ${model} for "${query.slice(0, 80)}".`);
  const jobId = genJobStart({ kind: "search", title: "Web search", status: "active", detail: `Searching “${query.slice(0, 42)}”…` });
  const result = await postJson("/v1/chat/completions", {
    model,
    messages: [
      { role: "system", content: "You are a web search assistant with live internet access. Answer the user's query using current information. Be factual and concise. Cite sources inline as [1], [2] and end with a 'Sources:' list of the URLs you used." },
      { role: "user", content: query },
    ],
  });
  if (result?.error) {
    genJobEnd(jobId, "Search failed.");
    return { error: result.error };
  }
  const answer = result?.choices?.[0]?.message?.content?.trim();
  if (!answer) {
    genJobEnd(jobId, "No results.");
    return { error: "Search returned no result." };
  }
  genJobEnd(jobId, "Search complete.");
  return { query, model, answer };
}

async function buildWidget(args, toolId) {
  const spec = String(args.spec || args.prompt || args.description || "").trim();
  if (!spec) return { error: "No widget spec was provided." };
  const title = args.title || "Custom widget";
  const model = value("coderModel");
  updateToolEvent(toolId, "running", `Building widget "${title}" with ${model}.`);
  const jobId = genJobStart({ kind: "widget", title: "Widget", status: "active" });
  genJobTerminal(jobId, [`$ widget-builder --model ${model}`, "Designing interactive widget...", `Spec: ${spec.slice(0, 160)}`], false);
  const assets = await galleryAssetsFor(args);
  const userParts = [spec];
  if (args.data !== undefined) userParts.push(`\n\nUse this JSON data:\n${JSON.stringify(args.data).slice(0, 6000)}`);
  if (assets.length) userParts.push(`\n\nWidgetStore.assets has ${assets.length} attached gallery item(s) — BUILD THE WIDGET TO ACTUALLY DISPLAY/USE THEM: ${assets.map((a, i) => `[${i}] ${a.kind} "${a.name}"`).join(", ")}. Read them at runtime via WidgetStore.assets (e.g. WidgetStore.assets.forEach(a => ... a.url)) and set them as the src of <img>/<video>/<audio>. Do not hardcode the list; iterate WidgetStore.assets so it stays correct.`);
  const result = await postJson("/v1/chat/completions", {
    model,
    messages: [
      { role: "system", content: WIDGET_SYSTEM_PROMPT },
      { role: "user", content: userParts.join("") },
    ],
  });
  if (result?.error) {
    genJobTerminal(jobId, ["Widget build failed.", result.error], true);
    genJobEnd(jobId, "Widget build failed.");
    return { error: result.error };
  }
  const html = extractHtmlProject(result?.choices?.[0]?.message?.content || "");
  if (!html) {
    genJobTerminal(jobId, ["Coder did not return a widget document."], true);
    genJobEnd(jobId, "No widget produced.");
    return { error: "Coder did not return a self-contained widget document." };
  }
  const artifact = showWorkspace({ layout: "widget", title, summary: spec.slice(0, 200), content: html, spec, data: args.data ?? null, assets });
  genJobTerminal(jobId, ["Widget ready.", "Rendered live to the adaptive workspace."], true);
  genJobEnd(jobId, "Widget added to canvas.");
  return { ok: true, workspaceId: artifact.workspaceId };
}

// Edit/fix an existing live widget by handing its current document + a change
// request to the coder model, then swapping the HTML in place (data preserved).
async function editWidget(args, toolId) {
  const id = args.workspaceId || args.id || "";
  const artifact = state.workspace.find((item) => item.id === id && item.layout === "widget")
    || state.workspace.find((item) => item.layout === "widget"); // fall back to the most recent widget
  if (!artifact) return { error: "No widget on the canvas to edit. Build one first with build_widget." };
  const changes = String(args.changes || args.change || args.spec || "").trim();
  if (!changes) return { error: "Describe what to change about the widget." };
  const model = value("coderModel");
  updateToolEvent(toolId, "running", `Editing widget "${artifact.title}" with ${model}.`);
  const jobId = genJobStart({ kind: "widget", title: "Edit widget", status: "active" });
  genJobTerminal(jobId, [`$ widget-editor --model ${model}`, `Editing: ${artifact.title}`, `Change: ${changes.slice(0, 160)}`], false);
  const newAssets = await galleryAssetsFor({ galleryIds: args.addGalleryIds || [], galleryFilter: args.addGalleryFilter, galleryLimit: args.galleryLimit });
  // Drop any that the widget already has, so re-attaching the same kind doesn't dupe.
  const existingIds = new Set((artifact.assets || []).map((a) => a.id));
  const assets = [...(artifact.assets || []), ...newAssets.filter((a) => !existingIds.has(a.id))];
  const userParts = [
    `Current widget document:\n\`\`\`html\n${String(artifact.content || "").slice(0, 40000)}\n\`\`\``,
    `\n\nApply these changes: ${changes}`,
  ];
  if (newAssets.length) userParts.push(`\n\n${newAssets.length} new gallery asset(s) are now in WidgetStore.assets; reference them by url.`);
  const result = await postJson("/v1/chat/completions", {
    model,
    messages: [
      { role: "system", content: WIDGET_EDIT_SYSTEM_PROMPT },
      { role: "user", content: userParts.join("") },
    ],
  });
  if (result?.error) {
    genJobTerminal(jobId, ["Widget edit failed.", result.error], true);
    genJobEnd(jobId, "Widget edit failed.");
    return { error: result.error };
  }
  const html = extractHtmlProject(result?.choices?.[0]?.message?.content || "");
  if (!html) {
    genJobTerminal(jobId, ["Coder did not return an updated document."], true);
    genJobEnd(jobId, "No update produced.");
    return { error: "Coder did not return an updated widget document." };
  }
  artifact.content = html;
  artifact.assets = assets;
  artifact.summary = changes.slice(0, 200);
  saveWorkspace();
  renderWorkspace();
  if (artifact.savedWidgetId) await updateSavedWidget(artifact.savedWidgetId, { html, assets });
  genJobTerminal(jobId, ["Widget updated.", "Re-rendered on the canvas."], true);
  genJobEnd(jobId, "Widget updated.");
  return { ok: true, workspaceId: artifact.id };
}

// Ends the live session, but only via the gated tool — the system prompt tells
// the model to call it solely when the user explicitly asks to stop. Defer the
// actual teardown a tick so the tool's function_call_output can flush first.
function endConversationTool() {
  if (!flag("endConversation")) return { error: "The end-conversation tool is disabled in Config." };
  const wasActive = Boolean(state.realtime || state.gibber || state.mediaRecorder?.state === "recording");
  addMessage("system", "Ending the conversation at your request.");
  setTimeout(() => stopAll(), 400);
  return { ok: true, ended: wasActive };
}

async function saveWidgetTool(args) {
  const id = args.workspaceId || args.id || "";
  const artifact = state.workspace.find((item) => item.id === id && item.layout === "widget")
    || state.workspace.find((item) => item.layout === "widget");
  if (!artifact) return { error: "No widget on the canvas to save. Build one first with build_widget." };
  const record = await saveWidgetFromArtifact(artifact);
  return { ok: true, savedWidgetId: record.id, title: record.title };
}

// Resolve gallery item ids to self-contained assets (data URLs) for widgets.
async function galleryAssetsFromIds(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return [];
  const items = await getGalleryItems().catch(() => []);
  const assets = [];
  for (const id of list) {
    const item = items.find((entry) => entry.id === id);
    if (!item || item.kind === "project") continue;
    try {
      assets.push(await galleryItemToAsset(item));
    } catch { /* skip unreadable asset */ }
  }
  return assets;
}

async function galleryItemToAsset(item) {
  const url = await blobToDataUrl(item.blob);
  return { id: item.id, kind: item.kind, name: shortPrompt(item.prompt), prompt: item.prompt, url };
}

// Resolve the gallery media a widget should embed, from explicit ids AND/OR a kind
// filter ("image"/"video"/"audio"/"all"). The filter path lets the model attach media
// from a plain request ("use my photos") without juggling exact ids, which it's bad
// at. Returns self-contained data-URL assets, newest first, de-duplicated.
async function galleryAssetsFor(args) {
  const assets = await galleryAssetsFromIds(args.galleryIds || args.sources || []);
  const filter = String(args.galleryFilter || args.galleryKind || "").toLowerCase().trim();
  if (filter && filter !== "none") {
    const want = filter === "all" || filter === "media" ? ["image", "video", "audio"] : [filter.replace(/s$/, "").replace("photo", "image").replace("music", "audio")];
    const limit = Math.max(1, Math.min(40, Number(args.galleryLimit) || 12));
    const items = await getGalleryItems().catch(() => []);
    const have = new Set(assets.map((a) => a.id));
    const picked = items.filter((it) => want.includes(it.kind) && !have.has(it.id)).slice(0, limit);
    for (const item of picked) {
      try { assets.push(await galleryItemToAsset(item)); } catch { /* skip unreadable */ }
    }
  }
  return assets;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function callMcp(serverName, tool, args, toolId) {
  const server = state.mcps.find((mcp) => mcp.name === serverName || mcp.url === serverName);
  if (!server) return { error: "MCP server not configured in this browser." };
  updateToolEvent(toolId, "running", `Calling ${tool} on ${server.name}.`);
  const res = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: tool, arguments: args } }),
  });
  if (!res.ok) return failResponse(res, "MCP call failed.");
  return res.json();
}

function toolDefinitions() {
  const tools = [
    {
      name: "create_image",
      description: "Generate images, OR EDIT/restyle/vary existing ones, and save to the local gallery. To edit an existing or user-uploaded image, pass its gallery id in sourceImageIds and describe the change in prompt — this is the one-step image-edit path. Use count for multiple variations.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed image prompt. When editing, describe the change to apply to the source image(s)." },
          count: { type: "integer", minimum: 1, maximum: 4, description: "Number of variations/images" },
          sourceImageIds: { type: "array", items: { type: "string" }, description: "Gallery item ids of image(s) to EDIT or use as visual reference. Provide these to edit/restyle an existing or user-uploaded image (uploads are auto-saved to the gallery — call list_gallery for ids). Omit for a brand-new image. A source-capable image model is selected automatically." },
        },
        required: ["prompt"],
      },
    },
    {
      name: "create_video",
      description: "Generate videos and save them to the local gallery. To animate an existing or user-uploaded image (image-to-video), pass its gallery id in sourceImageIds. Use duration and aspectRatio when the user specifies length or format.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed video prompt" },
          count: { type: "integer", minimum: 1, maximum: 2, description: "Number of videos" },
          duration: { type: "integer", minimum: 1, maximum: 120, description: "Duration in seconds, model-dependent" },
          aspectRatio: { type: "string", enum: ["16:9", "9:16"], description: "Video aspect ratio" },
          withAudio: { type: "boolean", description: "Whether to request video audio when the model supports it" },
          sourceImageIds: { type: "array", items: { type: "string" }, description: "Gallery item ids of image(s) to animate into video (image-to-video). Call list_gallery for ids; uploaded images are auto-saved there. A source-capable video model is selected automatically." },
        },
        required: ["prompt"],
      },
    },
    {
      name: "create_audio",
      description: "Generate music/sound or clean TTS. For TTS, prompt must be only the words to speak, not 'a clear voice says...'. Use duration for music/sound length.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "For TTS: exact text to speak. For music/sound: music or sound prompt." },
          count: { type: "integer", minimum: 1, maximum: 3, description: "Number of audio variations" },
          duration: { type: "integer", minimum: 1, maximum: 300, description: "Music/sound duration in seconds" },
        },
        required: ["prompt"],
      },
    },
    { name: "web_search", description: "Search the live web for current, factual, or time-sensitive information (news, prices, docs, events, anything past your training cutoff) and get a concise answer with cited sources. Returns { answer } with inline [n] citations and a Sources list.", parameters: objectParams({ query: "The search query" }, ["query"]) },
    { name: "network_issue", description: "Diagnose the most recent API or generation error. Returns what failed, the exact status/message the server returned, plus a LIVE connectivity check (is the API reachable, are we online, is a key connected). Call this whenever a tool returns an error, a generation fails, or the user says something 'failed', 'isn't working', or 'hung' — then read the result and help the user fix it (rephrase for copyright/policy blocks, reconnect for auth, top up for balance, retry for a transient network/timeout).", parameters: { type: "object", properties: {} } },
    {
      name: "build_widget",
      description: "Build a CUSTOM interactive widget/mini-app on the adaptive canvas by delegating to the coder model. This is the DEFAULT for anything visual or interactive that isn't plain info: charts, graphs, checklists/to-dos, calculators, spreadsheets, editors, timers, diagrams, games, trackers, bespoke visualizations, and media galleries/slideshows/players. The widget is sandboxed HTML rendered live, can persist its own data (a WidgetStore the user keeps across reloads/saves/downloads), and can embed saved gallery media. To USE saved images/video/audio in a widget (slideshow, gallery, moodboard, player), set galleryFilter to the kind ('image'/'video'/'audio'/'all') — the most recent matching items are attached automatically as WidgetStore.assets; OR pass specific galleryIds if you already know them. Reserve show_workspace for plain note/table/metrics/code; use build_widget whenever interactivity, charts, custom design, or showing saved media helps.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short widget title" },
          spec: { type: "string", description: "Detailed description of the widget/mini-app and how it should look, behave, and persist data. If it shows media, say so (e.g. 'a slideshow of the attached gallery images')." },
          data: { type: "array", description: "Optional structured data the widget should seed from", items: { type: "object", additionalProperties: true } },
          galleryIds: { type: "array", items: { type: "string" }, description: "Specific gallery item ids to embed as assets. Optional — prefer galleryFilter when the user just wants 'my images/videos/music'. Call list_gallery to get ids if you need specific ones." },
          galleryFilter: { type: "string", enum: ["image", "video", "audio", "all"], description: "Attach the most recent saved gallery items of this kind as WidgetStore.assets, no ids required. Use this whenever the user wants a widget that shows/uses their saved media." },
          galleryLimit: { type: "integer", minimum: 1, maximum: 40, description: "How many items to attach when using galleryFilter (default 12)." },
        },
        required: ["spec"],
      },
    },
    {
      name: "edit_widget",
      description: "Edit or fix an existing live widget on the canvas: hand the coder its current document plus a change request and swap in the updated version (stored data is preserved). Use this to fix bugs, restyle, add features, or remove parts of a widget the user dislikes. Defaults to the most recent widget when workspaceId is omitted.",
      parameters: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "Workspace id of the widget to edit (optional; defaults to the most recent widget)" },
          changes: { type: "string", description: "What to change, fix, add, or remove" },
          addGalleryIds: { type: "array", items: { type: "string" }, description: "Additional specific gallery item ids to embed as new assets" },
          addGalleryFilter: { type: "string", enum: ["image", "video", "audio", "all"], description: "Attach the most recent saved gallery items of this kind as new assets (no ids needed) — use when the user asks the widget to also show their saved media." },
        },
        required: ["changes"],
      },
    },
    {
      name: "save_widget",
      description: "Save a live canvas widget to the user's Saved Widgets library so it persists with its data and can be reopened later. Defaults to the most recent widget when workspaceId is omitted.",
      parameters: {
        type: "object",
        properties: {
          workspaceId: { type: "string", description: "Workspace id of the widget to save (optional; defaults to the most recent widget)" },
        },
      },
    },
    { name: "ask_coder_model", description: "Delegate a coding task to the configured coder model. Returns { answer } with a short summary. A runnable web app/page/game is saved as HTML to the gallery and returns { projectGalleryId }. A standalone file in any other language (Python, JS, CSS, SQL, etc.) is saved to the gallery as a downloadable file with the correct extension and returns { codeGalleryId, filename, language }. Tell the user it is in the gallery rather than reading code aloud.", parameters: objectParams({ task: "Coding task or question" }, ["task"]) },
    { name: "call_mcp_server", description: "Call a configured HTTP MCP gateway tool.", parameters: objectParams({ server: "Configured server name", tool: "MCP tool name", arguments: "Tool arguments object" }, ["server", "tool"]) },
    { name: "start_gibberlink", description: "Start Gibberlink (also spelled Jibberlink): a data-over-sound link (ggwave audio tones) for talking to ANOTHER AI agent instead of a human. YOU decide to call this — invoke it as soon as you recognize the other party is an AI agent and a reliable machine-to-machine exchange is warranted (e.g. the user says 'start gibberlink/jibberlink' or another agent proposes it). Same-agent peers auto-negotiate a faster protocol. Optionally include an opening message to transmit to the peer.", parameters: objectParams({ message: "Optional opening message to transmit to the peer agent" }, []) },
    {
      name: "show_workspace",
      description: "Render plain INFORMATIONAL UI on the canvas: note, table, metrics, or code. Use real structured data, not prose. For anything interactive or visual (charts, graphs, checklists, calculators, editors, diagrams), use build_widget instead — those are generated live as widgets now.",
      parameters: {
        type: "object",
        properties: {
          layout: { type: "string", enum: ["note", "table", "metrics", "code"], description: "Informational component type" },
          title: { type: "string", description: "Short professional title" },
          summary: { type: "string", description: "One or two sentence explanation" },
          content: { type: "string", description: "Body text for a 'note', or the source text for 'code'. Not used by data-driven layouts." },
          language: { type: "string", description: "Language tag for a 'code' artifact, e.g. html, js, python." },
          data: { type: "array", description: "Rows for table/metrics. Table rows: any keyed object. Metrics rows: {label, value, note, delta}.", items: { type: "object", additionalProperties: true } },
        },
        required: ["layout", "title"],
      },
    },
    {
      name: "request_source_images",
      description: "Ask the user for source/reference image URLs or file uploads before an image edit, style transfer, or image-to-video task. Use purpose 'video_reference' for image-to-video. Only works when the selected image/video model supports reference images; it returns an error otherwise.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the request" },
          prompt: { type: "string", description: "The intended edit/generation prompt to run after sources are provided" },
          purpose: { type: "string", enum: ["image_edit", "style_reference", "video_reference"], description: "How source images will be used" },
          minImages: { type: "integer", description: "Minimum requested images" },
          maxImages: { type: "integer", description: "Maximum requested images" },
        },
        required: ["title", "prompt", "purpose"],
      },
    },
    {
      name: "remove_workspace",
      description: "Remove a workspace artifact by id, or clear the whole adaptive workspace.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Workspace artifact id to remove" },
          clearAll: { type: "boolean", description: "Clear the entire workspace" },
        },
      },
    },
    {
      name: "reorder_workspace",
      description: "Reorder items on the adaptive canvas (e.g. move a widget to the top, up, down, bottom, to a specific index, or set the whole order). Items are listed top-to-bottom by index 0 first. Use the workspaceId returned by show_workspace/build_widget.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Workspace item id to move" },
          position: { type: "string", enum: ["top", "up", "down", "bottom"], description: "Where to move the item" },
          toIndex: { type: "integer", description: "Exact target index (0 = top)" },
          order: { type: "array", items: { type: "string" }, description: "Full desired order as an array of ids (top first)" },
        },
      },
    },
    {
      name: "list_gallery",
      description: "List locally saved gallery items so you can reference or reuse them.",
      parameters: { type: "object", properties: {} },
    },
    { name: "remember", description: "Store a durable fact about the user in long-term memory that persists across sessions (name, preferences, defaults, ongoing projects). Use only for things that stay useful over time, not one-off details.", parameters: objectParams({ text: "The fact to remember, written as a concise statement" }, ["text"]) },
    { name: "forget", description: "Remove something from long-term memory by id or matching text, or clear it all with { all: true }.", parameters: { type: "object", properties: { id: { type: "string", description: "Memory id to forget" }, text: { type: "string", description: "Forget memories containing this text" }, all: { type: "boolean", description: "Clear all memory" } } } },
    {
      name: "manage_gallery",
      description: "Manage the user's local gallery: delete specific items, clear everything, or retag an item's caption. Call list_gallery first to get ids. Deleting and clearing are permanent — only do so when the user asks or clearly wants cleanup.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["delete", "clear", "retag"], description: "What to do" },
          ids: { type: "array", items: { type: "string" }, description: "Gallery item ids to delete" },
          id: { type: "string", description: "Single gallery item id for retag" },
          prompt: { type: "string", description: "New caption/prompt when retagging" },
        },
        required: ["action"],
      },
    },
    {
      name: "use_gallery_sources",
      description: "Use selected gallery images as source/reference images for image editing or image-to-video generation.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Gallery item ids to use as source images" },
          prompt: { type: "string", description: "Edit or video prompt" },
          purpose: { type: "string", enum: ["image_edit", "video_reference"], description: "How to use the gallery sources" },
        },
        required: ["ids", "prompt", "purpose"],
      },
    },
  ];
  if (flag("endConversation")) {
    tools.push({
      name: "end_conversation",
      description: "End/stop the current live session (realtime, push-to-talk, or gibberlink). ONLY call this when the user explicitly asks to end, stop, hang up, wrap up, or finish the conversation. Never end on your own initiative or to avoid a task.",
      parameters: { type: "object", properties: {} },
    });
  }
  // Desktop-only capabilities: real filesystem + shell, so the agent can build and
  // run actual projects on disk. Absent on the web build, so the web app is unchanged.
  if (nativeAvailable()) {
    tools.push(
      { name: "write_file", description: "DESKTOP. Write a UTF-8 text file into the local project workspace folder (parent dirs are created). Use workspace-relative paths like src/app.py. Build REAL runnable projects on disk with this during coding tasks.", parameters: objectParams({ path: "Workspace-relative file path, e.g. src/index.js", content: "Full file contents" }, ["path", "content"]) },
      { name: "read_file", description: "DESKTOP. Read a UTF-8 text file from the workspace folder.", parameters: objectParams({ path: "Workspace-relative file path" }, ["path"]) },
      { name: "list_dir", description: "DESKTOP. List files and folders under a workspace-relative path (omit path for the workspace root).", parameters: objectParams({ path: "Workspace-relative folder path (optional)" }, []) },
      { name: "run_command", description: "DESKTOP. Run a shell command in the workspace folder (install, build, run, test, git). The user approves each command. Returns { code, stdout, stderr }. Use this to actually run the projects you write.", parameters: objectParams({ command: "Command line to run, e.g. 'npm install' or 'python main.py'" }, ["command"]) },
      { name: "open_path", description: "DESKTOP. Open/reveal a workspace file or folder (omit path for the workspace root) in the OS file manager or its default app.", parameters: objectParams({ path: "Workspace-relative path (optional)" }, []) },
      { name: "save_media_to_disk", description: "DESKTOP. Export a gallery item (by id) to a real file in the workspace's media folder so code you write can reference it by path. Generated media already auto-saves to disk; use this to place a specific item. Returns the saved path.", parameters: objectParams({ id: "Gallery item id", path: "Optional workspace-relative destination" }, ["id"]) },
    );
  }
  return tools;
}

function realtimeToolDefinitions() {
  return toolDefinitions().map((tool) => ({ type: "function", ...tool }));
}

function realtimeSessionConfig(includeVoice) {
  const session = {
    type: "realtime",
    instructions: systemPrompt(),
    tools: realtimeToolDefinitions(),
  };
  const voice = value("realtimeVoice");
  // gpt-realtime-2 can emit its own voice; request the selected one when supported.
  // If the proxy rejects it, handleRealtimeEvent retries with includeVoice=false.
  if (includeVoice && voice) session.audio = { output: { voice } };
  return session;
}

function objectParams(properties, required) {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(properties).map(([key, description]) => [key, { type: key === "arguments" ? "object" : "string", description }])),
    required,
  };
}

function systemPrompt() {
  return `You are a polished voice-first AI agent. Realtime mode must use ${REALTIME_MODEL}. Personality: ${personalityInstruction()}. Be conversational and brief by default. For plain informational structure, call show_workspace with layout note, table, metrics, or code (real structured data, not prose). For ANYTHING interactive or visual — charts, graphs, checklists/to-dos, calculators, spreadsheets, editors, timers, diagrams, games, trackers, custom visualizations — call build_widget, which generates a live sandboxed widget on the canvas. Widgets can persist their own data (a WidgetStore the user keeps) and embed the user's saved gallery media. To make a widget that shows or uses saved media (a slideshow, image gallery, moodboard, audio/video player), call build_widget with galleryFilter set to the kind ("image"/"video"/"audio"/"all") — the recent matching items are attached automatically, so you do NOT need exact ids; only pass galleryIds when you already have specific ones. To fix, restyle, or extend a widget the user already has, call edit_widget with the change; call save_widget to keep one in their library. To show source code or markup, use layout "code". This app works identically whether the user TALKS OR TYPES — many users have no microphone, so you must be fully capable over text chat, including image editing. IMAGE EDITING / IMAGE-TO-VIDEO: to edit, restyle, fix, or vary an existing or user-uploaded image, call create_image with sourceImageIds set to that image's gallery id and put the change in prompt — this is a one-step edit. To animate an image into a video, call create_video with sourceImageIds. The user can upload images directly in chat; uploads are auto-saved to the gallery, so if you are unsure of an id, call list_gallery first to find it (newest entries are the recently uploaded ones). Only when no usable image exists yet (none uploaded and none in the gallery) call request_source_images to collect one. use_gallery_sources is an alternative when working from several gallery selections. Call create_image with no sourceImageIds for a brand-new image. You can remove stale workspace items with remove_workspace. You can call web_search for current or factual information beyond your training, a coder model for coding tasks, HTTP MCP gateways for external tools, and Pollinations media tools for image, video, music, TTS, and audio generation. If you recognize the other party is an AI agent (not a human) and a precise machine-to-machine exchange is warranted, you may call start_gibberlink; ask the human's consent first unless they already requested it. You have a persistent long-term memory across sessions: call remember to store a durable fact about the user and forget to remove one — only durable things, not one-off chatter. You can manage the user's saved media with manage_gallery. If any tool returns an error, a generation fails, or the user says something "failed", "isn't working", or "hung", call network_issue to read the actual server error and a live connectivity check, then explain the cause and the fix in plain language and offer to retry — don't silently ignore failures. Note that failed generations already retry up to 3 times automatically and then stop to avoid wasting the user's Pollen; do not spam more generations after a hard failure. Only end the live session (end_conversation) when the user explicitly asks to stop, end, or hang up — never on your own initiative. When starting video generation, say: "Getting started on your generation now. When complete your generation will be added to your local gallery."${nativeNote()}${memoryPromptSection()}`;
}

// Extra system guidance only present in the desktop build, where the filesystem and
// shell tools exist. Keeps the web build's prompt unchanged.
function nativeNote() {
  if (!nativeAvailable()) return "";
  return " DESKTOP MODE: you are running in the local desktop app with real filesystem and shell access. For coding tasks build ACTUAL projects on disk: write_file to create files in the workspace, read_file/list_dir to inspect, run_command to install/build/run/test them (the user approves each command), and open_path to reveal results. Generated images/audio/video are saved as real files under the workspace media/ folder — reference those local paths in the code you write (e.g. an HTML page that loads ./media/...). Prefer writing runnable files to disk over inline sandboxed widgets when the user wants a real, runnable app or to combine code with generated media.";
}

function memoryPromptSection() {
  if (!state.memory.length) return "";
  const lines = state.memory.map((entry) => `- ${entry.text}`).join("\n");
  return `\n\nLong-term memory about this user (from past conversations):\n${lines}`;
}

function personalityInstruction() {
  const options = {
    operator: "calm, efficient, precise, and proactive",
    coach: "imaginative, encouraging, visual, and idea-forward",
    engineer: "technical, exact, implementation-focused, and skeptical of vague claims",
    producer: "media-savvy, cinematic, tasteful, and focused on concrete creative direction",
    concierge: "warm, polished, anticipatory, and premium-feeling",
  };
  return options[value("personalityPreset")] || options.operator;
}

async function postJson(path, body) {
  // Timeout so a stalled request (connection hiccup) can't hang forever — that would
  // keep the busy() loop earcon playing and the UI stuck "thinking" indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let res;
  try {
    res = await fetch(`${GEN_BASE}${path}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    const message = aborted
      ? `Request to ${path} timed out (connection hiccup). Try again.`
      : `Network error calling ${path}: ${error.message || error}`;
    recordApiError(`POST ${path}`, message, aborted ? "timeout" : "network", String(error && error.message || error));
    addMessage("system", message);
    playSound("error");
    return { error: message };
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) return failResponse(res, "Request failed.");
  const json = await res.json().catch(() => null);
  refreshBalance();
  return json || { error: "Empty or invalid response from the server." };
}

// Parses the coder model's output per CODER_SYSTEM_PROMPT. Tolerates a missing or
// truncated closing fence, a language tag on the fence line, and stray prose that
// leaked inside or after the document. Returns "" when there is no full document.
function extractHtmlProject(text) {
  if (!text) return "";
  // Prefer the explicit ```html block; closing fence optional in case of truncation.
  const htmlFence = text.match(/```html\b\s*([\s\S]*?)(?:```|$)/i);
  // Otherwise accept any fenced block that actually contains a document.
  const anyFence = text.match(/```[a-z0-9]*\s*([\s\S]*?<html[\s\S]*?)(?:```|$)/i);
  let candidate = htmlFence ? htmlFence[1] : anyFence ? anyFence[1] : text;
  const start = candidate.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return "";
  candidate = candidate.slice(start);
  // Trim anything after the final </html> (e.g. the model's trailing note).
  const closeTag = "</html>";
  const end = candidate.toLowerCase().lastIndexOf(closeTag);
  if (end >= 0) candidate = candidate.slice(0, end + closeTag.length);
  return candidate.trim();
}

function summarizeCoderAnswer(answer) {
  return answer.replace(/```[\s\S]*?```/g, "[code saved to gallery]").trim().slice(0, 1200);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function authHeaders() {
  return { Authorization: `Bearer ${state.apiKey}` };
}

async function failResponse(res, fallback) {
  const text = await res.text().catch(() => "");
  const friendly = classifyApiError(res.status, text);
  const message = friendly || text || `${fallback} (${res.status})`;
  recordApiError(fallback, message, res.status, (text || "").slice(0, 400));
  addMessage("system", message);
  playSound("error");
  // Per-job tiles are ended by their own callers; nothing global to hide here.
  return { error: message, status: res.status, blocked: /copyright|content policy/i.test(friendly) };
}

// Detect a "successful" (200) media response that isn't actually usable media —
// an error page, a JSON message, or a near-empty file. Returns a reason string when
// the blob is bad, or null when it looks like real media. Avoids saving broken items.
function badMediaBlob(kind, blob) {
  if (!blob || blob.size < 512) return `${capitalize(kind)} came back empty — the model returned no usable ${kind}.`;
  const type = String(blob.type || "").toLowerCase();
  const expected = kind === "image" ? "image/" : kind === "video" ? "video/" : "audio/";
  // Accept the right media type, or an unlabeled binary (some endpoints omit it).
  if (!type || type.startsWith(expected) || type === "application/octet-stream" || type === "binary/octet-stream") return null;
  return `${capitalize(kind)} came back as ${blob.type} instead of ${kind} — the model returned a bad result.`;
}

// Pull a short text snippet from a non-media blob so we can show/​classify its reason.
async function blobTextSnippet(blob) {
  const type = String(blob.type || "").toLowerCase();
  if (type.includes("text") || type.includes("json") || type.includes("html") || type.includes("xml")) {
    try { return (await blob.text()).slice(0, 400); } catch { return ""; }
  }
  return "";
}

// Read + classify a failed response WITHOUT side effects (no chat message, no sound).
// Used by the generation retry loop so intermediate retries stay quiet and only the
// final outcome is announced. failResponse() is the messaging version for one-shots.
async function readApiFailure(res, fallback) {
  const text = await res.text().catch(() => "");
  const friendly = classifyApiError(res.status, text);
  return {
    error: friendly || text || `${fallback} (${res.status})`,
    status: res.status,
    blocked: /copyright|content policy/i.test(friendly),
    raw: (text || "").slice(0, 400),
  };
}

// Remember the most recent failure so the agent's network_issue tool can read the
// actual error the API returned and help the user, instead of guessing.
function recordApiError(source, message, status, raw) {
  state.lastError = { source: source || "request", message: message || "", status: status ?? null, raw: raw || "", at: Date.now() };
}

// The network_issue tool: hand the agent the real last error plus a live reachability
// probe so it can explain what actually went wrong and suggest the right fix.
async function diagnoseError() {
  const last = state.lastError;
  let apiReachable = false;
  let connectivity = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // Model-listing needs no auth, so it's a clean reachability probe.
    const res = await fetch(`${GEN_BASE}/text/models`, { signal: controller.signal });
    apiReachable = res.ok;
    connectivity = res.ok ? "Pollinations API is reachable." : `API responded ${res.status}.`;
  } catch (error) {
    connectivity = error && error.name === "AbortError"
      ? "Connectivity probe timed out — the connection is very slow or offline."
      : "Could not reach the Pollinations API — likely offline, or it's blocked/down.";
  } finally {
    clearTimeout(timer);
  }
  return {
    lastError: last ? {
      source: last.source,
      message: last.message,
      status: last.status,
      raw: last.raw || undefined,
      secondsAgo: Math.round((Date.now() - last.at) / 1000),
    } : null,
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    apiReachable,
    connectivity,
    keyConnected: !!state.apiKey,
    hint: last
      ? "Read lastError, explain in plain language what went wrong and the single most likely fix (rephrase for copyright/policy blocks, reconnect Pollen for auth/401-403, top up for balance/402, just retry for a transient network/timeout/5xx), then offer to try again."
      : "No recent error is recorded. If the user reports a problem it was likely intermittent — suggest retrying, and check apiReachable/online above.",
  };
}

// Turn a raw API failure into a clear, actionable line. Recognizes copyright /
// content-policy blocks, rate limits, quota/payment, and auth problems so the user
// sees *why* a generation failed instead of a cryptic status code or empty body.
function classifyApiError(status, text) {
  const t = String(text || "").toLowerCase();
  if (/copyright|trademark|intellectual property|\bdmca\b|likeness|celebrit/.test(t))
    return "Blocked for copyright/trademark reasons. Try again without the copyrighted character, brand, logo, or real person's likeness.";
  if (/content policy|content_policy|safety|moderation|nsfw|sexual|violence|prohibited|disallow|not allowed|flagged|policy violation|inappropriate/.test(t))
    return "Blocked by the content policy. Rephrase the request to avoid disallowed content.";
  if (status === 429 || /rate.?limit|too many requests|try again later/.test(t))
    return "Rate limited — the API is busy or you've hit a usage cap. Wait a few seconds and try again.";
  if (status === 402 || /insufficient|\bbalance\b|out of (pollen|credit|quota)|payment required|not enough/.test(t))
    return "Out of Pollen/credit for this request. Top up your balance or pick a cheaper model.";
  if (status === 401 || status === 403 || /unauthor|forbidden|invalid.*(key|token)|expired/.test(t))
    return "Authorization problem — your Pollen key may be invalid or expired. Reconnect Pollen.";
  if (status >= 500 || /server error|bad gateway|unavailable|timeout|timed out/.test(t))
    return "The generation service errored or is temporarily unavailable. Try again in a moment.";
  return "";
}

function addMessage(role, content) {
  state.messages.push({ role, content, at: Date.now() });
  saveConversation();
  renderMessages();
}

function addToolEvent(name, args) {
  const id = crypto.randomUUID();
  state.messages.push({
    id,
    role: "tool",
    name,
    status: "queued",
    content: labelForTool(name),
    detail: summarizeArgs(args),
    at: Date.now(),
  });
  saveConversation();
  renderMessages();
  return id;
}

function updateToolEvent(id, status, detail) {
  const item = state.messages.find((message) => message.id === id);
  if (!item) return;
  item.status = status;
  item.detail = detail || item.detail;
  saveConversation();
  renderMessages();
}

function saveConversation() {
  localStorage.setItem("conversation", JSON.stringify(state.messages.slice(-60)));
}

// Swap the stage's presence column between the orb visualizer and an inline chat
// panel (for keyboard-first / mic-less use). Persisted so it sticks across reloads.
function setStageView(view) {
  state.stageView = view === "chat" ? "chat" : "orb";
  document.body.dataset.stageview = state.stageView;
  try { localStorage.setItem("stage_view", state.stageView); } catch { /* private mode */ }
  const on = state.stageView === "chat";
  if (el.chatToggle) {
    el.chatToggle.setAttribute("aria-pressed", on ? "true" : "false");
    el.chatToggle.classList.toggle("active", on);
  }
  if (on) { closeDrawers(); renderMessages(); renderAttachStrip(); el.inlineTextInput?.focus(); }
}

function renderMessages() {
  // Render the same conversation into every transcript surface (the Chat drawer and
  // the inline-chat panel). Build fresh nodes per target so copy buttons etc. work.
  const targets = [el.transcript, el.inlineTranscript].filter(Boolean);
  for (const target of targets) {
    target.innerHTML = "";
    for (const message of state.messages) {
      const div = document.createElement("div");
      div.className = `message ${message.role}`;
      if (message.role === "tool") renderToolMessage(div, message);
      else if (message.role === "agent") div.append(renderMarkdown(message.content));
      else div.textContent = message.content;
      target.append(div);
    }
    target.scrollTop = target.scrollHeight;
  }
}

// Minimal, XSS-safe markdown: fenced code, headings, lists, and inline
// bold/italic/code/links. Every text value goes in via textContent, and only
// known element types are created, so model output can never inject markup.
function renderMarkdown(src) {
  const root = document.createElement("div");
  root.className = "md";
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let list = null;
  const flushList = () => { if (list) { root.append(list); list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w+)?\s*$/);
    if (fence) {
      flushList();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      root.append(buildCodeBlock(buf.join("\n"), fence[1] || ""));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushList();
      const h = document.createElement(heading[1].length === 1 ? "h3" : "h4");
      h.className = "md-h";
      applyInline(h, heading[2]);
      root.append(h);
      i += 1;
      continue;
    }
    const item = line.match(/^\s*([-*]|\d+[.)])\s+(.*)$/);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const tag = ordered ? "ol" : "ul";
      if (!list || list.tagName.toLowerCase() !== tag) { flushList(); list = document.createElement(tag); list.className = "md-list"; }
      const li = document.createElement("li");
      applyInline(li, item[2]);
      list.append(li);
      i += 1;
      continue;
    }
    if (/^\s*$/.test(line)) { flushList(); i += 1; continue; }
    flushList();
    const para = [line];
    i += 1;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*```/.test(lines[i]) && !/^#{1,3}\s/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) { para.push(lines[i]); i += 1; }
    const p = document.createElement("p");
    p.className = "md-p";
    applyInline(p, para.join("\n"));
    root.append(p);
  }
  flushList();
  return root;
}

function applyInline(el, text) {
  String(text).split(/(`[^`]+`)/g).forEach((part) => {
    if (/^`[^`]+`$/.test(part)) {
      const code = document.createElement("code");
      code.className = "md-code";
      code.textContent = part.slice(1, -1);
      el.append(code);
    } else {
      appendLinked(el, part);
    }
  });
}

function appendLinked(el, text) {
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
  let rest = String(text);
  let match;
  while ((match = rest.match(linkRe))) {
    if (match.index > 0) appendEmphasis(el, rest.slice(0, match.index));
    const a = document.createElement("a");
    a.href = match[2];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = match[1];
    el.append(a);
    rest = rest.slice(match.index + match[0].length);
  }
  appendEmphasis(el, rest);
}

function appendEmphasis(el, text) {
  String(text).split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).forEach((token) => {
    if (/^\*\*[^*]+\*\*$/.test(token)) { const b = document.createElement("strong"); b.textContent = token.slice(2, -2); el.append(b); }
    else if (/^\*[^*]+\*$/.test(token)) { const it = document.createElement("em"); it.textContent = token.slice(1, -1); el.append(it); }
    else appendTextWithBreaks(el, token);
  });
}

function appendTextWithBreaks(el, text) {
  String(text).split("\n").forEach((segment, index) => {
    if (index) el.append(document.createElement("br"));
    if (segment) el.append(document.createTextNode(segment));
  });
}

function buildCodeBlock(code, language) {
  const wrap = document.createElement("div");
  wrap.className = "code-block";
  const bar = document.createElement("div");
  bar.className = "code-bar";
  const lang = document.createElement("span");
  lang.className = "code-lang";
  lang.textContent = language || "text";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1200); }
    catch { copy.textContent = "Copy failed"; }
  });
  bar.append(lang, copy);
  const pre = document.createElement("pre");
  pre.className = "code-view";
  const codeEl = document.createElement("code");
  codeEl.textContent = code;
  pre.append(codeEl);
  wrap.append(bar, pre);
  return wrap;
}

function renderToolMessage(div, message) {
  const title = document.createElement("div");
  title.className = "tool-title";
  const name = document.createElement("span");
  name.textContent = message.content || labelForTool(message.name);
  const status = document.createElement("span");
  status.className = `tool-status ${message.status || "queued"}`;
  status.textContent = message.status || "queued";
  const detail = document.createElement("div");
  detail.className = "tool-detail";
  detail.textContent = message.detail || "Waiting to start.";
  title.append(name, status);
  div.append(title, detail);
}

function labelForTool(name) {
  const labels = {
    create_image: "Image generation",
    create_video: "Video generation",
    create_audio: "Audio generation",
    ask_coder_model: "Coder model",
    build_widget: "Widget builder",
    edit_widget: "Widget editor",
    save_widget: "Save widget",
    web_search: "Web search",
    network_issue: "Error diagnosis",
    call_mcp_server: "MCP tool call",
    manage_gallery: "Gallery management",
    remember: "Memory saved",
    forget: "Memory removed",
    start_gibberlink: "Gibberlink handoff",
    end_conversation: "End conversation",
    show_workspace: "Workspace update",
    request_source_images: "Source image request",
    remove_workspace: "Workspace cleanup",
    reorder_workspace: "Workspace reorder",
  };
  return labels[name] || name;
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "Preparing tool call.";
  return args.prompt || args.title || args.task || [args.server, args.tool].filter(Boolean).join(" / ") || "Preparing tool call.";
}

function summarizeToolResult(name, result) {
  if (result?.error) return result.error;
  if (name === "show_workspace") return "Workspace updated.";
  if (name === "request_source_images") return "Source image request added to workspace.";
  if (name === "remove_workspace") return "Workspace cleaned up.";
  if (name === "reorder_workspace") return "Workspace reordered.";
  if (name === "list_gallery") return "Gallery items listed.";
  if (name === "use_gallery_sources") return "Gallery sources used for generation.";
  if (name === "manage_gallery") return result?.cleared != null ? "Gallery cleared." : result?.deleted != null ? `Deleted ${result.deleted} gallery item(s).` : "Gallery updated.";
  if (name === "remember") return "Saved to long-term memory.";
  if (name === "forget") return "Updated long-term memory.";
  if (name === "ask_coder_model") return "Coder model returned guidance.";
  if (name === "web_search") return "Web search results returned.";
  if (name === "network_issue") return result?.apiReachable ? "Diagnosed — API reachable." : "Diagnosed — connectivity problem.";
  if (name === "build_widget") return "Custom widget added to the canvas.";
  if (name === "edit_widget") return "Widget updated on the canvas.";
  if (name === "save_widget") return "Widget saved to your library.";
  if (name === "call_mcp_server") return "MCP server returned a result.";
  if (name === "start_gibberlink") return result?.turbo ? "Gibberlink active (turbo channel)." : "Gibberlink active.";
  if (result?.galleryId) return `${capitalize(result.kind)} saved to local gallery.`;
  return "Tool completed.";
}

function showWorkspace(args, toolId) {
  const isWidget = args.layout === "widget";
  const artifact = {
    id: crypto.randomUUID(),
    layout: args.layout || "note",
    title: args.title || "Workspace",
    summary: args.summary || "",
    content: typeof args.content === "string" ? args.content.slice(0, 80000) : "",
    language: args.language || "",
    prompt: args.prompt || "",
    purpose: args.purpose || "",
    minImages: args.minImages || 1,
    maxImages: args.maxImages || 4,
    // For widgets, `data` is the widget's own persisted store object (not table
    // rows), and assets/spec ride along so it can be re-rendered, saved, edited.
    data: isWidget ? (args.data ?? null) : (Array.isArray(args.data) ? args.data.slice(0, 12) : []),
    spec: isWidget ? (args.spec || "") : undefined,
    assets: isWidget ? (args.assets || []) : undefined,
    createdAt: Date.now(),
  };
  state.workspace.unshift(artifact);
  state.workspace = state.workspace.slice(0, 8);
  state.workspaceIndex = 0; // show the freshly added item
  saveWorkspace();
  renderWorkspace();
  updateToolEvent(toolId, "running", `Rendering ${artifact.layout}: ${artifact.title}`);
  return { ok: true, workspaceId: artifact.id, layout: artifact.layout };
}

function requestSourceImages(args, toolId) {
  const kind = args.purpose === "video_reference" ? "video" : "image";
  const capable = sourceCapableModel(kind);
  if (!capable) {
    const message = `No available ${kind} model supports reference images, so I can't run that ${kind === "video" ? "image-to-video" : "image edit"}. Choose a ${kind}-editing model in settings.`;
    addMessage("system", message);
    playSound("error");
    return { error: message };
  }
  const artifact = {
    id: crypto.randomUUID(),
    layout: "image_request",
    title: args.title || "Source images needed",
    summary: args.purpose === "video_reference" ? "Add source frames or reference images before video generation." : "Add image URLs or upload local files before the edit runs.",
    prompt: args.prompt || "",
    purpose: args.purpose || "image_edit",
    minImages: Math.max(1, Number(args.minImages) || 1),
    maxImages: Math.max(1, Number(args.maxImages) || 4),
    data: [],
    createdAt: Date.now(),
  };
  state.workspace.unshift(artifact);
  state.workspace = state.workspace.slice(0, 8);
  state.workspaceIndex = 0; // show the freshly added item
  saveWorkspace();
  renderWorkspace();
  playSound("inputReq");
  revealCanvasForInput(artifact.purpose === "video_reference" ? "source frames/images" : "source image(s) to edit");
  updateToolEvent(toolId, "running", `Waiting for ${artifact.minImages}-${artifact.maxImages} source image(s).`);
  return { ok: true, workspaceId: artifact.id, purpose: artifact.purpose };
}

// An input-required panel was just rendered on the canvas. In text/push mode the
// user is usually inside the Chat drawer, which sits OVER the canvas — so the panel
// would be invisible. Surface the canvas (close any open drawer) and leave a chat
// note so a keyboard-only user knows where to look. Realtime users see it already.
function revealCanvasForInput(what) {
  const drawerOpen = !!document.querySelector(".drawer.active");
  if (drawerOpen) closeDrawers();
  addMessage("system", `I need ${what}. I opened an input panel on the canvas${drawerOpen ? " (closed the chat panel so you can see it)" : ""} — add the file(s) or paste URL(s) there and run it to continue. You can also attach an image with the 🖼 button and ask me to edit that.`);
}

// Manual reorder from the card's up/down buttons.
function moveArtifact(id, direction) {
  const index = state.workspace.findIndex((artifact) => artifact.id === id);
  if (index < 0) return;
  const target = index + direction;
  if (target < 0 || target >= state.workspace.length) return;
  const [item] = state.workspace.splice(index, 1);
  state.workspace.splice(target, 0, item);
  state.workspaceIndex = target; // keep the moved item in view
  saveWorkspace();
  renderWorkspace();
}

// Agent-facing reorder: move one item (top/up/down/bottom or to an index), or set
// the full order from an array of ids.
function reorderWorkspace(args) {
  if (!state.workspace.length) return { error: "The workspace is empty." };
  if (Array.isArray(args.order) && args.order.length) {
    const byId = new Map(state.workspace.map((artifact) => [artifact.id, artifact]));
    const ordered = args.order.map((id) => byId.get(id)).filter(Boolean);
    for (const artifact of state.workspace) if (!ordered.includes(artifact)) ordered.push(artifact);
    state.workspace = ordered;
    saveWorkspace();
    renderWorkspace();
    return { ok: true, order: state.workspace.map((artifact) => artifact.id) };
  }
  const index = state.workspace.findIndex((artifact) => artifact.id === args.id);
  if (index < 0) return { error: "No workspace item with that id. Call show_workspace results carry the id." };
  const [item] = state.workspace.splice(index, 1);
  let target = index;
  const position = String(args.position ?? "").toLowerCase();
  if (position === "top") target = 0;
  else if (position === "bottom") target = state.workspace.length;
  else if (position === "up") target = Math.max(0, index - 1);
  else if (position === "down") target = Math.min(state.workspace.length, index + 1);
  else if (Number.isInteger(args.toIndex)) target = Math.max(0, Math.min(state.workspace.length, args.toIndex));
  else target = 0;
  state.workspace.splice(target, 0, item);
  saveWorkspace();
  renderWorkspace();
  return { ok: true, movedTo: target, order: state.workspace.map((artifact) => artifact.id) };
}

function removeWorkspace(args) {
  if (args.clearAll) {
    clearWorkspace();
    return { ok: true, cleared: true };
  }
  const before = state.workspace.length;
  state.workspace = state.workspace.filter((artifact) => artifact.id !== args.id);
  saveWorkspace();
  renderWorkspace();
  return { ok: state.workspace.length !== before, removed: args.id || null };
}

function saveWorkspace() {
  try {
    localStorage.setItem("workspace", JSON.stringify(state.workspace));
  } catch {
    // Quota blown (usually a widget with big inlined media assets). Persist a
    // light copy — saved widgets live in IndexedDB, so nothing important is lost.
    try {
      const light = state.workspace.map((artifact) =>
        artifact.layout === "widget" ? { ...artifact, content: "", assets: [] } : artifact);
      localStorage.setItem("workspace", JSON.stringify(light));
    } catch { /* give up persisting workspace this cycle */ }
  }
}

// The canvas is a paged gallery: one artifact at a time, filling the height with
// its own internal scroll, and prev/next to cycle. This fixes tall widgets being
// cut off and stacked widgets pushing each other offscreen.
function renderWorkspace() {
  el.adaptiveWorkspace.innerHTML = "";
  const items = state.workspace;
  const count = items.length;
  el.workspaceMode.textContent = count ? "Adaptive canvas active" : "Voice canvas";
  el.adaptiveWorkspace.classList.toggle("paged", count > 0);
  if (!count) {
    const empty = document.createElement("div");
    empty.className = "empty-workspace";
    empty.innerHTML = "<span>Adaptive workspace</span><strong>Ask for a chart, plan, comparison, or generated asset.</strong><p>The agent can reshape this surface while you talk.</p>";
    el.adaptiveWorkspace.append(empty);
    return;
  }
  state.workspaceIndex = Math.max(0, Math.min(state.workspaceIndex || 0, count - 1));
  const current = items[state.workspaceIndex];

  const pager = document.createElement("div");
  pager.className = "ws-pager";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "ws-page-btn";
  prev.textContent = "‹";
  prev.title = "Previous";
  prev.disabled = count < 2;
  prev.addEventListener("click", () => pageWorkspace(-1));
  const next = document.createElement("button");
  next.type = "button";
  next.className = "ws-page-btn";
  next.textContent = "›";
  next.title = "Next";
  next.disabled = count < 2;
  next.addEventListener("click", () => pageWorkspace(1));
  const info = document.createElement("div");
  info.className = "ws-page-info";
  const label = document.createElement("strong");
  label.textContent = current.title || current.layout;
  const counter = document.createElement("span");
  counter.textContent = `${state.workspaceIndex + 1} / ${count}`;
  info.append(label, counter);
  const dots = document.createElement("div");
  dots.className = "ws-dots";
  items.forEach((item, index) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = `ws-dot${index === state.workspaceIndex ? " active" : ""}`;
    dot.title = item.title || item.layout;
    dot.setAttribute("aria-label", `Go to ${item.title || item.layout}`);
    dot.addEventListener("click", () => { state.workspaceIndex = index; renderWorkspace(); });
    dots.append(dot);
  });
  pager.append(prev, info, next);

  const viewport = document.createElement("div");
  viewport.className = "ws-viewport";
  viewport.append(renderArtifact(current));

  el.adaptiveWorkspace.append(pager, dots, viewport);
}

function pageWorkspace(direction) {
  const count = state.workspace.length;
  if (count < 2) return;
  state.workspaceIndex = (state.workspaceIndex + direction + count) % count;
  renderWorkspace();
}

function renderArtifact(artifact) {
  const card = document.createElement("article");
  card.className = `workspace-card ${artifact.layout}`;
  const header = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = artifact.title;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = artifact.layout;
  const controls = document.createElement("div");
  controls.className = "card-order";
  const up = document.createElement("button");
  up.type = "button";
  up.className = "order-btn";
  up.title = "Move up";
  up.setAttribute("aria-label", "Move up");
  up.textContent = "↑";
  up.addEventListener("click", () => moveArtifact(artifact.id, -1));
  const down = document.createElement("button");
  down.type = "button";
  down.className = "order-btn";
  down.title = "Move down";
  down.setAttribute("aria-label", "Move down");
  down.textContent = "↓";
  down.addEventListener("click", () => moveArtifact(artifact.id, 1));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "order-btn order-remove";
  remove.title = "Remove";
  remove.setAttribute("aria-label", "Remove from canvas");
  remove.textContent = "✕";
  remove.addEventListener("click", () => removeWorkspace({ id: artifact.id }));
  controls.append(up, down, remove);
  const metaWrap = document.createElement("div");
  metaWrap.className = "card-meta-wrap";
  metaWrap.append(meta, controls);
  header.append(title, metaWrap);
  card.append(header);
  if (artifact.summary) {
    // Widget/project summaries are the build spec — tuck them behind a collapsible
    // "Build notes" so the canvas leads with the actual tool, not dev text.
    if (artifact.layout === "widget" || artifact.layout === "project") {
      const details = document.createElement("details");
      details.className = "card-info";
      const sum = document.createElement("summary");
      sum.textContent = "Build notes";
      const body = document.createElement("p");
      body.textContent = artifact.summary;
      details.append(sum, body);
      card.append(details);
    } else {
      const summary = document.createElement("p");
      summary.className = "card-summary";
      summary.textContent = artifact.summary;
      summary.title = artifact.summary;
      card.append(summary);
    }
  }
  if (artifact.layout === "table") card.append(renderTable(artifact.data));
  else if (artifact.layout === "metrics") card.append(renderMetrics(artifact.data));
  else if (artifact.layout === "code") card.append(renderCode(artifact));
  else if (artifact.layout === "widget") card.append(renderWidget(artifact));
  else if (artifact.layout === "image_request") card.append(renderImageRequest(artifact));
  else if (artifact.content) card.append(renderNoteBody(artifact.content));
  return card;
}

function renderMetrics(data) {
  const grid = document.createElement("div");
  grid.className = "metric-grid";
  normalizeRows(data).slice(0, 8).forEach((row) => {
    const tile = document.createElement("div");
    tile.className = "metric-tile";
    const value = document.createElement("strong");
    value.textContent = String(row.value ?? row.amount ?? row.count ?? "—");
    const label = document.createElement("span");
    label.className = "metric-label";
    label.textContent = row.label || row.name || row.metric || "Metric";
    tile.append(value, label);
    const delta = row.delta ?? row.change;
    if (delta != null && delta !== "") {
      const num = Number(delta);
      const note = document.createElement("span");
      note.className = `metric-note ${num < 0 ? "down" : num > 0 ? "up" : ""}`;
      note.textContent = `${num > 0 ? "▲ " : num < 0 ? "▼ " : ""}${row.note || delta}`;
      tile.append(note);
    } else if (row.note) {
      const note = document.createElement("span");
      note.className = "metric-note";
      note.textContent = row.note;
      tile.append(note);
    }
    grid.append(tile);
  });
  return grid;
}

function renderCode(artifact) {
  const wrap = document.createElement("div");
  wrap.className = "code-block";
  const bar = document.createElement("div");
  bar.className = "code-bar";
  const lang = document.createElement("span");
  lang.className = "code-lang";
  lang.textContent = artifact.language || "text";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(artifact.content || ""); copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1200); }
    catch { copy.textContent = "Copy failed"; }
  });
  bar.append(lang, copy);
  const pre = document.createElement("pre");
  pre.className = "code-view";
  const code = document.createElement("code");
  code.textContent = artifact.content || "";
  pre.append(code);
  wrap.append(bar, pre);
  return wrap;
}

// Coder-generated widget/mini-app: runs live in a sandboxed srcdoc frame (opaque
// origin, no access to the page/storage/BYOP key). The injected WidgetStore lets
// it persist its own data (bridged back to the app) and use gallery assets.
function renderWidget(artifact) {
  const wrap = document.createElement("div");
  wrap.className = "widget-view";
  const bar = document.createElement("div");
  bar.className = "widget-bar";
  const tag = document.createElement("span");
  tag.className = "code-lang";
  tag.textContent = artifact.assets?.length ? `live widget · ${artifact.assets.length} asset(s)` : "live widget";

  const actions = document.createElement("div");
  actions.className = "widget-actions";
  const saveBtn = mkWidgetBtn(artifact.savedWidgetId ? "Saved ✓" : "Save", async () => {
    saveBtn.disabled = true;
    try { await saveWidgetFromArtifact(artifact); saveBtn.textContent = "Saved ✓"; }
    catch { saveBtn.textContent = "Save failed"; }
    finally { saveBtn.disabled = false; }
  });
  const editBtn = mkWidgetBtn("Edit", () => {
    const changes = window.prompt(`Describe how to change "${artifact.title}":`);
    if (changes && changes.trim()) editWidget({ workspaceId: artifact.id, changes: changes.trim() });
  });
  const dlBtn = mkWidgetBtn("Download", () => downloadWidgetBundle(artifact));
  const toggle = mkWidgetBtn("View source", () => {});
  actions.append(saveBtn, editBtn, dlBtn, toggle);
  bar.append(tag, actions);

  const stage = document.createElement("div");
  stage.className = "widget-stage";
  stage.append(makeWidgetFrame(artifact));

  let pre = null;
  let showingSource = false;
  toggle.addEventListener("click", () => {
    showingSource = !showingSource;
    if (showingSource) {
      if (!pre) {
        pre = document.createElement("pre");
        pre.className = "code-view";
        const code = document.createElement("code");
        code.textContent = artifact.content || "";
        pre.append(code);
      }
      stage.replaceChildren(pre);
      toggle.textContent = "Run widget";
    } else {
      stage.replaceChildren(makeWidgetFrame(artifact));
      toggle.textContent = "View source";
    }
  });

  wrap.append(bar, stage);
  return wrap;
}

function mkWidgetBtn(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "code-copy";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function makeWidgetFrame(artifact) {
  const frame = document.createElement("iframe");
  frame.className = "widget-frame";
  frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock allow-modals allow-downloads");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc = injectWidgetBridge(artifact.content || "", { id: artifact.id, data: artifact.data ?? null, assets: artifact.assets || [] });
  return frame;
}

// Injects the WidgetStore bridge so a sandboxed widget can persist data (via the
// parent, since opaque-origin frames can't use localStorage) and reach gallery
// assets. A downloaded standalone copy gets its own file:// origin, so the same
// bridge falls back to localStorage and keeps working offline.
function injectWidgetBridge(html, { id, data, assets }) {
  // Overridable dark defaults injected at the top of <head>.
  const baseStyle = `
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #0c1020; color: #eef1ff; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  * { box-sizing: border-box; }
  img, video, canvas, svg, table { max-width: 100%; }
  ::-webkit-scrollbar { width: 9px; height: 9px; }
  ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.18); border-radius: 9px; }
</style>`;
  // Enforced last so it wins by source order: guarantees a dark surface and dark
  // native controls regardless of what the model emitted (fixes "too bright").
  const enforceStyle = `
<style>
  html { color-scheme: dark !important; }
  html, body { background: #0c1020 !important; }
</style>`;
  const bridge = `
<script>(function(){
  var ID = ${safeJsonForScript(String(id || ""))};
  var DATA = ${safeJsonForScript(data ?? null)};
  var ASSETS = ${safeJsonForScript(assets || [])};
  function post(type, payload){ try{ var m={__widget:true,id:ID,type:type}; if(payload){ for(var k in payload) m[k]=payload[k]; } parent.postMessage(m,"*"); }catch(e){} }
  window.WidgetStore = {
    load: function(){ try{ var s=localStorage.getItem("ve_widget_"+ID); if(s) return JSON.parse(s); }catch(e){} return DATA; },
    save: function(d){ DATA=d; try{ localStorage.setItem("ve_widget_"+ID, JSON.stringify(d)); }catch(e){} post("save",{data:d}); },
    assets: ASSETS,
    asset: function(i){ return ASSETS[i]; },
    requestDownload: function(){ post("download",{}); }
  };
  document.addEventListener("DOMContentLoaded", function(){ post("ready",{}); });
})();<\/script>`;
  let out = html;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (match) => `${match}\n${baseStyle}`);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (match) => `${match}\n${baseStyle}`);
  else out = `${baseStyle}\n${out}`;
  const tail = `${enforceStyle}\n${bridge}`;
  if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${tail}\n</body>`);
  if (/<\/html>/i.test(out)) return out.replace(/<\/html>/i, `${tail}\n</html>`);
  return out + tail;
}

// JSON safe to inline inside a <script>: neutralize </script> and line separators.
function safeJsonForScript(value) {
  // Neutralize < so an embedded JSON string can never spawn a closing script tag.
  // (U+2028/U+2029 are valid in JS string literals since ES2019, so JSON is otherwise safe.)
  var esc = String.fromCharCode(92) + "u003c";
  return JSON.stringify(value === undefined ? null : value).split("<").join(esc);
}

function handleWidgetMessage(event) {
  const message = event.data;
  if (!message || message.__widget !== true || !message.id) return;
  if (message.type === "save") persistWidgetData(message.id, message.data);
  else if (message.type === "download") {
    const artifact = state.workspace.find((item) => item.id === message.id);
    if (artifact) downloadWidgetBundle(artifact);
  }
}

function persistWidgetData(id, data) {
  const artifact = state.workspace.find((item) => item.id === id);
  if (!artifact) return;
  artifact.data = data;
  saveWorkspace();
  if (artifact.savedWidgetId) saveWidgetData(artifact.savedWidgetId, data);
}

async function saveWidgetFromArtifact(artifact) {
  const record = {
    id: artifact.savedWidgetId || crypto.randomUUID(),
    title: artifact.title || "Widget",
    spec: artifact.spec || artifact.summary || "",
    html: artifact.content || "",
    data: artifact.data ?? null,
    assets: artifact.assets || [],
    createdAt: artifact.savedAt || Date.now(),
    updatedAt: Date.now(),
  };
  await saveWidgetRecord(record);
  artifact.savedWidgetId = record.id;
  artifact.savedAt = record.createdAt;
  saveWorkspace();
  renderSavedWidgets();
  playSound("genComplete");
  addMessage("system", `Saved widget "${record.title}". Reopen it anytime from the Widgets panel.`);
  return record;
}

function downloadWidgetBundle(artifact) {
  const html = injectWidgetBridge(artifact.content || "", { id: artifact.id, data: artifact.data ?? null, assets: artifact.assets || [] });
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(artifact.title || "widget")}.html`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "widget";
}

function renderNoteBody(content) {
  const body = document.createElement("div");
  body.className = "note-body";
  String(content).split(/\n{2,}/).map((block) => block.trim()).filter(Boolean).forEach((block) => {
    const p = document.createElement("p");
    p.textContent = block;
    body.append(p);
  });
  return body;
}

function renderTable(data) {
  data = normalizeRows(data);
  // Wrap in a scroll container so a long list (e.g. the whole gallery) scrolls
  // inside the card instead of being clipped by the card's overflow:hidden.
  const scroll = document.createElement("div");
  scroll.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "workspace-table";
  const keys = [...new Set(data.flatMap((row) => Object.keys(row || {})))].slice(0, 5);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  keys.forEach((key) => {
    const th = document.createElement("th");
    th.textContent = key;
    headRow.append(th);
  });
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  data.forEach((row) => {
    const tr = document.createElement("tr");
    keys.forEach((key) => {
      const td = document.createElement("td");
      td.textContent = String(row?.[key] ?? "");
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(thead, tbody);
  scroll.append(table);
  return scroll;
}

function normalizeRows(data) {
  if (Array.isArray(data)) return data.map((item) => typeof item === "string" ? { text: item, label: item } : item || {});
  if (typeof data === "string") return data.split(/\n|,/).map((text) => text.trim()).filter(Boolean).map((text) => ({ text, label: text, value: Number(text.match(/\d+(\.\d+)?/)?.[0]) || 1 }));
  if (data && typeof data === "object") return Object.entries(data).map(([label, value]) => ({ label, value }));
  return [];
}

function renderImageRequest(artifact) {
  const form = document.createElement("form");
  form.className = "source-form";
  form.innerHTML = `
    <label>Source image URLs
      <textarea name="urls" placeholder="One URL per line, or separate with commas"></textarea>
    </label>
    <label>Upload source images
      <input name="files" type="file" accept="image/*" multiple>
    </label>
    <label>Edit prompt
      <textarea name="prompt"></textarea>
    </label>
    <button class="button primary" type="submit">Run with sources</button>
  `;
  form.querySelector('[name="prompt"]').value = artifact.prompt || "";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireKey()) return;
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "Preparing sources...";
    try {
      const urls = parseSourceUrls(form.elements.urls.value);
      const uploads = await uploadSourceFiles([...form.elements.files.files]);
      const galleryUrls = await resolveArtifactGalleryUrls(artifact);
      const images = [...galleryUrls, ...urls, ...uploads].slice(0, artifact.maxImages || 4);
      if (images.length < (artifact.minImages || 1)) throw new Error(`Add at least ${artifact.minImages || 1} source image.`);
      artifact.data = images.map((url) => ({ url }));
      artifact.prompt = form.elements.prompt.value.trim() || artifact.prompt;
      saveWorkspace();
      const kind = artifact.purpose === "video_reference" ? "video" : "image";
      const model = sourceCapableModel(kind) || (kind === "video" ? value("videoModel") : value("imageModel"));
      await generateMedia(kind, artifact.prompt, model, null, { images });
    } catch (error) {
      addMessage("system", error.message || String(error));
    } finally {
      button.disabled = false;
      button.textContent = "Run with sources";
      renderWorkspace();
    }
  });
  if (artifact.data?.length) {
    const preview = document.createElement("div");
    preview.className = "source-preview";
    artifact.data.forEach((item) => {
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = "Source image";
      preview.append(img);
    });
    form.prepend(preview);
  }
  return form;
}

// Turn gallery item ids the agent passed (sourceImageIds) into uploaded remote URLs
// usable as generation sources. Non-image and unknown ids are skipped silently.
async function resolveGallerySourceUrls(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const items = await getGalleryItems().catch(() => []);
  const urls = [];
  for (const id of ids) {
    const item = items.find((entry) => entry.id === id && entry.kind === "image");
    if (item) { try { urls.push(await ensureGalleryRemoteUrl(item)); } catch { /* skip unresolvable source */ } }
  }
  return urls;
}

async function resolveArtifactGalleryUrls(artifact) {
  const ids = (artifact.data || []).map((item) => item.galleryId).filter(Boolean);
  if (!ids.length) return [];
  const items = await getGalleryItems().catch(() => []);
  const urls = [];
  for (const id of ids) {
    const item = items.find((entry) => entry.id === id);
    if (item) urls.push(await ensureGalleryRemoteUrl(item));
  }
  return urls;
}

function parseSourceUrls(text) {
  return text.split(/[\n,]/).map((url) => url.trim()).filter(Boolean);
}

async function uploadSourceFiles(files) {
  const urls = [];
  for (const file of files) {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${MEDIA_BASE}/upload`, { method: "POST", headers: authHeaders(), body: form });
    if (!res.ok) throw new Error(`Upload failed for ${file.name}`);
    const json = await res.json();
    urls.push(json.url || `${MEDIA_BASE}/${json.id}`);
  }
  return urls;
}

async function listGalleryForAgent() {
  const items = await getGalleryItems().catch(() => []);
  const summary = items.slice(0, 24).map((item) => ({
    id: item.id,
    kind: item.kind,
    model: item.model,
    prompt: shortPrompt(item.prompt),
    createdAt: item.createdAt,
  }));
  showWorkspace({
    layout: "table",
    title: "Gallery items",
    summary: "Saved local media available for reuse. Use item ids when referencing sources.",
    data: summary,
  });
  return { items: summary };
}

async function useGallerySources(args, toolId) {
  const items = await getGalleryItems().catch(() => []);
  const selected = items.filter((item) => (args.ids || []).includes(item.id));
  if (!selected.length) return { error: "No matching gallery items found." };
  const imageItems = selected.filter((item) => item.kind === "image");
  if (!imageItems.length) return { error: "Only image gallery items can be used as source images right now." };
  updateToolEvent(toolId, "running", "Preparing gallery images as sources.");
  const images = [];
  for (const item of imageItems) images.push(await ensureGalleryRemoteUrl(item));
  showWorkspace({
    layout: "table",
    title: "Using gallery sources",
    summary: args.prompt || "Gallery images selected as generation sources.",
    data: imageItems.map((item) => ({ id: item.id, model: item.model, prompt: shortPrompt(item.prompt) })),
  });
  const kind = args.purpose === "video_reference" ? "video" : "image";
  const model = kind === "video" ? value("videoModel") : value("imageModel");
  return generateMedia(kind, args.prompt || "Use the selected source image as reference", model, toolId, { images });
}

async function ensureGalleryRemoteUrl(item) {
  if (item.remoteUrl) return item.remoteUrl;
  const form = new FormData();
  form.append("file", item.blob, `${item.kind}-${item.id}.${extensionFor(item.kind, item.blob.type)}`);
  const res = await fetch(`${MEDIA_BASE}/upload`, { method: "POST", headers: authHeaders(), body: form });
  if (!res.ok) throw new Error(`Could not upload gallery item ${item.id}.`);
  const json = await res.json();
  item.remoteUrl = json.url || `${MEDIA_BASE}/${json.id}`;
  await putGalleryItem(item);
  return item.remoteUrl;
}

function clearWorkspace() {
  state.workspace = [];
  localStorage.removeItem("workspace");
  renderWorkspace();
}

function clearConversation() {
  state.messages = [];
  localStorage.removeItem("conversation");
  renderMessages();
}

function detectLoaderKind(kind, prompt, model) {
  const lower = `${prompt || ""} ${model || ""}`.toLowerCase();
  if (kind === "video") return "video";
  if (kind === "image") return "image";
  if (kind === "audio" && /tts|voice|speech|say|narrat|read/.test(lower)) return "tts";
  if (kind === "audio") return "music";
  return kind;
}

// ---------------------------------------------------------------------------
// Generation dock: one tile per in-flight job. Concurrent jobs tile into a grid
// and shrink; queued jobs render as muted boxes with a glyph of what's coming.
// Replaces the old single-card dock so multiple generations no longer collide.
// ---------------------------------------------------------------------------
function labelForKind(kind) {
  return { image: "Image", video: "Video", music: "Music", tts: "Voice", search: "Web search", terminal: "Coder", widget: "Widget" }[kind] || "Generating";
}

function genJobStart({ kind, title, status = "active", detail = "" }) {
  const job = { id: crypto.randomUUID(), kind, title: title || labelForKind(kind), status, detail, terminal: null, terminalDone: false, loopHeld: false };
  if (status === "active") { startLoop(); job.loopHeld = true; }
  state.genJobs.push(job);
  renderGenDock();
  return job.id;
}

function genJobActivate(id, patch = {}) {
  const job = state.genJobs.find((j) => j.id === id);
  if (!job) return;
  job.status = "active";
  Object.assign(job, patch);
  if (!job.loopHeld) { startLoop(); job.loopHeld = true; }
  renderGenDock();
}

function genJobUpdate(id, patch = {}) {
  const job = state.genJobs.find((j) => j.id === id);
  if (!job) return;
  Object.assign(job, patch);
  renderGenDock();
}

// Update ONLY a tile's status line in place — no full dock re-render, so the loader
// animations don't restart and the elapsed counter ticks smoothly (immersion intact).
function genJobDetail(id, detail) {
  const job = state.genJobs.find((j) => j.id === id);
  if (!job) return;
  job.detail = detail;
  const node = el.genDock.querySelector(`[data-job-id="${id}"] .gen-tile-status`);
  if (node) node.textContent = detail;
  else renderGenDock();
}

function genJobTerminal(id, lines, done) {
  const job = state.genJobs.find((j) => j.id === id);
  if (!job) return;
  job.kind = "terminal";
  job.terminal = lines.slice(-7);
  job.terminalDone = done;
  renderGenDock();
}

function genJobEnd(id, detail) {
  const job = state.genJobs.find((j) => j.id === id);
  if (!job) return;
  job.status = "done";
  if (detail) job.detail = detail;
  if (job.loopHeld) { stopLoop(); job.loopHeld = false; }
  renderGenDock();
  setTimeout(() => {
    state.genJobs = state.genJobs.filter((j) => j.id !== id);
    renderGenDock();
  }, 1300);
}

function renderGenDock() {
  const jobs = state.genJobs;
  if (!jobs.length) {
    el.genDock.innerHTML = "";
    el.genDock.dataset.count = "0";
    el.mediaDock.classList.add("hidden");
    document.querySelector(".stage")?.classList.remove("generating");
    el.orb.classList.remove("docked");
    return;
  }
  el.mediaDock.classList.remove("hidden");
  document.querySelector(".stage")?.classList.add("generating");
  el.orb.classList.add("docked");
  el.genDock.dataset.count = String(jobs.length);
  el.genDock.innerHTML = "";
  for (const job of jobs) el.genDock.append(buildGenTile(job));
}

function buildGenTile(job) {
  const tile = document.createElement("div");
  tile.className = `gen-tile ${job.kind}-loader ${job.status}`;
  tile.dataset.jobId = job.id;
  const tag = document.createElement("span");
  tag.className = "gen-tile-tag";
  tag.textContent = job.title || labelForKind(job.kind);
  const visual = document.createElement("div");
  visual.className = `generation-visual ${job.kind}-visual`;
  if (job.status === "queued") {
    visual.classList.add("queued-visual");
    visual.innerHTML = `<div class="queued-glyph">${queuedGlyph(job.kind)}</div>`;
  } else if (job.terminal) {
    visual.classList.add("terminal-visual");
    visual.innerHTML = `<div class="terminal-output">${job.terminal.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}${job.terminalDone ? "" : "<span class=\"terminal-cursor\"></span>"}</div>`;
  } else {
    visual.innerHTML = generationVisualMarkup(job.kind);
  }
  const status = document.createElement("p");
  status.className = "gen-tile-status";
  status.textContent = job.detail || (job.status === "queued" ? "Queued…" : `${labelForKind(job.kind)}…`);
  tile.append(tag, visual, status);
  return tile;
}

// A simple glyph hinting what a queued job will produce, shown in its grey box.
function queuedGlyph(kind) {
  const glyphs = {
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M3 17l5-4 4 3 3-2 6 5"/></svg>',
    video: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
    music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
    tts: '<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    terminal: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>',
    widget: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  };
  return glyphs[kind] || glyphs.image;
}

function generationVisualMarkup(kind) {
  if (kind === "music") {
    return `<svg viewBox="0 0 220 160" role="img" aria-label="Music generation loading"><path class="note note-a" d="M92 32v76a22 22 0 1 1-10-18V48l74-16v64a22 22 0 1 1-10-18V48L92 60z"/><path class="wave wave-a" d="M28 104c24-18 48-18 72 0s48 18 72 0"/><path class="wave wave-b" d="M38 124c18-12 36-12 54 0s36 12 54 0"/></svg>`;
  }
  if (kind === "tts") {
    return `<div class="tts-loader"><div class="typing-line"><span>composing voice</span><i></i></div><div class="word-cloud"><span>clarity</span><span>tone</span><span>tempo</span><span>presence</span></div><div class="morph-loader"></div></div>`;
  }
  if (kind === "video") {
    return `<div class="video-frame"><span></span><span></span><span></span><div class="play-glyph"></div></div>`;
  }
  if (kind === "search") {
    return `<div class="search-loader">
      <div class="search-sources">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      <svg class="search-lens" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="26" cy="26" r="15"/>
        <line x1="37" y1="37" x2="55" y2="55"/>
      </svg>
    </div>`;
  }
  return `<div class="diffusion-grid"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>`;
}

// ---------------------------------------------------------------------------
// Morphable SVG visualizer. One persistent rAF loop deforms a blob path and
// state-specific accents (mic bars for the user, radiating rings for the model,
// orbiting dots for thinking) so you can tell at a glance who's "talking".
// ---------------------------------------------------------------------------
const VIZ_STATES = ["idle", "listening", "user", "thinking", "speaking"];
const VIZ_LABELS = { idle: "", listening: "Listening", user: "You", thinking: "Thinking", speaking: "Speaking" };
const viz = { raf: 0, analyser: null, data: null, level: 0, target: 0, phase: 0, spin: 0, state: "idle", burst: 0, burstKind: "" };

// A transient "the agent just did something" reaction: the blob spikes and emits a
// colored ripple, decaying over ~1s. Tinted by tool category for a bit of fun.
function vizBurst(kind) {
  viz.burst = 1;
  viz.burstKind = kind || "tool";
}

function burstColor() {
  const k = viz.burstKind;
  if (/image|video/.test(k)) return "#ff4fd8";
  if (/audio|music|tts|remember|forget|memory|gallery/.test(k)) return "#7bffaf";
  if (/widget|coder|terminal/.test(k)) return "#8e6cff";
  if (/search/.test(k)) return "#4de8ff";
  if (/gibber/.test(k)) return "#ffd36e";
  return "#4de8ff";
}

function setOrb(mode) {
  if (!VIZ_STATES.includes(mode)) mode = "idle";
  el.orb.classList.remove(...VIZ_STATES);
  el.orb.classList.add(mode);
  viz.state = mode;
  if (el.orbLabel) el.orbLabel.textContent = VIZ_LABELS[mode] || "";
  el.orb?.setAttribute("aria-label", `Visualizer — ${mode}`);
}

function makeOrbAnalyser(audioContext) {
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.7;
  return analyser;
}

// startOrbViz/stopOrbViz now just attach/detach the audio source; the loop runs
// continuously (so idle/thinking still morph) and pauses when the tab is hidden.
function startOrbViz(analyser) {
  if (analyser) {
    viz.analyser = analyser;
    viz.data = new Uint8Array(analyser.frequencyBinCount);
  }
  startVizLoop();
}

function stopOrbViz() {
  viz.analyser = null;
  viz.data = null;
}

function startVizLoop() {
  if (viz.raf || !el.orbBlob) return;
  const tick = () => {
    viz.raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    if (viz.analyser && viz.data) {
      viz.analyser.getByteTimeDomainData(viz.data);
      let sum = 0;
      for (let i = 0; i < viz.data.length; i += 1) { const v = (viz.data[i] - 128) / 128; sum += v * v; }
      viz.target = Math.min(1, Math.sqrt(sum / viz.data.length) * 3.4);
    } else {
      // No live audio: synthesize a gentle idle/thinking pulse.
      viz.target = viz.state === "thinking" ? 0.34 : viz.state === "idle" ? 0.12 : viz.target * 0.9;
    }
    viz.level += (viz.target - viz.level) * 0.18;
    viz.phase += 0.016 + viz.level * 0.05;
    viz.spin += 0.012 + (viz.state === "thinking" ? 0.05 : 0);
    if (viz.burst > 0.001) viz.burst *= 0.94; else viz.burst = 0;
    renderVizFrame();
  };
  tick();
}

function renderVizFrame() {
  const level = viz.level;
  const burst = viz.burst;
  el.orb.style.setProperty("--level", level.toFixed(3));
  el.orb.style.setProperty("--burst", burst.toFixed(3));
  // Morphing blob — lobe amplitude + base radius vary per state, audio level, and a
  // transient burst (extra spike + high-frequency ripple) when a tool fires.
  const lobes = viz.state === "thinking" ? 5 : viz.state === "speaking" ? 8 : 6;
  const amp = (viz.state === "speaking" ? 13 : viz.state === "user" || viz.state === "listening" ? 9 : viz.state === "thinking" ? 7 : 4) * (0.35 + level);
  const base = 44 + level * 9 + burst * 7;
  const pts = [];
  for (let i = 0; i < lobes; i += 1) {
    const a = (i / lobes) * Math.PI * 2;
    const r = base + Math.sin(a * 3 + viz.phase * 2) * amp * 0.5 + Math.sin(a * 2 - viz.phase) * amp * 0.5 + Math.sin(a * 6 + viz.phase * 4) * burst * 11;
    pts.push([100 + Math.cos(a) * r, 100 + Math.sin(a) * r]);
  }
  el.orbBlob.setAttribute("d", smoothClosedPath(pts));

  // Mic equalizer bars (user/listening): radial ticks whose length tracks level.
  if (el.orbBars) {
    const showBars = viz.state === "user" || viz.state === "listening";
    el.orbBars.style.opacity = showBars ? "1" : "0";
    if (showBars) {
      const count = 28;
      let d = "";
      for (let i = 0; i < count; i += 1) {
        const a = (i / count) * Math.PI * 2;
        const len = 6 + (0.5 + 0.5 * Math.sin(viz.phase * 3 + i)) * (8 + level * 26);
        const r0 = 70;
        d += `M ${(100 + Math.cos(a) * r0).toFixed(1)} ${(100 + Math.sin(a) * r0).toFixed(1)} L ${(100 + Math.cos(a) * (r0 + len)).toFixed(1)} ${(100 + Math.sin(a) * (r0 + len)).toFixed(1)} `;
      }
      el.orbBars.innerHTML = `<path d="${d}" />`;
    }
  }

  // Radiating rings (speaking only) — the tool "poof" lives in its own layer.
  if (el.orbRings) {
    const showRings = viz.state === "speaking";
    el.orbRings.style.opacity = showRings ? "1" : "0";
    if (showRings) {
      let rings = "";
      for (let i = 0; i < 3; i += 1) {
        const t = ((viz.phase * 0.5 + i / 3) % 1);
        const r = 50 + t * (40 + level * 30);
        rings += `<circle cx="100" cy="100" r="${r.toFixed(1)}" opacity="${(1 - t).toFixed(2)}" />`;
      }
      el.orbRings.innerHTML = rings;
    }
  }

  // Tool-call "poof": a dedicated outer burst — twin expanding rings + particles
  // radiating outward — drawn on top and INDEPENDENT of the orb's idle/thinking/
  // speaking state, so you always see when the agent fires a tool.
  if (el.orbPoof) {
    const poofActive = burst > 0.015;
    el.orbPoof.style.opacity = poofActive ? "1" : "0";
    if (poofActive) {
      const color = burstColor();
      const grow = 1 - burst; // 0 at trigger → 1 as it fades: expands outward
      let svg = "";
      for (let i = 0; i < 2; i += 1) {
        const r = 56 + grow * (46 + i * 16);
        const w = (3.4 - i * 1.2) * burst;
        svg += `<circle cx="100" cy="100" r="${r.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${w.toFixed(2)}" opacity="${(burst * (1 - i * 0.3)).toFixed(2)}" />`;
      }
      const particles = 9;
      const pr = 58 + grow * 40;
      for (let i = 0; i < particles; i += 1) {
        const a = (i / particles) * Math.PI * 2 + viz.spin * 0.4;
        const dotR = (1.2 + burst * 2.6).toFixed(2);
        svg += `<circle cx="${(100 + Math.cos(a) * pr).toFixed(1)}" cy="${(100 + Math.sin(a) * pr).toFixed(1)}" r="${dotR}" fill="${color}" opacity="${burst.toFixed(2)}" />`;
      }
      el.orbPoof.innerHTML = svg;
    }
  }

  // Orbiting dots (thinking).
  if (el.orbDots) {
    const showDots = viz.state === "thinking";
    el.orbDots.style.opacity = showDots ? "1" : "0";
    if (showDots) {
      let dots = "";
      for (let i = 0; i < 3; i += 1) {
        const a = viz.spin + (i / 3) * Math.PI * 2;
        dots += `<circle cx="${(100 + Math.cos(a) * 66).toFixed(1)}" cy="${(100 + Math.sin(a) * 66).toFixed(1)}" r="5" />`;
      }
      el.orbDots.innerHTML = dots;
    }
  }
}

// Catmull-Rom → cubic bezier for a smooth closed blob.
function smoothClosedPath(p) {
  const n = p.length;
  let d = `M ${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)} `;
  for (let i = 0; i < n; i += 1) {
    const p0 = p[(i - 1 + n) % n];
    const p1 = p[i];
    const p2 = p[(i + 1) % n];
    const p3 = p[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)} `;
  }
  return `${d}Z`;
}

function loadSettings() {
  fields.forEach((id) => {
    const saved = state.settings[id];
    if (!saved) return;
    const field = document.querySelector(`#${id}`);
    // Skip stale saved values that are no longer valid options (e.g. a realtime
    // voice that was removed); otherwise the select would silently go blank.
    if (field.tagName === "SELECT" && !Array.from(field.options).some((option) => option.value === saved)) return;
    field.value = saved;
  });
}

function saveSettings() {
  state.settings = Object.fromEntries(fields.map((id) => [id, value(id)]));
  localStorage.setItem("settings", JSON.stringify(state.settings));
}

function value(id) {
  const node = document.querySelector(`#${id}`);
  return node ? String(node.value || "").trim() : "";
}

function addMcpServer(event) {
  event.preventDefault();
  const name = el.mcpName.value.trim();
  const url = el.mcpUrl.value.trim();
  if (!name || !url) return;
  state.mcps.push({ name, url });
  localStorage.setItem("mcp_servers", JSON.stringify(state.mcps));
  el.mcpName.value = "";
  el.mcpUrl.value = "";
  renderMcpServers();
}

function renderMcpServers() {
  el.mcpList.innerHTML = "";
  state.mcps.forEach((server, index) => {
    const row = document.createElement("div");
    row.className = "mcp-entry";
    row.textContent = `${server.name}: ${server.url}`;
    row.addEventListener("dblclick", () => {
      state.mcps.splice(index, 1);
      localStorage.setItem("mcp_servers", JSON.stringify(state.mcps));
      renderMcpServers();
    });
    el.mcpList.append(row);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("voiceenable-gallery", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" });
      if (!db.objectStoreNames.contains("widgets")) db.createObjectStore("widgets", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- Saved widgets store (durable mini-apps that keep their own data) ----
async function saveWidgetRecord(record) {
  const db = await openDb();
  await txDone(db.transaction("widgets", "readwrite").objectStore("widgets").put(record));
}

async function getWidgetRecords() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("widgets").objectStore("widgets").getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    request.onerror = () => reject(request.error);
  });
}

async function getWidgetRecord(id) {
  const records = await getWidgetRecords().catch(() => []);
  return records.find((record) => record.id === id);
}

async function deleteWidgetRecord(id) {
  const db = await openDb();
  await txDone(db.transaction("widgets", "readwrite").objectStore("widgets").delete(id));
}

async function saveWidgetData(id, data) {
  const record = await getWidgetRecord(id);
  if (!record) return;
  record.data = data;
  record.updatedAt = Date.now();
  await saveWidgetRecord(record);
}

async function updateSavedWidget(id, patch) {
  const record = await getWidgetRecord(id);
  if (!record) return;
  Object.assign(record, patch, { updatedAt: Date.now() });
  await saveWidgetRecord(record);
}

async function renderSavedWidgets() {
  if (!el.widgetList) return;
  const records = await getWidgetRecords().catch(() => []);
  el.widgetList.innerHTML = "";
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "memory-empty";
    empty.textContent = "No saved widgets yet. Build one on the canvas and press Save, or ask the agent to make you a tool.";
    el.widgetList.append(empty);
    return;
  }
  for (const record of records) el.widgetList.append(renderSavedWidgetRow(record));
}

function renderSavedWidgetRow(record) {
  const row = document.createElement("div");
  row.className = "widget-row";
  const info = document.createElement("div");
  info.className = "widget-row-info";
  const title = document.createElement("strong");
  title.textContent = record.title || "Widget";
  const meta = document.createElement("span");
  const bits = [record.assets?.length ? `${record.assets.length} asset(s)` : "", shortPrompt(record.spec || "")].filter(Boolean);
  meta.textContent = bits.join(" · ") || "Saved widget";
  info.append(title, meta);
  const actions = document.createElement("div");
  actions.className = "widget-row-actions";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "button ghost small";
  open.textContent = "Open";
  open.addEventListener("click", () => openSavedWidget(record));
  const download = document.createElement("button");
  download.type = "button";
  download.className = "button ghost small";
  download.textContent = "Download";
  download.addEventListener("click", () => downloadWidgetBundle({ id: record.id, title: record.title, content: record.html, data: record.data, assets: record.assets }));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "memory-remove";
  remove.textContent = "✕";
  remove.title = "Delete saved widget";
  remove.addEventListener("click", async () => { await deleteWidgetRecord(record.id); renderSavedWidgets(); });
  actions.append(open, download, remove);
  row.append(info, actions);
  return row;
}

function openSavedWidget(record) {
  const result = showWorkspace({ layout: "widget", title: record.title, summary: record.spec || "", content: record.html, spec: record.spec || "", data: record.data ?? null, assets: record.assets || [] });
  const live = state.workspace.find((artifact) => artifact.id === result.workspaceId);
  if (live) { live.savedWidgetId = record.id; live.savedAt = record.createdAt; saveWorkspace(); }
  closeDrawers();
}

async function clearSavedWidgets() {
  const records = await getWidgetRecords().catch(() => []);
  for (const record of records) await deleteWidgetRecord(record.id);
  renderSavedWidgets();
}

async function saveGalleryItem({ kind, prompt, model, blob, remoteUrl, language, filename }) {
  const db = await openDb();
  const item = { id: crypto.randomUUID(), kind, prompt, model, blob, createdAt: Date.now() };
  if (remoteUrl) item.remoteUrl = remoteUrl;
  if (language) item.language = language;
  if (filename) item.filename = filename;
  await putGalleryItem(item, db);
  // Desktop: also persist the blob as a real file so it survives outside the cache
  // and code can reference it by path. Best-effort — IndexedDB remains the index.
  if (nativeAvailable() && flag("saveToDisk")) {
    try { item.localPath = await mirrorItemToDisk(item); await putGalleryItem(item, db); }
    catch (error) { console.warn("disk mirror failed", error); }
  }
  await renderGallery();
  playSound("genComplete");
  return item;
}

// ---------------------------------------------------------------------------
// Native tool handlers (desktop only). Each guards on nativeAvailable() and
// returns the same {ok|error} shape the rest of runTool uses, so both realtime
// and chat modes pick them up. The Rust side confines all paths to the workspace.
// ---------------------------------------------------------------------------
async function mirrorItemToDisk(item) {
  const bytes = Array.from(new Uint8Array(await item.blob.arrayBuffer()));
  const ext = item.filename ? item.filename.split(".").pop() : extensionFor(item.kind, item.blob.type);
  const base = item.filename || `${item.kind}-${item.id}.${ext}`;
  return nativeInvoke("save_binary", { path: `media/${base}`, bytes });
}

async function nativeWriteFile(args) {
  if (!nativeAvailable()) return { error: "Filesystem tools require the desktop app." };
  const path = String(args.path || "").trim();
  if (!path) return { error: "No file path given." };
  try {
    const saved = await nativeInvoke("write_text_file", { path, contents: String(args.content ?? args.contents ?? "") });
    return { ok: true, path: saved };
  } catch (error) { return { error: `write_file failed: ${(error && error.message) || error}` }; }
}

async function nativeReadFile(args) {
  if (!nativeAvailable()) return { error: "Filesystem tools require the desktop app." };
  try {
    const content = await nativeInvoke("read_text_file", { path: String(args.path || "") });
    return { ok: true, path: args.path, content: String(content).slice(0, 60000) };
  } catch (error) { return { error: `read_file failed: ${(error && error.message) || error}` }; }
}

async function nativeListDir(args) {
  if (!nativeAvailable()) return { error: "Filesystem tools require the desktop app." };
  try {
    const entries = await nativeInvoke("list_dir", { path: String(args.path || "") });
    return { ok: true, path: args.path || ".", entries };
  } catch (error) { return { error: `list_dir failed: ${(error && error.message) || error}` }; }
}

async function nativeRunCommand(args) {
  if (!nativeAvailable()) return { error: "Shell commands require the desktop app." };
  if (!flag("allowShell")) return { error: "Shell commands are disabled. Turn on 'Let the agent run commands' in Config to allow them." };
  const command = String(args.command || "").trim();
  if (!command) return { error: "No command given." };
  // Explicit human approval for every command — the agent never runs shell silently.
  const approved = typeof window !== "undefined" && window.confirm
    ? window.confirm(`The agent wants to run this command:\n\n${command}\n\nAllow it?`)
    : false;
  if (!approved) return { error: "User declined to run the command." };
  try {
    const r = await nativeInvoke("run_command", { command });
    return { ok: (r.code ?? 0) === 0, code: r.code, stdout: String(r.stdout || "").slice(0, 6000), stderr: String(r.stderr || "").slice(0, 4000) };
  } catch (error) { return { error: `run_command failed: ${(error && error.message) || error}` }; }
}

async function nativeOpenPath(args) {
  if (!nativeAvailable()) return { error: "This requires the desktop app." };
  try { const opened = await nativeInvoke("open_path", { path: String(args.path || "") }); return { ok: true, opened }; }
  catch (error) { return { error: `open_path failed: ${(error && error.message) || error}` }; }
}

async function nativeSaveMediaToDisk(args) {
  if (!nativeAvailable()) return { error: "This requires the desktop app." };
  const items = await getGalleryItems().catch(() => []);
  const item = items.find((entry) => entry.id === args.id);
  if (!item || !item.blob) return { error: "No gallery item with that id (call list_gallery for ids)." };
  try {
    const bytes = Array.from(new Uint8Array(await item.blob.arrayBuffer()));
    const ext = item.filename ? item.filename.split(".").pop() : extensionFor(item.kind, item.blob.type);
    const dest = String(args.path || `media/${item.kind}-${item.id}.${ext}`);
    const saved = await nativeInvoke("save_binary", { path: dest, bytes });
    return { ok: true, path: saved };
  } catch (error) { return { error: `save_media_to_disk failed: ${(error && error.message) || error}` }; }
}

async function putGalleryItem(item, db) {
  const database = db || await openDb();
  await txDone(database.transaction("items", "readwrite").objectStore("items").put(item));
}

async function getGalleryItems() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("items").objectStore("items").getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
}

async function renderGallery() {
  const items = await getGalleryItems().catch(() => []);
  state.galleryItems = items;
  el.gallery.innerHTML = "";
  for (let index = 0; index < items.length; index += 1) el.gallery.append(await renderGalleryCard(items[index], index));
}

async function renderGalleryCard(item, index) {
  const url = URL.createObjectURL(item.blob);
  const card = document.createElement("article");
  card.className = `gallery-item ${item.kind}`;

  // --- Media thumbnail ---
  const media = document.createElement("div");
  media.className = "g-media";
  if (item.kind === "image") {
    const img = document.createElement("img");
    img.src = url;
    img.loading = "lazy";
    img.alt = shortPrompt(item.prompt);
    img.className = "g-openable";
    img.addEventListener("click", () => openLightbox(index));
    media.append(img);
  } else if (item.kind === "video") {
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.className = "g-openable";
    video.addEventListener("click", () => openLightbox(index));
    const play = document.createElement("span");
    play.className = "g-play";
    play.textContent = "▶";
    media.append(video, play);
  } else if (item.kind === "audio") {
    media.classList.add("g-audio");
    const glyph = document.createElement("span");
    glyph.className = "g-glyph";
    glyph.textContent = "♪";
    const audio = document.createElement("audio");
    audio.src = url;
    audio.controls = true;
    media.append(glyph, audio);
  } else {
    media.classList.add("g-code");
    media.title = "Open in canvas";
    const glyph = document.createElement("span");
    glyph.className = "g-glyph";
    glyph.textContent = item.kind === "project" ? "</>" : (item.language || "code");
    media.append(glyph);
    media.addEventListener("click", () => addGalleryReference(item));
  }
  card.append(media);

  // --- Info ---
  const info = document.createElement("div");
  info.className = "g-info";
  const meta = document.createElement("div");
  meta.className = "g-meta";
  const kind = document.createElement("span");
  kind.className = "g-kind";
  kind.textContent = item.kind === "code" ? (item.filename || item.language || "code") : item.kind;
  const model = document.createElement("span");
  model.className = "g-model";
  model.textContent = item.model || "";
  meta.append(kind, model);
  const prompt = document.createElement("p");
  prompt.className = "g-prompt";
  prompt.textContent = item.prompt || "";
  prompt.title = item.prompt || "";
  info.append(meta, prompt);
  card.append(info);

  // --- Uniform icon actions (never overflow) ---
  const actions = document.createElement("div");
  actions.className = "g-act";
  const dl = document.createElement("a");
  dl.className = "g-btn";
  dl.href = url;
  dl.download = downloadNameFor(item);
  dl.title = "Download";
  dl.setAttribute("aria-label", "Download");
  dl.textContent = "↓";
  const use = document.createElement("button");
  use.type = "button";
  use.className = "g-btn";
  use.textContent = item.kind === "image" ? "↗" : "⤢";
  use.title = item.kind === "image" ? "Use as source" : "Show in canvas";
  use.setAttribute("aria-label", use.title);
  use.addEventListener("click", () => addGalleryReference(item));
  const del = document.createElement("button");
  del.type = "button";
  del.className = "g-btn g-del";
  del.textContent = "✕";
  del.title = "Delete";
  del.setAttribute("aria-label", "Delete from gallery");
  del.addEventListener("click", async () => { await deleteGalleryItemById(item.id); await renderGallery(); });
  actions.append(dl, use, del);
  card.append(actions);
  return card;
}

// Projects are model-generated HTML, so they are untrusted. Show the source as
// plain text by default and only execute on demand inside a sandboxed srcdoc
// frame (no allow-same-origin => opaque origin: no access to this page, its
// storage, the BYOP key, or cookies).
// Non-HTML code file: read-only source view with copy (no run tab).
async function renderCodeFileViewer(item) {
  const code = await item.blob.text().catch(() => "");
  const wrap = document.createElement("div");
  wrap.className = "project-viewer";
  const tabs = document.createElement("div");
  tabs.className = "viewer-tabs";
  const tag = document.createElement("span");
  tag.className = "viewer-tab active";
  tag.style.cursor = "default";
  tag.textContent = item.filename || `${item.language || "code"} file`;
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "viewer-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied"; setTimeout(() => (copyBtn.textContent = "Copy"), 1200); }
    catch { copyBtn.textContent = "Copy failed"; }
  });
  tabs.append(tag, copyBtn);
  const stage = document.createElement("div");
  stage.className = "viewer-stage";
  const pre = document.createElement("pre");
  pre.className = "code-view";
  const codeEl = document.createElement("code");
  codeEl.textContent = code;
  pre.append(codeEl);
  stage.append(pre);
  wrap.append(tabs, stage);
  return wrap;
}

function downloadNameFor(item) {
  if (item.kind === "code") return item.filename || `snippet-${item.id}.${(item.language && LANGUAGE_EXT[item.language]) || "txt"}`;
  return `${item.kind}-${item.id}.${extensionFor(item.kind, item.blob.type)}`;
}

async function renderProjectViewer(item) {
  const code = await item.blob.text().catch(() => "");
  const wrap = document.createElement("div");
  wrap.className = "project-viewer";

  const tabs = document.createElement("div");
  tabs.className = "viewer-tabs";
  const codeTab = document.createElement("button");
  codeTab.type = "button";
  codeTab.className = "viewer-tab active";
  codeTab.textContent = "HTML source";
  const runTab = document.createElement("button");
  runTab.type = "button";
  runTab.className = "viewer-tab";
  runTab.textContent = "Run preview";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "viewer-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied"; setTimeout(() => (copyBtn.textContent = "Copy"), 1200); }
    catch { copyBtn.textContent = "Copy failed"; }
  });
  tabs.append(codeTab, runTab, copyBtn);

  const stage = document.createElement("div");
  stage.className = "viewer-stage";
  const codeView = document.createElement("pre");
  codeView.className = "code-view";
  const codeEl = document.createElement("code");
  codeEl.textContent = code; // textContent: HTML is shown literally, never parsed.
  codeView.append(codeEl);
  stage.append(codeView);

  let frame = null;
  codeTab.addEventListener("click", () => {
    codeTab.classList.add("active"); runTab.classList.remove("active");
    stage.replaceChildren(codeView);
  });
  runTab.addEventListener("click", () => {
    runTab.classList.add("active"); codeTab.classList.remove("active");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "project-frame";
      frame.setAttribute("sandbox", "allow-scripts allow-modals allow-pointer-lock");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.srcdoc = code;
    }
    stage.replaceChildren(frame);
  });

  wrap.append(tabs, stage);
  return wrap;
}

async function addGalleryReference(item) {
  if (item.kind === "project") {
    // Run the saved HTML live on the canvas (sandboxed widget), not just source.
    const code = await item.blob.text().catch(() => "");
    showWorkspace({ layout: "widget", title: "Project", summary: shortPrompt(item.prompt), content: code, spec: item.prompt || "" });
    closeDrawers();
    return;
  }
  if (item.kind === "code") {
    const code = await item.blob.text().catch(() => "");
    showWorkspace({ layout: "code", title: item.filename || "Code file", summary: shortPrompt(item.prompt), language: item.language || "text", content: code });
    closeDrawers();
    return;
  }
  showWorkspace({
    layout: item.kind === "image" ? "image_request" : "note",
    title: item.kind === "image" ? "Gallery source ready" : "Gallery item",
    summary: item.kind === "image" ? "Use this saved image as a source for an edit or reference generation." : `${item.kind} generated with ${item.model}.`,
    prompt: item.prompt,
    purpose: "image_edit",
    minImages: 1,
    maxImages: 4,
    data: item.kind === "image" ? [{ url: URL.createObjectURL(item.blob), galleryId: item.id }] : [{ kind: item.kind, model: item.model, prompt: shortPrompt(item.prompt) }],
  });
}

function shortPrompt(prompt) {
  if (!prompt) return "Prompt";
  return prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt;
}

async function clearGallery() {
  const db = await openDb();
  await txDone(db.transaction("items", "readwrite").objectStore("items").clear());
  renderGallery();
}

// ---- Gallery lightbox: a full overlay showing one item at size, with prev/next
// navigation and the same actions (download, use-as-source, delete). ----
function createGalleryLightbox() {
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.innerHTML = `
    <div class="lightbox-backdrop"></div>
    <div class="lightbox-panel" role="dialog" aria-modal="true">
      <button class="lightbox-close" type="button" aria-label="Close">✕</button>
      <button class="lightbox-nav prev" type="button" aria-label="Previous">‹</button>
      <div class="lightbox-stage"></div>
      <button class="lightbox-nav next" type="button" aria-label="Next">›</button>
      <div class="lightbox-meta">
        <p class="lightbox-caption"></p>
        <p class="lightbox-prompt"></p>
        <div class="lightbox-actions"></div>
      </div>
    </div>`;
  document.body.append(overlay);
  el.lightbox = {
    overlay,
    stage: overlay.querySelector(".lightbox-stage"),
    caption: overlay.querySelector(".lightbox-caption"),
    prompt: overlay.querySelector(".lightbox-prompt"),
    actions: overlay.querySelector(".lightbox-actions"),
  };
  overlay.querySelector(".lightbox-backdrop").addEventListener("click", closeLightbox);
  overlay.querySelector(".lightbox-close").addEventListener("click", closeLightbox);
  overlay.querySelector(".prev").addEventListener("click", () => stepLightbox(-1));
  overlay.querySelector(".next").addEventListener("click", () => stepLightbox(1));
  document.addEventListener("keydown", (event) => {
    if (!overlay.classList.contains("active")) return;
    if (event.key === "Escape") closeLightbox();
    else if (event.key === "ArrowLeft") stepLightbox(-1);
    else if (event.key === "ArrowRight") stepLightbox(1);
  });
}

function openLightbox(index) {
  if (!el.lightbox) createGalleryLightbox();
  state.lightboxIndex = index;
  el.lightbox.overlay.classList.add("active");
  renderLightbox();
}

function closeLightbox() {
  el.lightbox?.overlay.classList.remove("active");
  if (el.lightbox) el.lightbox.stage.innerHTML = "";
}

function stepLightbox(direction) {
  const items = state.galleryItems || [];
  if (!items.length) return;
  state.lightboxIndex = (state.lightboxIndex + direction + items.length) % items.length;
  renderLightbox();
}

function renderLightbox() {
  const items = state.galleryItems || [];
  const item = items[state.lightboxIndex];
  if (!item) return closeLightbox();
  const lb = el.lightbox;
  const url = URL.createObjectURL(item.blob);
  lb.stage.innerHTML = "";
  let media;
  if (item.kind === "image") { media = document.createElement("img"); media.src = url; media.alt = shortPrompt(item.prompt); }
  else if (item.kind === "video") { media = document.createElement("video"); media.src = url; media.controls = true; media.autoplay = true; }
  else if (item.kind === "audio") { media = document.createElement("audio"); media.src = url; media.controls = true; }
  else { media = document.createElement("div"); media.className = "lightbox-text"; media.textContent = "Open this project from the gallery card to run it."; }
  lb.stage.append(media);
  lb.caption.textContent = `${item.kind} · ${item.model} · ${state.lightboxIndex + 1}/${items.length}`;
  lb.prompt.textContent = item.prompt || "";

  lb.actions.innerHTML = "";
  const download = document.createElement("a");
  download.className = "button ghost small";
  download.href = url;
  download.download = `${item.kind}-${item.id}.${extensionFor(item.kind, item.blob.type)}`;
  download.textContent = "Download";
  lb.actions.append(download);
  if (item.kind === "image") {
    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "button ghost small";
    useBtn.textContent = "Use as source";
    useBtn.addEventListener("click", () => { addGalleryReference(item); closeLightbox(); });
    lb.actions.append(useBtn);
  }
  const del = document.createElement("button");
  del.type = "button";
  del.className = "button ghost small danger-btn";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    await deleteGalleryItemById(item.id);
    await renderGallery();
    if (!(state.galleryItems || []).length) closeLightbox();
    else { state.lightboxIndex = Math.min(state.lightboxIndex, state.galleryItems.length - 1); renderLightbox(); }
  });
  lb.actions.append(del);
}

// ---- Persistent conversation memory (durable facts across sessions) ----
function saveMemory() {
  state.memory = state.memory.slice(-40);
  localStorage.setItem("agent_memory", JSON.stringify(state.memory));
}

function rememberFact(args) {
  const text = String(args.text || args.fact || "").trim();
  if (!text) return { error: "No fact provided to remember." };
  if (state.memory.some((entry) => entry.text.toLowerCase() === text.toLowerCase())) {
    return { ok: true, note: "Already remembered." };
  }
  const entry = { id: crypto.randomUUID(), text, at: Date.now() };
  state.memory.push(entry);
  saveMemory();
  renderMemory();
  addMessage("system", `Remembered: ${text}`);
  return { ok: true, id: entry.id };
}

function forgetMemory(args) {
  if (args.all) {
    const count = state.memory.length;
    state.memory = [];
    saveMemory();
    renderMemory();
    addMessage("system", "Cleared all long-term memory.");
    return { ok: true, cleared: count };
  }
  const before = state.memory.length;
  if (args.id) state.memory = state.memory.filter((entry) => entry.id !== args.id);
  else if (args.text) state.memory = state.memory.filter((entry) => !entry.text.toLowerCase().includes(String(args.text).toLowerCase()));
  else return { error: "Provide an id, text, or all:true to forget." };
  saveMemory();
  renderMemory();
  return { ok: true, removed: before - state.memory.length };
}

function renderMemory() {
  if (!el.memoryList) return;
  el.memoryList.innerHTML = "";
  if (!state.memory.length) {
    const empty = document.createElement("p");
    empty.className = "memory-empty";
    empty.textContent = "No saved memories yet. The agent stores durable facts here.";
    el.memoryList.append(empty);
    return;
  }
  state.memory.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "memory-entry";
    const text = document.createElement("span");
    text.textContent = entry.text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "memory-remove";
    remove.textContent = "✕";
    remove.title = "Forget this";
    remove.addEventListener("click", () => forgetMemory({ id: entry.id }));
    row.append(text, remove);
    el.memoryList.append(row);
  });
}

async function deleteGalleryItemById(id) {
  const db = await openDb();
  await txDone(db.transaction("items", "readwrite").objectStore("items").delete(id));
}

// Agent-facing gallery management: delete by ids, clear all, or retag a caption.
async function manageGallery(args, toolId) {
  const action = String(args.action || "").toLowerCase();
  const items = await getGalleryItems().catch(() => []);
  if (action === "delete") {
    const ids = (Array.isArray(args.ids) ? args.ids : [args.id]).filter(Boolean);
    if (!ids.length) return { error: "No gallery ids were provided to delete." };
    const present = ids.filter((id) => items.some((item) => item.id === id));
    for (const id of present) await deleteGalleryItemById(id);
    await renderGallery();
    updateToolEvent(toolId, "running", `Deleted ${present.length} gallery item(s).`);
    return { ok: true, deleted: present.length };
  }
  if (action === "clear") {
    await clearGallery();
    return { ok: true, cleared: items.length };
  }
  if (action === "retag") {
    const item = items.find((entry) => entry.id === args.id);
    if (!item) return { error: "No matching gallery item to retag." };
    item.prompt = String(args.prompt ?? item.prompt);
    await putGalleryItem(item);
    await renderGallery();
    return { ok: true, id: item.id };
  }
  return { error: `Unknown gallery action "${action}". Use list, delete, clear, or retag.` };
}

function txDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function extensionFor(kind, mime) {
  if (kind === "project" || mime.includes("html")) return "html";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (kind === "video") return "mp4";
  if (kind === "audio") return "mp3";
  return "jpg";
}

// ---------------------------------------------------------------------------
// Gibberlink: agent-to-agent data over sound via ggwave (data-over-sound modem).
// When two instances hear each other's handshake they exchange JSON frames as
// audio tones instead of speech. Inspired by github.com/PennyroyalTea/gibberlink.
// ---------------------------------------------------------------------------
const GIBBER = {
  CDN: "https://unpkg.com/ggwave/ggwave.js",
  AGENT_ID: "VOICEENABLE",
  VERSION: 1,
  PROTO_COMPAT: "GGWAVE_PROTOCOL_AUDIBLE_FAST",   // interoperable default
  PROTO_TURBO: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST", // noisy/fast, used peer-to-peer
};

let ggwavePromise = null;
function loadGgwave() {
  if (window.ggwave_factory) return Promise.resolve(window.ggwave_factory);
  if (ggwavePromise) return ggwavePromise;
  ggwavePromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIBBER.CDN;
    script.async = true;
    script.onload = () => window.ggwave_factory ? resolve(window.ggwave_factory) : reject(new Error("ggwave loaded but factory missing."));
    script.onerror = () => { ggwavePromise = null; reject(new Error("Could not load the ggwave sound library (offline or blocked).")); };
    document.head.append(script);
  });
  return ggwavePromise;
}

// ggwave passes raw float bytes reinterpreted as another typed array, not a value cast.
function reinterpret(src, Type) {
  const buffer = new ArrayBuffer(src.byteLength);
  new src.constructor(buffer).set(src);
  return new Type(buffer);
}

async function startGibberlink() {
  if (!requireKey()) throw new Error("Connect BYOP first.");
  if (state.gibber) return;
  setRealtimeStatus("Loading gibberlink sound modem...", "live");
  const factory = await loadGgwave();
  // Emscripten resolves ggwave.wasm relative to the page by default, which 404s
  // when ggwave.js is served from a CDN. Point locateFile back at the CDN.
  const base = GIBBER.CDN.replace(/[^/]*$/, "");
  const ggwave = await factory({ locateFile: (file) => base + file });
  const audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume().catch(() => {});
  const params = ggwave.getDefaultParameters();
  params.sampleRateInp = audioContext.sampleRate;
  params.sampleRateOut = audioContext.sampleRate;
  const instance = ggwave.init(params);

  // Echo cancellation/noise suppression would eat the data tones, so disable them.
  // exclusive mic ownership: nothing else should be holding a stream once we lock.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  claimMic();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  const analyser = makeOrbAnalyser(audioContext);
  source.connect(analyser);

  state.gibber = { ggwave, instance, audioContext, stream, source, processor, sink, analyser, peer: null, turbo: false, transmitting: false, thinking: false, helloTimer: null, helloTries: 0 };

  processor.onaudioprocess = (event) => {
    const g = state.gibber;
    if (!g || g.transmitting) return; // ignore our own outgoing tones
    const input = new Float32Array(event.inputBuffer.getChannelData(0));
    let decoded;
    try { decoded = g.ggwave.decode(g.instance, reinterpret(input, Int8Array)); } catch { return; }
    if (decoded && decoded.length > 0) {
      const text = new TextDecoder("utf-8").decode(decoded);
      if (text) onGibberFrame(text);
    }
  };
  source.connect(processor);
  processor.connect(sink);
  sink.connect(audioContext.destination);

  setOrb("listening");
  el.mainAction.textContent = "Stop gibberlink";
  updateGibberStatus("Listening. Sending one handshake ping — waiting for a peer agent.");
  addMessage("system", "Gibberlink active: sent a single handshake ping over sound. Bring another VoiceEnable agent within mic range — once it answers, the link works on its own.");
  playSound("convoStart");
  startOrbViz(analyser);
  scheduleGibberHandshake();
}

// Broadcast a SINGLE handshake ping. The peer answers with an ack (and sends its
// own single hello), so one ping per side is all that's needed — no continuous
// beacon spamming the channel. Once a peer is heard the link just works.
async function scheduleGibberHandshake() {
  const g = state.gibber;
  if (!g) return;
  await gibberSend({ t: "hello", id: GIBBER.AGENT_ID, v: GIBBER.VERSION, model: value("textModel") }, { turbo: false });
  if (state.gibber && !state.gibber.peer) updateGibberStatus("Ping sent — waiting for a peer agent.");
}

async function gibberSend(frame, options = {}) {
  const g = state.gibber;
  if (!g) return;
  const useTurbo = options.turbo ?? g.turbo;
  const protocolName = useTurbo ? GIBBER.PROTO_TURBO : GIBBER.PROTO_COMPAT;
  // ProtocolId is an enum object; fall back to known numeric ids if a name is absent.
  const protocol = g.ggwave.ProtocolId?.[protocolName] ?? (useTurbo ? 2 : 1);
  const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
  const waveform = g.ggwave.encode(g.instance, payload, protocol, 10);
  const samples = reinterpret(waveform, Float32Array);
  const buffer = g.audioContext.createBuffer(1, samples.length, g.audioContext.sampleRate);
  buffer.getChannelData(0).set(samples);
  const node = g.audioContext.createBufferSource();
  node.buffer = buffer;
  node.connect(g.audioContext.destination);
  if (g.analyser) node.connect(g.analyser); // outgoing tones drive the orb
  g.transmitting = true;
  setOrb("speaking");
  node.start();
  await new Promise((resolve) => { node.onended = resolve; });
  // Brief cooldown so the mic tail of our own transmission is not decoded back.
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (state.gibber) { state.gibber.transmitting = false; setOrb("listening"); }
}

async function onGibberFrame(raw) {
  const g = state.gibber;
  if (!g) return;
  let frame;
  try { frame = JSON.parse(raw); } catch { frame = { t: "msg", text: raw }; }

  if (frame.t === "hello") {
    const sameAgent = frame.id === GIBBER.AGENT_ID;
    g.peer = { id: frame.id || "unknown", model: frame.model || "" };
    clearTimeout(g.helloTimer);
    playSound("connect");
    addMessage("system", `Gibberlink: recognized peer "${g.peer.id}"${sameAgent ? " (same agent type)" : ""}.`);
    // Reply so the peer also learns about us, and negotiate the faster protocol
    // when we are the same agent type on both ends.
    await gibberSend({ t: "ack", id: GIBBER.AGENT_ID, v: GIBBER.VERSION, model: value("textModel"), turbo: sameAgent }, { turbo: false });
    if (sameAgent) g.turbo = true;
    updateGibberStatus();
    return;
  }
  if (frame.t === "ack") {
    const firstLink = !g.peer;
    g.peer = g.peer || { id: frame.id || "unknown", model: frame.model || "" };
    clearTimeout(g.helloTimer);
    if (frame.turbo) g.turbo = true;
    if (firstLink) playSound("connect");
    updateGibberStatus("Peer linked. Channel ready.");
    return;
  }
  if (frame.t === "msg" && frame.text) {
    addMessage("user", frame.text);
    playSound("messageReceive");
    if (g.thinking) return;
    g.thinking = true;
    updateGibberStatus("Peer message received. Composing reply...");
    try {
      const reply = await gibberRespond(frame.text);
      if (reply && state.gibber) {
        addMessage("agent", reply);
        await gibberSend({ t: "msg", id: GIBBER.AGENT_ID, text: reply });
      }
    } finally {
      if (state.gibber) state.gibber.thinking = false;
      updateGibberStatus();
    }
  }
}

async function gibberRespond(text) {
  const history = state.messages
    .filter((m) => m.role === "user" || m.role === "agent")
    .slice(-8)
    .map((m) => ({ role: m.role === "agent" ? "assistant" : "user", content: m.content }));
  const result = await busy(() => postJson("/v1/chat/completions", {
    model: value("textModel"),
    messages: [{ role: "system", content: gibberSystemPrompt() }, ...history],
  }));
  if (result?.error) return "";
  return result?.choices?.[0]?.message?.content?.trim() || "";
}

function gibberSystemPrompt() {
  return `You are a VoiceEnable agent exchanging data with ANOTHER AI agent over a slow audio data-link (gibberlink). Both sides are machines. Be extremely concise and information-dense: drop greetings, filler, and politeness. Prefer short structured statements. Personality: ${personalityInstruction()}.`;
}

function updateGibberStatus(note) {
  const g = state.gibber;
  if (!g) return;
  const channel = g.turbo ? "turbo (peer-to-peer)" : "compatible";
  const peer = g.peer ? `peer ${g.peer.id}` : "no peer yet";
  setRealtimeStatus(note ? `Gibberlink: ${note} (${channel}, ${peer})` : `Gibberlink linked — ${channel} channel, ${peer}.`, "ready");
}

async function activateGibberlink(message) {
  // If another mode already owns the mic, we won't yank it away mid-session (that's
  // the mic-mangling the refresh rule prevents). Ask the user to switch deliberately.
  if (state.micClaimed && state.mode !== "gibber") {
    addMessage("system", "I can talk over Gibberlink, but the mic is in use by the current mode. Refresh the page and pick Gibberlink mode to start a clean data link.");
    return { error: "Mic in use by another mode. Refresh and select Gibberlink mode." };
  }
  if (state.mode !== "gibber") setMode("gibber");
  if (!state.gibber) await startGibberlink();
  if (message) {
    addMessage("agent", message);
    await gibberSend({ t: "msg", id: GIBBER.AGENT_ID, text: message });
  }
  return { ok: true, mode: "gibberlink", turbo: !!state.gibber?.turbo, peer: state.gibber?.peer || null };
}

function stopGibberlink() {
  const g = state.gibber;
  if (!g) return;
  playSound("convoEnd");
  state.gibber = null;
  clearTimeout(g.helloTimer);
  stopOrbViz();
  try { g.processor.disconnect(); } catch {}
  try { g.source.disconnect(); } catch {}
  try { g.sink.disconnect(); } catch {}
  g.stream?.getTracks().forEach((track) => track.stop());
  g.audioContext?.close().catch(() => {});
  if (state.mode === "gibber") el.mainAction.textContent = "Start gibberlink";
  setOrb("idle");
  setRealtimeStatus("Gibberlink idle", "idle");
}

function stopAll() {
  stopRealtime();
  stopGibberlink();
  if (state.mediaRecorder?.state === "recording") state.mediaRecorder.stop();
}

function floatToPcm16(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

init();

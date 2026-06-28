const GEN_BASE = "https://gen.pollinations.ai";
const MEDIA_BASE = "https://media.pollinations.ai";
const ENTER_BASE = "https://enter.pollinations.ai";
const CLIENT_ID = "pk_VIepF2clCLKh5xiX";
const REALTIME_MODEL = "gpt-realtime-2";
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
  "OTHER CODING QUESTIONS (snippets, explanations, debugging, non-web code):",
  "- Answer normally in prose with standard fenced code blocks (```js, ```py, ```ts, etc.).",
  "- Do NOT use a ```html block for partial snippets — that block is reserved for one full runnable document.",
  "",
  "ALWAYS: never invent or hardcode secret API keys or credentials; use clearly named placeholders.",
].join("\n");

const state = {
  apiKey: localStorage.getItem("pollinations_api_key") || "",
  mode: "realtime",
  realtime: null,
  realtimeHealthTimer: null,
  balanceTimer: null,
  mediaRecorder: null,
  chunks: [],
  generationActive: 0,
  generationQueue: [],
  modelMeta: { text: [], image: [], audio: [], embeddings: [] },
  stoppingRealtime: false,
  messages: JSON.parse(localStorage.getItem("conversation") || "[]"),
  workspace: JSON.parse(localStorage.getItem("workspace") || "[]"),
  settings: JSON.parse(localStorage.getItem("settings") || "{}"),
  mcps: JSON.parse(localStorage.getItem("mcp_servers") || "[]"),
};

const el = {
  authState: document.querySelector("#authState"),
  keyHealth: document.querySelector("#keyHealth"),
  pollenBalance: document.querySelector("#pollenBalance"),
  connectByop: document.querySelector("#connectByop"),
  clearKey: document.querySelector("#clearKey"),
  modeRealtime: document.querySelector("#modeRealtime"),
  modePush: document.querySelector("#modePush"),
  mainAction: document.querySelector("#mainAction"),
  stopAction: document.querySelector("#stopAction"),
  orb: document.querySelector("#orb"),
  mediaDock: document.querySelector("#mediaDock"),
  generationCard: document.querySelector("#generationCard"),
  generationVisual: document.querySelector("#generationVisual"),
  generationStatus: document.querySelector("#generationStatus"),
  realtimeStatus: document.querySelector("#realtimeStatus"),
  modelAudio: document.querySelector("#modelAudio"),
  transcript: document.querySelector("#transcript"),
  textForm: document.querySelector("#textForm"),
  textInput: document.querySelector("#textInput"),
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
  navButtons: document.querySelectorAll(".nav-button"),
  drawerCloses: document.querySelectorAll(".drawer-close"),
};

const fields = [
  "themePreset",
  "layoutPreset",
  "personalityPreset",
  "textModel",
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

function init() {
  loadSettings();
  applyPresets();
  captureByopReturn();
  bindEvents();
  renderAuth();
  renderMessages();
  renderWorkspace();
  renderMcpServers();
  renderGallery();
  loadLiveModels();
  checkKeyHealth();
  startBalancePolling();
}

function bindEvents() {
  el.connectByop.addEventListener("click", connectByop);
  el.clearKey.addEventListener("click", clearApiKey);
  el.modeRealtime.addEventListener("click", () => setMode("realtime"));
  el.modePush.addEventListener("click", () => setMode("push"));
  el.mainAction.addEventListener("click", handleMainAction);
  el.stopAction.addEventListener("click", stopAll);
  el.textForm.addEventListener("submit", handleTextSubmit);
  el.clearConversation.addEventListener("click", clearConversation);
  el.clearWorkspace.addEventListener("click", clearWorkspace);
  el.clearGallery.addEventListener("click", clearGallery);
  el.mcpForm.addEventListener("submit", addMcpServer);
  el.navButtons.forEach((button) => button.addEventListener("click", () => openDrawer(button.dataset.drawer)));
  el.drawerCloses.forEach((button) => button.addEventListener("click", closeDrawers));
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
  fillSelect("coderModel", text.map(modelName), "qwen-coder");
  fillSelect("imageModel", imageModelsOnly().map(modelName), "flux");
  fillSelect("videoModel", videoModelsOnly().map(modelName), "ltx-2");
  fillSelect("audioModel", audio.map(modelName), "elevenmusic");
  fillSelect("ttsModel", audio.map(modelName), "openai-audio");
  fillSelect("sttModel", audio.map(modelName), "whisper");
  fillSelect("embeddingModel", embeddings.map(modelName), "openai-3-small");
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
  if (typeof row === "string") return row;
  return row.id || row.name || row.model || row.alias;
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

function isVideoModel(model) {
  const name = (modelName(model) || "").toLowerCase();
  // Image-only models can contain video-ish substrings (e.g. wan-image, gptimage,
  // grok-imagine, nova-canvas); never treat those as video.
  if (/image|imagine|canvas/.test(name)) return false;
  const text = modelText(model);
  return /video|veo|\bwan\b|wan-|seedance|ltx|reel|p-video/.test(`${name} ${text}`);
}

function supportsImageInput(modelNameValue) {
  const model = state.modelMeta.image.find((entry) => modelName(entry) === modelNameValue);
  const text = modelText(model);
  return /image|edit|reference|i2v|start|first|last|kontext|gptimage|seedream|klein|nanobanana/.test(`${modelNameValue} ${text}`);
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
  el.navButtons.forEach((button) => button.classList.toggle("active", button.dataset.drawer === id));
}

function closeDrawers() {
  document.querySelectorAll(".drawer").forEach((drawer) => drawer.classList.remove("active"));
  el.navButtons.forEach((button) => button.classList.remove("active"));
}

function applyPresets() {
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
  return `${amount} pollen`;
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
  stopAll();
  state.mode = mode;
  el.modeRealtime.classList.toggle("active", mode === "realtime");
  el.modePush.classList.toggle("active", mode === "push");
  el.mainAction.textContent = mode === "realtime" ? "Start realtime" : "Hold to talk";
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
        stopRealtime();
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
  const output = audioContext.createMediaStreamDestination();
  el.modelAudio.srcObject = output.stream;
  await el.modelAudio.play().catch(() => {});

  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const mutedMonitor = audioContext.createGain();
  mutedMonitor.gain.value = 0;
  const socket = new WebSocket(`${GEN_BASE.replace("https", "wss")}/v1/realtime?model=${REALTIME_MODEL}&key=${encodeURIComponent(state.apiKey)}`);

  state.realtime = { socket, stream, audioContext, processor, output, mutedMonitor, nextStart: audioContext.currentTime, gotSession: false, gotAudio: false, retriedWithoutVoice: false };
  setOrb("listening");
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
    const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
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
  if (event.type === "input_audio_buffer.speech_started") setRealtimeStatus("Listening...", "live");
  if (event.type === "input_audio_buffer.speech_stopped") setRealtimeStatus("Thinking...", "live");
  if (event.type === "response.function_call_arguments.done") runTool(event.name, JSON.parse(event.arguments || "{}"), event.call_id);
  if (event.type === "error") {
    const message = event.error?.message || "Realtime returned an error.";
    if (/voice/i.test(message) && /unknown|unsupported|invalid|not (allowed|supported)|param/i.test(message) && state.realtime && !state.realtime.retriedWithoutVoice) {
      state.realtime.retriedWithoutVoice = true;
      state.realtime.socket.send(JSON.stringify({ type: "session.update", session: realtimeSessionConfig(false) }));
      setRealtimeStatus("Voice setting unsupported here; continuing with default realtime voice.", "warning");
      return;
    }
    setRealtimeStatus(message, "warning");
  }
  if (event.type === "response.done") {
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
  rt.nextStart = Math.max(rt.nextStart, rt.audioContext.currentTime);
  source.start(rt.nextStart);
  rt.nextStart += buffer.duration;
}

function stopRealtime() {
  const rt = state.realtime;
  if (!rt) return;
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
}

function cleanupRealtime() {
  const rt = state.realtime;
  if (!rt) return;
  clearTimeout(state.realtimeHealthTimer);
  state.realtimeHealthTimer = null;
  rt.processor?.disconnect();
  rt.mutedMonitor?.disconnect();
  rt.stream?.getTracks().forEach((track) => track.stop());
  rt.audioContext?.close();
  state.realtime = null;
  state.stoppingRealtime = false;
  el.mainAction.textContent = "Start realtime";
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
  state.chunks = [];
  state.mediaRecorder = new MediaRecorder(stream);
  state.mediaRecorder.ondataavailable = (event) => event.data.size && state.chunks.push(event.data);
  state.mediaRecorder.onstop = () => finishPushRecording(stream);
  state.mediaRecorder.start();
  setOrb("listening");
  el.mainAction.textContent = "Stop recording";
}

function stopPushRecording() {
  state.mediaRecorder?.stop();
}

async function finishPushRecording(stream) {
  stream.getTracks().forEach((track) => track.stop());
  setOrb("idle");
  el.mainAction.textContent = "Hold to talk";
  const blob = new Blob(state.chunks, { type: state.mediaRecorder.mimeType || "audio/webm" });
  state.mediaRecorder = null;
  const text = await transcribe(blob);
  if (!text) return;
  addMessage("user", text);
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

async function handleTextSubmit(event) {
  event.preventDefault();
  if (!requireKey()) return;
  const text = el.textInput.value.trim();
  if (!text) return;
  el.textInput.value = "";
  addMessage("user", text);
  await chat(text, false);
}

async function chat(text, speak) {
  const history = state.messages
    .filter((m) => m.role === "user" || m.role === "agent")
    .slice(-12)
    .map((m) => ({ role: m.role === "agent" ? "assistant" : "user", content: m.content }));
  // The current user turn was already pushed via addMessage(), so it is the last
  // history entry. Only append `text` as a fallback if it is somehow missing.
  if (history[history.length - 1]?.content !== text) history.push({ role: "user", content: text });
  const payload = {
    model: value("textModel"),
    messages: [{ role: "system", content: systemPrompt() }, ...history],
    tools: toolDefinitions().map((tool) => ({ type: "function", function: tool })),
  };
  const result = await postJson("/v1/chat/completions", payload);
  if (!result) return;
  const message = result.choices?.[0]?.message;
  if (message?.tool_calls?.length) {
    await handleToolCalls(payload.messages, message, speak);
    return;
  }
  const content = message?.content || "I did not receive a response.";
  addMessage("agent", content);
  if (speak && value("ttsVoice")) await speakText(content);
}

async function handleToolCalls(messages, assistantMessage, speak) {
  messages.push(assistantMessage);
  for (const call of assistantMessage.tool_calls) {
    const args = JSON.parse(call.function.arguments || "{}");
    const result = await runTool(call.function.name, args);
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
  const followup = await postJson("/v1/chat/completions", { model: value("textModel"), messages });
  const content = followup?.choices?.[0]?.message?.content || "Done.";
  addMessage("agent", content);
  if (speak && value("ttsVoice")) await speakText(content);
}

async function speakText(text) {
  const res = await fetch(`${GEN_BASE}/v1/audio/speech`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ model: value("ttsModel") || "openai-audio", voice: value("ttsVoice") || "nova", input: text }),
  });
  if (!res.ok) return;
  const blob = await res.blob();
  el.modelAudio.srcObject = null;
  el.modelAudio.src = URL.createObjectURL(blob);
  await el.modelAudio.play().catch(() => {});
}

async function runTool(name, args, realtimeCallId) {
  const toolId = addToolEvent(name, args);
  let result;
  try {
    if (name === "create_image") result = await generateMedia("image", args.prompt, value("imageModel"), toolId, args);
    else if (name === "create_video") result = await generateMedia("video", args.prompt, value("videoModel"), toolId, args);
    else if (name === "create_audio") {
      const audioKind = detectLoaderKind("audio", args.prompt, "");
      const model = audioKind === "tts" ? value("ttsModel") : value("audioModel");
      result = await generateMedia("audio", args.prompt, model, toolId, args);
    }
    else if (name === "ask_coder_model") result = await askCoder(args.task || args.prompt || "", toolId);
    else if (name === "call_mcp_server") result = await callMcp(args.server, args.tool, args.arguments || {}, toolId);
    else if (name === "show_workspace") result = showWorkspace(args, toolId);
    else if (name === "request_source_images") result = requestSourceImages(args, toolId);
    else if (name === "remove_workspace") result = removeWorkspace(args, toolId);
    else if (name === "list_gallery") result = await listGalleryForAgent();
    else if (name === "use_gallery_sources") result = await useGallerySources(args, toolId);
    else result = { error: `Unknown tool: ${name}` };
  } catch (error) {
    result = { error: error.message || String(error) };
  }
  updateToolEvent(toolId, result?.error ? "error" : "done", summarizeToolResult(name, result));

  if (realtimeCallId && state.realtime?.socket?.readyState === WebSocket.OPEN) {
    state.realtime.socket.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: realtimeCallId, output: JSON.stringify(result) },
    }));
    state.realtime.socket.send(JSON.stringify({ type: "response.create" }));
  }
  return result;
}

async function generateMedia(kind, prompt, model, toolId, options = {}) {
  const count = generationCount(kind, options);
  const jobs = [];
  for (let index = 0; index < count; index += 1) {
    const position = state.generationQueue.length + Math.max(0, state.generationActive - 1);
    if (state.generationActive >= 2) updateToolEvent(toolId, "queued", `Queued behind ${position} generation${position === 1 ? "" : "s"}.`);
    jobs.push(enqueueGeneration(() => runMediaGeneration(kind, prompt, model, toolId, { ...options, batchIndex: index, batchCount: count })));
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
      .catch((error) => job.resolve({ error: error.message || String(error) }))
      .finally(() => {
        state.generationActive -= 1;
        pumpGenerationQueue();
      });
  }
}

async function runMediaGeneration(kind, prompt, model, toolId, options = {}) {
  if (kind === "audio" && detectLoaderKind(kind, prompt, model) === "tts") prompt = cleanTtsPrompt(prompt);
  if ((kind === "image" || kind === "video") && options.images?.length && !supportsImageInput(model)) {
    const replacement = sourceCapableModel(kind);
    if (replacement) {
      updateToolEvent(toolId, "running", `${model} does not advertise source-image support; using ${replacement}.`);
      model = replacement;
    }
  }
  const label = kind === "video" ? "video generation" : `${kind} generation`;
  const loaderKind = detectLoaderKind(kind, prompt, model);
  showGeneration(loaderKind, `Getting started on your ${label} now. When complete, it will be added to your local gallery.`);
  updateToolEvent(toolId, "running", `Generating ${kind} with ${model}.`);
  const path = kind === "image" ? `/image/${encodeURIComponent(prompt)}` : kind === "video" ? `/video/${encodeURIComponent(prompt)}` : `/audio/${encodeURIComponent(prompt)}`;
  const params = mediaParams(kind, loaderKind, model, options);
  params.set("key", state.apiKey);
  const url = `${GEN_BASE}${path}?${params}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) return failResponse(res, `${kind} generation failed.`);
  const blob = await res.blob();
  refreshBalance();
  const item = await saveGalleryItem({ kind, prompt, model, blob, remoteUrl: res.url });
  hideGeneration(`${capitalize(kind)} complete and saved to your local gallery.`);
  return { ok: true, galleryId: item.id, kind, prompt, model };
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
  showCoderTerminal([`$ coder-model --model ${model}`, "Booting coding worker...", `Task: ${task.slice(0, 180)}`]);
  const result = await postJson("/v1/chat/completions", {
    model,
    messages: [
      { role: "system", content: CODER_SYSTEM_PROMPT },
      { role: "user", content: task },
    ],
  });
  if (result?.error) {
    showCoderTerminal(["Coder request failed.", result.error], true);
    hideGeneration("Coder model request failed.");
    return { error: result.error };
  }
  const answer = result?.choices?.[0]?.message?.content || "";
  if (!answer) {
    showCoderTerminal(["No response returned from coder model."], true);
    hideGeneration("Coder model returned no content.");
    return { error: "Coder model returned no content." };
  }
  const html = extractHtmlProject(answer);
  if (html) {
    const item = await saveGalleryItem({ kind: "project", prompt: task, model, blob: new Blob([html], { type: "text/html" }) });
    showCoderTerminal(["HTML project detected.", "Saved a runnable project to your gallery.", "Open the Gallery to run or download it."], true);
    hideGeneration("Project saved to your local gallery.");
    return { answer: summarizeCoderAnswer(answer), projectGalleryId: item.id };
  }
  showCoderTerminal(["Coder response received.", "Returned guidance without a runnable HTML document."], true);
  hideGeneration("Coder model returned guidance.");
  return { answer };
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
  return [
    {
      name: "create_image",
      description: "Generate one or more image variations and save them to the local gallery. Use count for multi-image generation.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed image prompt" },
          count: { type: "integer", minimum: 1, maximum: 4, description: "Number of variations/images" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "create_video",
      description: "Generate one or two videos and save them to the local gallery. Use duration and aspectRatio when the user specifies length or format.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed video prompt" },
          count: { type: "integer", minimum: 1, maximum: 2, description: "Number of videos" },
          duration: { type: "integer", minimum: 1, maximum: 120, description: "Duration in seconds, model-dependent" },
          aspectRatio: { type: "string", enum: ["16:9", "9:16"], description: "Video aspect ratio" },
          withAudio: { type: "boolean", description: "Whether to request video audio when the model supports it" },
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
    { name: "ask_coder_model", description: "Delegate a coding task to the configured coder model. Returns { answer } with a short summary; when the task is a runnable web app/page/game it also returns { projectGalleryId } and saves the full HTML to the local gallery, where the user can open or download it. Tell the user it is in the gallery rather than pasting the code aloud.", parameters: objectParams({ task: "Coding task or question" }, ["task"]) },
    { name: "call_mcp_server", description: "Call a configured HTTP MCP gateway tool.", parameters: objectParams({ server: "Configured server name", tool: "MCP tool name", arguments: "Tool arguments object" }, ["server", "tool"]) },
    {
      name: "show_workspace",
      description: "Render adaptive UI in the workspace: note, chart, table, checklist, or metrics. Use real structured data, not prose pretending to be a chart.",
      parameters: {
        type: "object",
        properties: {
          layout: { type: "string", enum: ["note", "chart", "table", "checklist", "metrics"], description: "Workspace component type" },
          title: { type: "string", description: "Short professional title" },
          summary: { type: "string", description: "One or two sentence explanation" },
          data: { type: "array", description: "Rows, chart points, checklist items, or metrics", items: { type: "object", additionalProperties: true } },
        },
        required: ["layout", "title"],
      },
    },
    {
      name: "request_source_images",
      description: "Ask the user for source/reference image URLs or file uploads before an image edit, style transfer, or image-to-video task.",
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
      name: "list_gallery",
      description: "List locally saved gallery items so you can reference or reuse them.",
      parameters: { type: "object", properties: {} },
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
  return `You are a polished voice-first AI agent. Realtime mode must use ${REALTIME_MODEL}. Personality: ${personalityInstruction()}. Be conversational and brief by default. When visual structure helps, call show_workspace to render a chart, table, checklist, note, or metrics instead of speaking a dense answer. For charts, provide rows with label and numeric value. For checklists, provide rows with text and done. If the user asks to reuse a prior image/video/audio, call list_gallery first. If the user asks to edit an existing image or use an existing image as a reference, use use_gallery_sources when the target is already in the gallery, otherwise call request_source_images. You can remove stale workspace items with remove_workspace. You can call a coder model for coding tasks, HTTP MCP gateways for external tools, and Pollinations media tools for image, video, music, TTS, and audio generation. When starting video generation, say: "Getting started on your generation now. When complete your generation will be added to your local gallery."`;
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
  let res;
  try {
    res = await fetch(`${GEN_BASE}${path}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = `Network error calling ${path}: ${error.message || error}`;
    addMessage("system", message);
    return { error: message };
  }
  if (!res.ok) return failResponse(res, "Request failed.");
  const json = await res.json();
  refreshBalance();
  return json;
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

function showCoderTerminal(lines, done = false) {
  el.mediaDock.classList.remove("hidden");
  document.querySelector(".stage")?.classList.add("generating");
  el.orb.classList.add("docked");
  el.generationCard.className = "generating-card terminal-loader";
  el.generationVisual.className = "generation-visual terminal-visual";
  el.generationVisual.innerHTML = `<div class="terminal-output">${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}${done ? "" : "<span class=\"terminal-cursor\"></span>"}</div>`;
  el.generationStatus.textContent = done ? "Coder job complete." : "Coder model working...";
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function authHeaders() {
  return { Authorization: `Bearer ${state.apiKey}` };
}

async function failResponse(res, fallback) {
  const text = await res.text().catch(() => "");
  const message = text || `${fallback} (${res.status})`;
  addMessage("system", message);
  hideGeneration("Generation failed.");
  return { error: message };
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

function renderMessages() {
  el.transcript.innerHTML = "";
  for (const message of state.messages) {
    const div = document.createElement("div");
    div.className = `message ${message.role}`;
    if (message.role === "tool") renderToolMessage(div, message);
    else div.textContent = message.content;
    el.transcript.append(div);
  }
  el.transcript.scrollTop = el.transcript.scrollHeight;
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
    call_mcp_server: "MCP tool call",
    show_workspace: "Workspace update",
    request_source_images: "Source image request",
    remove_workspace: "Workspace cleanup",
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
  if (name === "list_gallery") return "Gallery items listed.";
  if (name === "use_gallery_sources") return "Gallery sources used for generation.";
  if (name === "ask_coder_model") return "Coder model returned guidance.";
  if (name === "call_mcp_server") return "MCP server returned a result.";
  if (result?.galleryId) return `${capitalize(result.kind)} saved to local gallery.`;
  return "Tool completed.";
}

function showWorkspace(args, toolId) {
  const artifact = {
    id: crypto.randomUUID(),
    layout: args.layout || "note",
    title: args.title || "Workspace",
    summary: args.summary || "",
    prompt: args.prompt || "",
    purpose: args.purpose || "",
    minImages: args.minImages || 1,
    maxImages: args.maxImages || 4,
    data: Array.isArray(args.data) ? args.data.slice(0, 12) : [],
    createdAt: Date.now(),
  };
  state.workspace.unshift(artifact);
  state.workspace = state.workspace.slice(0, 8);
  localStorage.setItem("workspace", JSON.stringify(state.workspace));
  renderWorkspace();
  updateToolEvent(toolId, "running", `Rendering ${artifact.layout}: ${artifact.title}`);
  return { ok: true, workspaceId: artifact.id, layout: artifact.layout };
}

function requestSourceImages(args, toolId) {
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
  saveWorkspace();
  renderWorkspace();
  updateToolEvent(toolId, "running", `Waiting for ${artifact.minImages}-${artifact.maxImages} source image(s).`);
  return { ok: true, workspaceId: artifact.id, purpose: artifact.purpose };
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
  localStorage.setItem("workspace", JSON.stringify(state.workspace));
}

function renderWorkspace() {
  el.adaptiveWorkspace.innerHTML = "";
  el.workspaceMode.textContent = state.workspace.length ? "Adaptive canvas active" : "Voice canvas";
  if (!state.workspace.length) {
    const empty = document.createElement("div");
    empty.className = "empty-workspace";
    empty.innerHTML = "<span>Adaptive workspace</span><strong>Ask for a chart, plan, comparison, or generated asset.</strong><p>The agent can reshape this surface while you talk.</p>";
    el.adaptiveWorkspace.append(empty);
    return;
  }
  for (const artifact of state.workspace) el.adaptiveWorkspace.append(renderArtifact(artifact));
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
  header.append(title, meta);
  card.append(header);
  if (artifact.summary) {
    const summary = document.createElement("p");
    summary.textContent = artifact.summary;
    card.append(summary);
  }
  if (artifact.layout === "chart") card.append(renderChart(artifact.data));
  else if (artifact.layout === "table") card.append(renderTable(artifact.data));
  else if (artifact.layout === "checklist") card.append(renderChecklist(artifact.data, artifact.id));
  else if (artifact.layout === "metrics") card.append(renderMetrics(artifact.data));
  else if (artifact.layout === "image_request") card.append(renderImageRequest(artifact));
  const remove = document.createElement("button");
  remove.className = "artifact-remove";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => removeWorkspace({ id: artifact.id }));
  card.append(remove);
  return card;
}

function renderChart(data) {
  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  const rows = normalizeRows(data).map((row) => ({ label: row.label || row.name || row.metric || "Item", value: Number(row.value ?? row.count ?? row.amount) || 0 })).slice(0, 8);
  const max = Math.max(...rows.map((row) => row.value), 1);
  const points = rows.map((row, index) => {
    const x = rows.length === 1 ? 50 : (index / (rows.length - 1)) * 100;
    const y = 90 - (row.value / max) * 72;
    return `${x},${y}`;
  }).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "workspace-svg-chart");
  svg.innerHTML = `<polyline points="${points}"/><path d="M0 92H100"/>`;
  wrap.append(svg);
  const bars = document.createElement("div");
  bars.className = "chart-bars";
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "chart-row";
    item.innerHTML = `<span class="chart-label"></span><span class="chart-track"><span class="chart-fill" style="width:${Math.min(100, (row.value / max) * 100)}%"></span></span><span class="chart-value"></span>`;
    item.querySelector(".chart-label").textContent = row.label;
    item.querySelector(".chart-value").textContent = String(row.value ?? "");
    bars.append(item);
  }
  wrap.append(bars);
  return wrap;
}

function renderTable(data) {
  data = normalizeRows(data);
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
  return table;
}

function renderChecklist(data, artifactId) {
  data = normalizeRows(data);
  const list = document.createElement("ul");
  list.className = "checklist";
  data.forEach((row, index) => {
    const li = document.createElement("li");
    li.className = row.done === false ? "" : "complete";
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = row.done === false ? "" : "done";
    const text = document.createElement("span");
    text.textContent = row.text || row.label || row.task || "Item";
    li.append(check, text);
    li.addEventListener("click", () => toggleChecklistItem(artifactId, index));
    list.append(li);
  });
  return list;
}

function normalizeRows(data) {
  if (Array.isArray(data)) return data.map((item) => typeof item === "string" ? { text: item, label: item } : item || {});
  if (typeof data === "string") return data.split(/\n|,/).map((text) => text.trim()).filter(Boolean).map((text) => ({ text, label: text, value: Number(text.match(/\d+(\.\d+)?/)?.[0]) || 1 }));
  if (data && typeof data === "object") return Object.entries(data).map(([label, value]) => ({ label, value }));
  return [];
}

function toggleChecklistItem(artifactId, index) {
  const artifact = state.workspace.find((item) => item.id === artifactId);
  if (!artifact?.data?.[index]) return;
  artifact.data[index].done = artifact.data[index].done === false;
  saveWorkspace();
  renderWorkspace();
}

function renderMetrics(data) {
  return renderTable(data.map((row) => ({ metric: row.label || row.name || "Metric", value: row.value ?? "", note: row.note || "" })));
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
      await generateMedia(artifact.purpose === "video_reference" ? "video" : "image", artifact.prompt, artifact.purpose === "video_reference" ? value("videoModel") : value("imageModel"), null, { images });
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

function showGeneration(kind, text) {
  el.mediaDock.classList.remove("hidden");
  document.querySelector(".stage")?.classList.add("generating");
  el.orb.classList.add("docked");
  el.generationCard.className = `generating-card ${kind}-loader`;
  el.generationVisual.className = `generation-visual ${kind}-visual`;
  el.generationVisual.innerHTML = generationVisualMarkup(kind);
  el.generationStatus.textContent = text;
  addMessage("agent", text);
}

function hideGeneration(text) {
  el.generationStatus.textContent = text;
  setTimeout(() => {
    el.mediaDock.classList.add("hidden");
    document.querySelector(".stage")?.classList.remove("generating");
    el.orb.classList.remove("docked");
    el.generationVisual.innerHTML = "";
  }, 1400);
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
  return `<div class="diffusion-grid"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>`;
}

function setOrb(mode) {
  el.orb.classList.remove("idle", "listening", "speaking");
  el.orb.classList.add(mode);
}

function loadSettings() {
  fields.forEach((id) => {
    if (state.settings[id]) document.querySelector(`#${id}`).value = state.settings[id];
  });
}

function saveSettings() {
  state.settings = Object.fromEntries(fields.map((id) => [id, value(id)]));
  localStorage.setItem("settings", JSON.stringify(state.settings));
}

function value(id) {
  return document.querySelector(`#${id}`).value.trim();
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
    const request = indexedDB.open("voiceenable-gallery", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("items", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveGalleryItem({ kind, prompt, model, blob, remoteUrl }) {
  const db = await openDb();
  const item = { id: crypto.randomUUID(), kind, prompt, model, blob, createdAt: Date.now() };
  if (remoteUrl) item.remoteUrl = remoteUrl;
  await putGalleryItem(item, db);
  await renderGallery();
  return item;
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
  el.gallery.innerHTML = "";
  for (const item of items) {
    const url = URL.createObjectURL(item.blob);
    const card = document.createElement("article");
    card.className = "gallery-item";
    const media = item.kind === "image" ? document.createElement("img") : item.kind === "video" ? document.createElement("video") : item.kind === "project" ? document.createElement("iframe") : document.createElement("audio");
    media.src = url;
    if (item.kind === "project") media.sandbox = "allow-scripts allow-forms allow-modals allow-pointer-lock";
    else if (item.kind !== "image") media.controls = true;
    const caption = document.createElement("p");
    caption.textContent = `${item.kind} / ${item.model}`;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = shortPrompt(item.prompt);
    const full = document.createElement("p");
    full.textContent = item.prompt;
    details.append(summary, full);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${item.kind}-${item.id}.${extensionFor(item.kind, item.blob.type)}`;
    link.textContent = "Download";
    const useButton = document.createElement("button");
    useButton.className = "gallery-use";
    useButton.type = "button";
    useButton.textContent = item.kind === "image" ? "Use as source" : item.kind === "project" ? "Open project" : "Show in canvas";
    useButton.addEventListener("click", () => addGalleryReference(item));
    card.append(media, caption, details, link, useButton);
    el.gallery.append(card);
  }
}

function addGalleryReference(item) {
  if (item.kind === "project") {
    showWorkspace({ layout: "note", title: "Runnable project", summary: "Open the project from the Gallery preview. Download the HTML file if you want to keep or edit it.", data: [{ id: item.id, model: item.model }] });
    openDrawer("galleryDrawer");
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

function stopAll() {
  stopRealtime();
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

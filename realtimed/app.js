const GEN_BASE = "https://gen.pollinations.ai";
const ENTER_BASE = "https://enter.pollinations.ai";
const CLIENT_ID = "pk_VIepF2clCLKh5xiX";
const REALTIME_MODEL = "gpt-realtime-2";

const state = {
  apiKey: localStorage.getItem("pollinations_api_key") || "",
  mode: "realtime",
  realtime: null,
  realtimeHealthTimer: null,
  mediaRecorder: null,
  chunks: [],
  messages: JSON.parse(localStorage.getItem("conversation") || "[]"),
  mcps: JSON.parse(localStorage.getItem("mcp_servers") || "[]"),
};

const el = {
  authState: document.querySelector("#authState"),
  keyHealth: document.querySelector("#keyHealth"),
  connectByop: document.querySelector("#connectByop"),
  clearKey: document.querySelector("#clearKey"),
  modeRealtime: document.querySelector("#modeRealtime"),
  modePush: document.querySelector("#modePush"),
  mainAction: document.querySelector("#mainAction"),
  stopAction: document.querySelector("#stopAction"),
  orb: document.querySelector("#orb"),
  mediaDock: document.querySelector("#mediaDock"),
  generationStatus: document.querySelector("#generationStatus"),
  realtimeStatus: document.querySelector("#realtimeStatus"),
  modelAudio: document.querySelector("#modelAudio"),
  transcript: document.querySelector("#transcript"),
  textForm: document.querySelector("#textForm"),
  textInput: document.querySelector("#textInput"),
  clearConversation: document.querySelector("#clearConversation"),
  clearGallery: document.querySelector("#clearGallery"),
  gallery: document.querySelector("#gallery"),
  mcpForm: document.querySelector("#mcpForm"),
  mcpName: document.querySelector("#mcpName"),
  mcpUrl: document.querySelector("#mcpUrl"),
  mcpList: document.querySelector("#mcpList"),
  modelStatus: document.querySelector("#modelStatus"),
};

const fields = [
  "textModel",
  "realtimeVoice",
  "coderModel",
  "sttModel",
  "ttsVoice",
  "embeddingModel",
  "imageModel",
  "videoModel",
  "audioModel",
];

function init() {
  loadSettings();
  captureByopReturn();
  bindEvents();
  renderAuth();
  renderMessages();
  renderMcpServers();
  renderGallery();
  loadLiveModels();
  checkKeyHealth();
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
  el.clearGallery.addEventListener("click", clearGallery);
  el.mcpForm.addEventListener("submit", addMcpServer);
  fields.forEach((id) => document.querySelector(`#${id}`).addEventListener("change", saveSettings));
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
    fetchModelNames("/text/models"),
    fetchModelNames("/image/models"),
    fetchModelNames("/audio/models"),
    fetchModelNames("/embeddings/models"),
  ]);
  const [text, image, audio, embeddings] = lists.map((result) => result.status === "fulfilled" ? result.value : []);
  fillDatalist("textModels", text);
  fillDatalist("imageModels", image);
  fillDatalist("audioModels", audio);
  fillDatalist("embeddingModels", embeddings);
  const loaded = [text, image, audio, embeddings].filter((items) => items.length).length;
  el.modelStatus.textContent = loaded
    ? `Loaded live model suggestions from ${loaded}/4 Pollinations model endpoints.`
    : "Could not load live model suggestions. You can still type model names manually.";
}

async function fetchModelNames(path) {
  const res = await fetch(`${GEN_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  return [...new Set(rows.map(modelName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function modelName(row) {
  if (typeof row === "string") return row;
  return row.id || row.name || row.model || row.alias;
}

function fillDatalist(id, names) {
  const list = document.querySelector(`#${id}`);
  list.innerHTML = "";
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    list.append(option);
  }
}

function clearApiKey() {
  state.apiKey = "";
  localStorage.removeItem("pollinations_api_key");
  renderAuth();
}

function renderAuth() {
  el.authState.textContent = state.apiKey ? "Connected" : "Not connected";
  el.authState.classList.toggle("danger", !state.apiKey);
  if (!state.apiKey) setKeyHealth("Connect BYOP to check key status.", "idle");
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
  setKeyHealth(`Key valid: ${keyType}${balanceText ? ` / ${balanceText}` : ""}.`, "healthy");
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

  state.realtime = { socket, stream, audioContext, processor, output, mutedMonitor, nextStart: audioContext.currentTime, gotSession: false, gotAudio: false };
  setOrb("listening");
  el.mainAction.textContent = "Stop realtime";
  setRealtimeStatus("Opening realtime socket...", "live");

  socket.addEventListener("open", () => {
    setRealtimeStatus("Socket open. Configuring audio session...", "live");
    socket.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: systemPrompt(),
        modalities: ["text", "audio"],
        voice: value("realtimeVoice") || "marin",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: value("sttModel") || "whisper" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 650,
          create_response: true,
        },
        tools: toolDefinitions(),
      },
    }));
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
  socket.addEventListener("close", stopRealtime);
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
  if (event.type === "error") setRealtimeStatus(event.error?.message || "Realtime returned an error.", "warning");
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
  rt.socket?.readyState === WebSocket.OPEN && rt.socket.close();
  clearTimeout(state.realtimeHealthTimer);
  state.realtimeHealthTimer = null;
  rt.processor?.disconnect();
  rt.mutedMonitor?.disconnect();
  rt.stream?.getTracks().forEach((track) => track.stop());
  rt.audioContext?.close();
  state.realtime = null;
  el.mainAction.textContent = "Start realtime";
  setRealtimeStatus("Realtime idle", "idle");
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
  const payload = {
    model: value("textModel"),
    messages: [
      { role: "system", content: systemPrompt() },
      ...state.messages.filter((m) => m.role === "user" || m.role === "agent").slice(-12).map((m) => ({ role: m.role === "agent" ? "assistant" : "user", content: m.content })),
      { role: "user", content: text },
    ],
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
    body: JSON.stringify({ model: "openai-audio", voice: value("ttsVoice"), input: text }),
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
    if (name === "create_image") result = await generateMedia("image", args.prompt, value("imageModel"), toolId);
    else if (name === "create_video") result = await generateMedia("video", args.prompt, value("videoModel"), toolId);
    else if (name === "create_audio") result = await generateMedia("audio", args.prompt, value("audioModel"), toolId);
    else if (name === "ask_coder_model") result = await askCoder(args.task || args.prompt || "", toolId);
    else if (name === "call_mcp_server") result = await callMcp(args.server, args.tool, args.arguments || {}, toolId);
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

async function generateMedia(kind, prompt, model, toolId) {
  const label = kind === "video" ? "video generation" : `${kind} generation`;
  showGeneration(`Getting started on your ${label} now. When complete, it will be added to your local gallery.`);
  updateToolEvent(toolId, "running", `Generating ${kind} with ${model}.`);
  const path = kind === "image" ? `/image/${encodeURIComponent(prompt)}` : kind === "video" ? `/video/${encodeURIComponent(prompt)}` : `/audio/${encodeURIComponent(prompt)}`;
  const url = `${GEN_BASE}${path}?model=${encodeURIComponent(model)}&key=${encodeURIComponent(state.apiKey)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) return failResponse(res, `${kind} generation failed.`);
  const blob = await res.blob();
  const item = await saveGalleryItem({ kind, prompt, model, blob });
  hideGeneration(`${capitalize(kind)} complete and saved to your local gallery.`);
  return { ok: true, galleryId: item.id, kind, prompt, model };
}

async function askCoder(task, toolId) {
  updateToolEvent(toolId, "running", `Asking ${value("coderModel")} to work on the coding task.`);
  const result = await postJson("/v1/chat/completions", {
    model: value("coderModel"),
    messages: [
      { role: "system", content: "You are a focused coding model. Return concise, actionable implementation help." },
      { role: "user", content: task },
    ],
  });
  return { answer: result?.choices?.[0]?.message?.content || "" };
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
    { name: "create_image", description: "Generate an image and save it to the local gallery.", parameters: objectParams({ prompt: "Detailed image prompt" }, ["prompt"]) },
    { name: "create_video", description: "Generate a video and save it to the local gallery.", parameters: objectParams({ prompt: "Detailed video prompt" }, ["prompt"]) },
    { name: "create_audio", description: "Generate music, sound, or TTS audio and save it to the local gallery.", parameters: objectParams({ prompt: "Audio, music, or voice prompt" }, ["prompt"]) },
    { name: "ask_coder_model", description: "Delegate coding tasks to the configured coder text model.", parameters: objectParams({ task: "Coding task or question" }, ["task"]) },
    { name: "call_mcp_server", description: "Call a configured HTTP MCP gateway tool.", parameters: objectParams({ server: "Configured server name", tool: "MCP tool name", arguments: "Tool arguments object" }, ["server", "tool"]) },
  ];
}

function objectParams(properties, required) {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(properties).map(([key, description]) => [key, { type: key === "arguments" ? "object" : "string", description }])),
    required,
  };
}

function systemPrompt() {
  return `You are a slick voice-first AI agent. Realtime mode must use ${REALTIME_MODEL}. Be conversational and brief by default. You can call a coder model for coding tasks, HTTP MCP gateways for external tools, and Pollinations media tools for image, video, music, TTS, and audio generation. When starting video generation, say: "Getting started on your generation now. When complete your generation will be added to your local gallery."`;
}

async function postJson(path, body) {
  const res = await fetch(`${GEN_BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return failResponse(res, "Request failed.");
  return res.json();
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
  };
  return labels[name] || name;
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "Preparing tool call.";
  return args.prompt || args.task || [args.server, args.tool].filter(Boolean).join(" / ") || "Preparing tool call.";
}

function summarizeToolResult(name, result) {
  if (result?.error) return result.error;
  if (name === "ask_coder_model") return "Coder model returned guidance.";
  if (name === "call_mcp_server") return "MCP server returned a result.";
  if (result?.galleryId) return `${capitalize(result.kind)} saved to local gallery.`;
  return "Tool completed.";
}

function clearConversation() {
  state.messages = [];
  localStorage.removeItem("conversation");
  renderMessages();
}

function showGeneration(text) {
  el.mediaDock.classList.remove("hidden");
  el.orb.classList.add("docked");
  el.generationStatus.textContent = text;
  addMessage("agent", text);
}

function hideGeneration(text) {
  el.generationStatus.textContent = text;
  setTimeout(() => {
    el.mediaDock.classList.add("hidden");
    el.orb.classList.remove("docked");
  }, 1400);
}

function setOrb(mode) {
  el.orb.classList.remove("idle", "listening", "speaking");
  el.orb.classList.add(mode);
}

function loadSettings() {
  const settings = JSON.parse(localStorage.getItem("settings") || "{}");
  fields.forEach((id) => {
    if (settings[id]) document.querySelector(`#${id}`).value = settings[id];
  });
}

function saveSettings() {
  localStorage.setItem("settings", JSON.stringify(Object.fromEntries(fields.map((id) => [id, value(id)]))));
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

async function saveGalleryItem({ kind, prompt, model, blob }) {
  const db = await openDb();
  const item = { id: crypto.randomUUID(), kind, prompt, model, blob, createdAt: Date.now() };
  await txDone(db.transaction("items", "readwrite").objectStore("items").put(item));
  await renderGallery();
  return item;
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
    const media = item.kind === "image" ? document.createElement("img") : item.kind === "video" ? document.createElement("video") : document.createElement("audio");
    media.src = url;
    if (item.kind !== "image") media.controls = true;
    const caption = document.createElement("p");
    caption.textContent = `${item.kind} / ${item.model}: ${item.prompt}`;
    const link = document.createElement("a");
    link.href = url;
    link.download = `${item.kind}-${item.id}.${extensionFor(item.kind, item.blob.type)}`;
    link.textContent = "Download";
    card.append(media, caption, link);
    el.gallery.append(card);
  }
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

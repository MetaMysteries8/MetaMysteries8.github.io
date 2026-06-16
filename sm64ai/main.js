// ============================================================
// Super Mario 64 Web – Pollinations AI Player
// Auth: BYOP redirect flow (no app key needed – static-safe)
// API:  gen.pollinations.ai  (OpenAI-compatible)
// ============================================================

// --- Pollinations BYOP Auth ---
const POLLINATIONS_AUTH_URL = 'https://enter.pollinations.ai/authorize';
const POLLINATIONS_API_BASE = 'https://gen.pollinations.ai';
const POLLINATIONS_TTS_BASE = 'https://gen.pollinations.ai/audio';
const AI_MODEL = 'openai-large'; // vision-capable model
const TTS_VOICE = 'nova';
const STORAGE_KEY = 'pollinations_api_key';

let pollinationsKey = null;

function getStoredKey() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function storeKey(k) {
    try { localStorage.setItem(STORAGE_KEY, k); } catch {}
}
function clearStoredKey() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

function buildAuthUrl() {
    const params = new URLSearchParams({
        redirect_uri: location.href.split('#')[0],
        // No client_id — works on any static page without an app key
    });
    return `${POLLINATIONS_AUTH_URL}?${params}`;
}

function grabKeyFromHash() {
    const hash = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const key = params.get('api_key');
    if (key) {
        // Clean the key out of the URL bar
        history.replaceState(null, '', location.pathname + location.search);
    }
    return key || null;
}

function initAuth() {
    const overlay = document.getElementById('auth-overlay');
    const authBtn  = document.getElementById('auth-btn');
    const authStatus = document.getElementById('auth-status');

    // 1. Check URL fragment first (returning from Pollinations)
    const hashKey = grabKeyFromHash();
    if (hashKey) {
        storeKey(hashKey);
        pollinationsKey = hashKey;
        authStatus.textContent = '✅ Authorized! Loading game…';
        overlay.classList.add('hidden');
        return;
    }

    // 2. Check localStorage
    const stored = getStoredKey();
    if (stored) {
        pollinationsKey = stored;
        overlay.classList.add('hidden');
        return;
    }

    // 3. Show auth overlay
    overlay.classList.remove('hidden');

    authBtn.addEventListener('click', () => {
        authStatus.textContent = '🔄 Redirecting to Pollinations…';
        authBtn.disabled = true;
        setTimeout(() => { window.location.href = buildAuthUrl(); }, 300);
    });
}

// --- Canvas / game setup ---
const canvas = document.getElementById('canvas');
canvas.style.touchAction = 'none';

canvas.addEventListener('mousedown', () => { canvas.focus(); });

window.Module = Object.assign(window.Module || {}, {
    canvas,
    locateFile: (path) => (path.endsWith('.wasm') ? './sm64.wasm' : path),
    print: (text) => { const s = document.getElementById('status'); if (s) s.textContent = String(text); else console.log(text); },
    printErr: (text) => { const s = document.getElementById('status'); if (s) s.textContent = `Error: ${String(text)}`; else console.error(text); }
});

canvas.focus();

function preventDefaultKeys(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const keys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'];
    if (keys.includes(e.code)) e.preventDefault();
}

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { e.stopPropagation(); return; }
    if (e.code === 'Enter') canvas.focus();
    preventDefaultKeys(e);
}, { passive: false });

window.dispatchEvent(new Event('resize'));

document.addEventListener('click', () => {
    try {
        if (Module?.SDL2?.audioContext?.state === 'suspended') Module.SDL2.audioContext.resume();
    } catch {}
});

// --- Pollinations API helpers ---
async function pollinationsChat(messages, opts = {}) {
    if (!pollinationsKey) throw new Error('Not authenticated with Pollinations');
    const body = {
        model: opts.model || AI_MODEL,
        max_tokens: opts.max_tokens || 1000,
        messages,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {})
    };
    const res = await fetch(`${POLLINATIONS_API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${pollinationsKey}`
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        if (res.status === 401 || res.status === 402) {
            clearStoredKey();
            pollinationsKey = null;
            document.getElementById('auth-overlay').classList.remove('hidden');
            throw new Error('Pollinations auth expired — please reconnect');
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.choices[0].message.content;
}

async function pollinationsTTS(text) {
    if (!pollinationsKey) return null;
    // GET /audio/{text}?voice=nova
    const encoded = encodeURIComponent(text.slice(0, 300));
    const url = `${POLLINATIONS_TTS_BASE}/${encoded}?voice=${TTS_VOICE}&key=${pollinationsKey}`;
    return url; // Pollinations TTS returns audio directly from GET
}

// --- AI Player state ---
let aiPlayerActive = false;
let aiStream = null;
let aiInterval = null;
const aiBtn = document.getElementById('ai-player-btn');
const aiStatus = document.getElementById('ai-status');
let aiMode = 'auto';
let aiManualState = 'idle';
let aiPlannedActions = null;
let aiMemory = [];
let aiNotes = [];
let userInstruction = '';
let gameSpeed = 1;
let playerMovementDetected = false;

const keyMap = {
    'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
    'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
    'jump': 'KeyX', 'crouch': 'Space', 'action': 'KeyC', 'start': 'Enter'
};

// Track keyboard input
let playerInputs = new Set();
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { e.stopPropagation(); return; }
    const movementKeys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD','Space','KeyX','KeyC'];
    if (movementKeys.includes(e.code)) { playerInputs.add(e.code); playerMovementDetected = true; }
});
document.addEventListener('keyup', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { e.stopPropagation(); return; }
    playerInputs.delete(e.code);
    if (playerInputs.size === 0) playerMovementDetected = false;
});

// Speed control
const speedSlider = document.getElementById('speed-slider');
const speedLabel  = document.getElementById('speed-label');
speedSlider.addEventListener('input', (e) => {
    gameSpeed = parseFloat(e.target.value);
    speedLabel.textContent = `${gameSpeed}x`;
    if (aiInterval) {
        clearInterval(aiInterval);
        if (aiPlayerActive && aiMode === 'auto') {
            aiInterval = setInterval(async () => {
                await aiThinkAndAct();
                await delay(2000 / gameSpeed);
            }, 7000 / gameSpeed);
        }
    }
});

// Mute
const muteBtn = document.getElementById('mute-btn');
let isMuted = false;
muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    muteBtn.textContent = isMuted ? '🔇' : '🔊';
    try {
        if (Module?.SDL2?.audioContext) {
            isMuted ? Module.SDL2.audioContext.suspend() : Module.SDL2.audioContext.resume();
        }
    } catch {}
});

// Instruction input
const instructionInput = document.getElementById('ai-instruction');
const sendInstructionBtn = document.getElementById('send-instruction');
sendInstructionBtn.addEventListener('click', () => {
    userInstruction = instructionInput.value.trim();
    if (userInstruction) { updateAIStatus(`📝 Instruction set: ${userInstruction}`); instructionInput.value = ''; }
});
instructionInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendInstructionBtn.click(); });

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function simulateKeyPress(key, duration = 100) {
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: key, key, bubbles: true }));
    setTimeout(() => canvas.dispatchEvent(new KeyboardEvent('keyup', { code: key, key, bubbles: true })), duration);
}

function updateAIStatus(message) {
    aiStatus.style.display = 'block';
    aiStatus.textContent = message;
}

// Capture current game frame as base64 PNG via screen share stream
async function captureScreen() {
    try {
        const video = document.createElement('video');
        video.srcObject = aiStream;
        video.play();
        await new Promise(resolve => { video.onloadedmetadata = resolve; });
        const tmp = document.createElement('canvas');
        tmp.width  = video.videoWidth;
        tmp.height = video.videoHeight;
        tmp.getContext('2d').drawImage(video, 0, 0);
        return tmp.toDataURL('image/png');
    } catch (err) {
        console.error('Screen capture error:', err);
        return null;
    }
}

// Load training data files
async function loadTrainingData() {
    let t1 = '', t2 = '';
    try { t1 = await (await fetch('./quick-fox-085gw.txt')).text(); } catch {}
    try { t2 = await (await fetch('./brisk-spark-08poq.txt')).text(); } catch {}
    return { t1, t2 };
}

async function aiThink() {
    updateAIStatus('🤔 Thinking…');

    const screenshot = await captureScreen();
    if (!screenshot) { updateAIStatus('❌ Failed to capture screen'); return null; }

    const { t1, t2 } = await loadTrainingData();

    const movementCtx = playerMovementDetected
        ? '\n\nNOTE: The player is currently moving/providing input.'
        : '\n\nNOTE: The player is currently idle (no input detected).';

    const memoryCtx = aiMemory.length > 0
        ? `\n\nPAST MISTAKES TO AVOID:\n${aiMemory.slice(-5).map((m,i) => `${i+1}. ${m}`).join('\n')}`
        : '';

    const notesCtx = aiNotes.length > 0
        ? `\n\nYOUR PRE-GAME STUDY NOTES:\n${aiNotes.join('\n')}`
        : '';

    const instrCtx = userInstruction ? `\n\nUSER INSTRUCTION: ${userInstruction}` : '';

    const trainingCtx = (t1 || t2) ? `

TRAINING DATA - LEARN FROM THESE EXAMPLES:

=== TRAINING SET 1 ===
${t1}

=== TRAINING SET 2 ===
${t2}

Study these examples carefully to understand the game flow, common mistakes, and correct sequences of actions.` : '';

    const systemPrompt = `You are an AI playing Super Mario 64. Analyze the screenshot and decide what actions to take.

GAME OBJECTIVE CONTEXT:
1. When you start, head towards the castle entrance
2. Cross the bridge to reach the castle door
3. Skip any dialog by pressing jump (X key) OR start (Enter key) repeatedly
4. Once inside the castle, DO NOT run back out - proceed forward
5. Find and enter the first door (star door with no number requirement)
6. Jump into the painting to start the first level
7. You can perform multiple actions simultaneously

IMPORTANT: If you recognize you are in a location you were just in (like back outside the castle when you should be inside), immediately recognize this as going backwards and course-correct. Say "I went backwards!" in your speech and fix your direction.

Controls available:
- ArrowUp, ArrowDown, ArrowLeft, ArrowRight: Movement
- jump: X key (also advances text/dialog)
- start: Enter key (also advances text/dialog, pauses game)
- crouch: Space
- action: C key (dive, punch, grab, etc.)
${movementCtx}${memoryCtx}${notesCtx}${instrCtx}${trainingCtx}

Respond with JSON only, following this schema:
{
  "actions": [["action1", "action2"], ["action3"], ...],
  "thought": "brief explanation of strategy",
  "speech": "what you want to say out loud about the situation and your plan",
  "mistake": "if you notice you made an error, describe it here, otherwise null"
}

Each inner array represents simultaneous actions. For example:
[["ArrowUp", "jump"], ["action"]] means: hold forward and jump together, then press action.
Each action must be one of: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, jump, start, crouch, action
Max 5 action groups per turn.
The speech should be conversational and engaging, like a streamer commentating their gameplay.`;

    // Extract base64 from data URL
    const base64Image = screenshot.replace(/^data:image\/png;base64,/, '');

    try {
        const rawContent = await pollinationsChat([
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What should I do in this situation?' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
                ]
            }
        ], { json: true, max_tokens: 600 });

        // Strip any json fences Pollinations might add
        const clean = rawContent.replace(/```json|```/g, '').trim();
        const response = JSON.parse(clean);

        updateAIStatus(`💭 ${response.thought}`);

        if (response.mistake && response.mistake !== 'null' && response.mistake !== null) {
            aiMemory.push(response.mistake);
        }

        // TTS
        if (response.speech) {
            try {
                const ttsUrl = await pollinationsTTS(response.speech);
                if (ttsUrl) {
                    const audio = new Audio(ttsUrl);
                    audio.playbackRate = Math.min(gameSpeed, 2);
                    audio.play().catch(() => {});
                }
            } catch {}
        }

        return response;

    } catch (err) {
        console.error('AI error:', err);
        updateAIStatus(`❌ ${err.message}`);
        return null;
    }
}

async function aiExecute(response) {
    if (!response?.actions?.length) return;
    updateAIStatus(`🎮 Executing ${response.actions.length} action groups…`);
    const maxDuration = 10000;
    const actionDuration = Math.min((maxDuration / response.actions.length), 10000) / gameSpeed;

    for (let i = 0; i < response.actions.length; i++) {
        if (!aiPlayerActive) break;
        const actionGroup = Array.isArray(response.actions[i]) ? response.actions[i] : [response.actions[i]];
        for (const action of actionGroup) {
            const keyCode = keyMap[action];
            if (keyCode) simulateKeyPress(keyCode, Math.min(actionDuration * 0.8, 10000 / gameSpeed));
        }
        updateAIStatus(`🎮 Action ${i+1}/${response.actions.length}: ${actionGroup.join('+')}`);
        await delay(actionDuration);
    }
    updateAIStatus('✅ Done');
}

async function aiThinkAndAct() {
    if (!aiPlayerActive) return;
    const resp = await aiThink();
    if (resp) await aiExecute(resp);
}

async function toggleAIPlayer() {
    if (!pollinationsKey) {
        document.getElementById('auth-overlay').classList.remove('hidden');
        return;
    }
    if (!aiPlayerActive) {
        try {
            aiStream = await navigator.mediaDevices.getDisplayMedia({ video: { mediaSource: 'screen' } });
            aiPlayerActive = true;
            if (aiMode === 'auto') {
                aiBtn.textContent = 'Stop AI (Auto)';
                aiBtn.classList.add('active');
                updateAIStatus('🤖 AI Player Active (Auto Mode)');
                const cycle = 7000 / gameSpeed;
                aiInterval = setInterval(async () => {
                    await aiThinkAndAct();
                    await delay(2000 / gameSpeed);
                }, cycle);
                aiThinkAndAct();
            } else {
                aiManualState = 'idle';
                aiBtn.textContent = 'Think';
                aiBtn.classList.add('active');
                updateAIStatus('🤖 Manual Mode – Press to think');
            }
            aiStream.getVideoTracks()[0].onended = () => stopAIPlayer();
        } catch (err) {
            alert('Screen sharing permission denied or not supported');
        }
    } else {
        aiMode === 'manual' ? handleManualModeClick() : stopAIPlayer();
    }
}

async function handleManualModeClick() {
    if (aiManualState === 'idle') {
        aiManualState = 'thinking';
        aiBtn.textContent = 'Thinking…';
        aiBtn.disabled = true;
        aiPlannedActions = await aiThink();
        if (aiPlannedActions) {
            aiManualState = 'ready';
            aiBtn.textContent = 'Execute';
            aiBtn.disabled = false;
            updateAIStatus('✅ Plan ready – Press to execute');
        } else {
            aiManualState = 'idle';
            aiBtn.textContent = 'Think';
            aiBtn.disabled = false;
        }
    } else if (aiManualState === 'ready') {
        aiManualState = 'executing';
        aiBtn.textContent = 'Stop';
        await aiExecute(aiPlannedActions);
        aiManualState = 'idle';
        aiBtn.textContent = 'Think';
        updateAIStatus('💤 Idle – Press to think again');
    } else if (aiManualState === 'executing') {
        stopAIPlayer();
    }
}

function stopAIPlayer() {
    aiPlayerActive = false;
    if (aiStream) { aiStream.getTracks().forEach(t => t.stop()); aiStream = null; }
    if (aiInterval) { clearInterval(aiInterval); aiInterval = null; }
    aiManualState = 'idle';
    aiPlannedActions = null;
    aiBtn.textContent = 'AI Player';
    aiBtn.classList.remove('active');
    aiBtn.disabled = false;
    aiStatus.style.display = 'none';
}

aiBtn.addEventListener('click', toggleAIPlayer);
aiBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (aiPlayerActive) stopAIPlayer();
    aiMode = aiMode === 'auto' ? 'manual' : 'auto';
    aiBtn.textContent = `AI Player (${aiMode === 'auto' ? 'Auto' : 'Manual'})`;
    setTimeout(() => { if (!aiPlayerActive) aiBtn.textContent = 'AI Player'; }, 2000);
});

// --- AI Buddy Coach ---
let buddyActive = false;
let buddyInterval = null;
let buddyStream = null;
const buddyBtn   = document.getElementById('ai-buddy-btn');
const buddyPanel = document.getElementById('buddy-panel');
const buddyText  = document.getElementById('buddy-text');

async function buddyAdvise() {
    if (!buddyActive) return;
    buddyText.textContent = '🤔 Analyzing your gameplay…';
    try {
        const streamToUse = aiStream || buddyStream;
        if (!streamToUse) { buddyText.textContent = '❌ No screen share active!'; return; }

        const video = document.createElement('video');
        video.srcObject = streamToUse;
        video.play();
        await new Promise(r => { video.onloadedmetadata = r; });
        const tmp = document.createElement('canvas');
        tmp.width = video.videoWidth; tmp.height = video.videoHeight;
        tmp.getContext('2d').drawImage(video, 0, 0);
        const screenshot = tmp.toDataURL('image/png');
        const base64Image = screenshot.replace(/^data:image\/png;base64,/, '');

        const rawContent = await pollinationsChat([
            {
                role: 'system',
                content: `You are an AI Buddy Coach for Super Mario 64. Analyze the screenshot and give helpful advice to the player.

Give encouragement, tips, and guidance on what they should do next. Keep it friendly, supportive, and concise (2-3 sentences max).

Focus on:
- What the player should do next
- Encouragement and motivation
- Helpful tips for the current situation

Respond with JSON only:
{
  "text": "Your coaching advice text",
  "speech": "What to say out loud (can be same as text or more conversational)"
}`
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What advice do you have for me?' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
                ]
            }
        ], { json: true, max_tokens: 300 });

        const clean = rawContent.replace(/```json|```/g, '').trim();
        const advice = JSON.parse(clean);
        buddyText.textContent = `💬 ${advice.text}`;

        if (advice.speech) {
            try {
                const ttsUrl = await pollinationsTTS(advice.speech);
                if (ttsUrl) { const a = new Audio(ttsUrl); a.play().catch(() => {}); }
            } catch {}
        }
    } catch (err) {
        buddyText.textContent = `❌ ${err.message}`;
    }
}

async function toggleBuddy() {
    if (!pollinationsKey) { document.getElementById('auth-overlay').classList.remove('hidden'); return; }
    if (!buddyActive) {
        if (!aiStream && !buddyStream) {
            try {
                buddyStream = await navigator.mediaDevices.getDisplayMedia({ video: { mediaSource: 'screen' } });
                buddyStream.getVideoTracks()[0].onended = () => stopBuddy();
            } catch { alert('Screen sharing permission denied!'); return; }
        }
        buddyActive = true;
        buddyBtn.classList.add('active');
        buddyBtn.textContent = 'Stop Buddy';
        buddyPanel.style.display = 'block';
        buddyText.textContent = "👋 Hey! I'm here to help coach you!";
        buddyInterval = setInterval(buddyAdvise, 15000);
        setTimeout(buddyAdvise, 2000);
    } else { stopBuddy(); }
}

function stopBuddy() {
    buddyActive = false;
    buddyBtn.classList.remove('active');
    buddyBtn.textContent = 'AI Buddy Coach';
    buddyPanel.style.display = 'none';
    if (buddyInterval) { clearInterval(buddyInterval); buddyInterval = null; }
    if (buddyStream && !aiPlayerActive) { buddyStream.getTracks().forEach(t => t.stop()); buddyStream = null; }
}

buddyBtn.addEventListener('click', toggleBuddy);

// --- Memory viewer ---
document.getElementById('view-memory-btn').addEventListener('click', () => {
    const panel = document.getElementById('memory-panel');
    const content = document.getElementById('memory-content');
    panel.style.display = 'block';
    let text = '=== AI STUDY NOTES ===\n';
    text += aiNotes.length > 0 ? aiNotes.map((n,i) => `${i+1}. ${n}`).join('\n') : 'No study notes yet.';
    text += '\n\n=== MISTAKES & LEARNINGS ===\n';
    text += aiMemory.length > 0 ? aiMemory.map((m,i) => `${i+1}. ${m}`).join('\n') : 'No mistakes recorded yet.';
    content.textContent = text;
});
document.getElementById('close-memory-btn').addEventListener('click', () => {
    document.getElementById('memory-panel').style.display = 'none';
});

// --- Pre-game Study Notes ---
document.getElementById('pregame-notes-btn').addEventListener('click', async () => {
    if (!pollinationsKey) { document.getElementById('auth-overlay').classList.remove('hidden'); return; }
    const btn = document.getElementById('pregame-notes-btn');
    btn.disabled = true;
    btn.textContent = 'Studying…';

    try {
        const { t1, t2 } = await loadTrainingData();

        const rawContent = await pollinationsChat([
            {
                role: 'system',
                content: `You are analyzing Super Mario 64 gameplay training data to extract key learnings and create study notes.

Read through the training data carefully and extract:
1. Common mistakes to avoid
2. Key sequences and strategies
3. Important game mechanics
4. Optimal paths and approaches

Respond with JSON:
{
  "notes": ["note1", "note2", "note3", ...]
}

Keep each note brief and actionable. Aim for 8-12 important notes.`
            },
            {
                role: 'user',
                content: `Please analyze this training data and create study notes:\n\n=== TRAINING SET 1 ===\n${t1}\n\n=== TRAINING SET 2 ===\n${t2}`
            }
        ], { json: true, max_tokens: 800 });

        const clean = rawContent.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);
        aiNotes = result.notes || [];

        btn.textContent = `✓ ${aiNotes.length} Notes Created`;
        btn.style.background = '#4CAF50';
        document.getElementById('view-memory-btn').click();
        setTimeout(() => { btn.disabled = false; }, 2000);
    } catch (err) {
        btn.textContent = '❌ Error';
        btn.disabled = false;
        setTimeout(() => {
            btn.textContent = 'AI Study Notes';
            btn.style.background = '#00BCD4';
        }, 3000);
    }
});

// --- Persistent save (Emscripten IDBFS) ---
Module.preRun.push(function () {
    try {
        if (Module.FS && Module.IDBFS) {
            try { Module.FS.mkdir('/save'); } catch {}
            Module.FS.mount(Module.IDBFS, {}, '/save');
        }
    } catch (err) { console.error('preRun save error:', err); }
});

Module.onRuntimeInitialized = function () {
    try {
        if (Module.FS && Module.IDBFS) {
            Module.FS.syncfs(true, (err) => { if (err) console.warn('syncfs load error:', err); });
            window.saveNow = function (cb) {
                try { if (typeof Module.writeSave === 'function') Module.writeSave(); } catch {}
                Module.FS.syncfs(false, (err) => { if (typeof cb === 'function') cb(err); });
            };
            setInterval(() => window.saveNow(), 5000);
            window.addEventListener('beforeunload', () => {
                try { Module.FS.syncfs(false, () => {}); } catch {}
            });
            document.addEventListener('visibilitychange', () => { if (document.hidden) window.saveNow(); });
        }
    } catch (err) { console.error('save init error:', err); }
};

// --- Boot ---
initAuth();

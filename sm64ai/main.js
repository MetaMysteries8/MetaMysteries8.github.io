// ============================================================
// Super Mario 64 Web – AI Player  (v3)
//
// NEW in v3:
//  - TTS queue with interrupt / wait / drain modes (no overlap)
//  - Multi-API provider system (Pollinations, OpenAI, Anthropic,
//    Google Gemini, any OpenAI-compatible endpoint)
//    → vision capability verified before allowing selection
//  - Inference throttle: skip call if screen unchanged, back-off
//    on repeated errors, configurable think interval
//  - AI-generated controls guide (one call, cached forever)
//  - Idle detection: pause AI loop when player is active
// ============================================================

// ────────────────────────────────────────────────────────────
// 1. CONSTANTS
// ────────────────────────────────────────────────────────────
const POLLINATIONS_AUTH_URL   = 'https://enter.pollinations.ai/authorize';
const POLLINATIONS_API_BASE   = 'https://gen.pollinations.ai';
const POLLINATIONS_MODELS_URL = 'https://gen.pollinations.ai/text/models';

const STORAGE_KEY        = 'pollinations_api_key';
const MODEL_STORAGE_KEY  = 'sm64_selected_model';
const PROVIDER_STORAGE   = 'sm64_provider';
const CONTROLS_CACHE_KEY = 'sm64_controls_guide';
const DEFAULT_MODEL      = 'openai-large';

// Minimum ms between AI inference calls (prevents runaway spending)
const MIN_THINK_INTERVAL_MS = 5000;
// How many identical frames before we skip an inference call
const IDLE_FRAME_SKIP = 2;
// Max consecutive errors before backing off
const MAX_ERRORS_BEFORE_BACKOFF = 3;

// Rapid-fire mode: AI-requestable turbo loop
const RAPID_FIRE_INTERVAL_MS  = 1500;  // think every 1.5s
const RAPID_FIRE_MAX_TURNS    = 30;    // auto-exit after 30 turns (~45s)
const RAPID_FIRE_ACTION_MS    = 300;   // shorter action window

// Local vision model (SmolVLM-256M via Transformers.js)
const LOCAL_VLM_MODEL = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const LOCAL_VLM_CDN   = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';

// ────────────────────────────────────────────────────────────
// 2. TTS QUEUE  (single channel, no overlap)
// ────────────────────────────────────────────────────────────
//
// tts.speak(text)           — queue a message, plays after current one ends
// tts.interrupt(text)       — cancel everything and speak immediately
// tts.wait(ms).then(...)    — promise that resolves after ms (for deferred speech)
// tts.drain()               — clear the queue (but let current finish)
// tts.stop()                — cancel everything including current
//
const tts = (() => {
    let queue   = [];
    let playing = false;
    let current = null;

    function getVoice() {
        const voices = window.speechSynthesis?.getVoices() || [];
        return voices.find(v =>
            v.lang.startsWith('en') &&
            /female|woman|samantha|karen|victoria|zira|susan|google us english/i.test(v.name)
        ) || voices.find(v => v.lang.startsWith('en')) || null;
    }

    function playNext() {
        if (!window.speechSynthesis || playing || queue.length === 0) return;
        const text = queue.shift();
        playing = true;
        const utt = new SpeechSynthesisUtterance(text);
        utt.rate   = 1.05;
        utt.pitch  = 1.0;
        utt.volume = 0.92;
        const v = getVoice();
        if (v) utt.voice = v;
        utt.onend = utt.onerror = () => { playing = false; current = null; playNext(); };
        current = utt;
        window.speechSynthesis.speak(utt);
        updateTTSIndicator(true);
        utt.onend = () => {
            playing = false; current = null;
            updateTTSIndicator(queue.length > 0);
            playNext();
        };
    }

    function updateTTSIndicator(on) {
        const el = document.getElementById('tutorial-audio-indicator');
        if (el) el.classList.toggle('playing', on);
    }

    let silenced = false;

    return {
        speak(text) {
            if (!text || !window.speechSynthesis || silenced) return;
            queue.push(text);
            playNext();
        },
        interrupt(text) {
            if (!window.speechSynthesis) return;
            queue = text ? [text] : [];
            window.speechSynthesis.cancel();
            playing = false; current = null;
            if (text && !silenced) setTimeout(playNext, 80);
        },
        wait(ms) { return new Promise(r => setTimeout(r, ms)); },
        drain()  { queue = []; },
        stop()   { queue = []; window.speechSynthesis?.cancel(); playing = false; current = null; updateTTSIndicator(false); },
        silence(on) {
            silenced = on;
            if (on) { queue = []; window.speechSynthesis?.cancel(); playing = false; current = null; updateTTSIndicator(false); }
        },
        get isPlaying()  { return playing; },
        get isSilenced() { return silenced; },
    };
})();

// ────────────────────────────────────────────────────────────
// 3. MULTI-API PROVIDER SYSTEM
// ────────────────────────────────────────────────────────────
//
// Each provider describes how to call its chat completions endpoint.
// Vision capability is verified before the provider is allowed.
//
// Built-in providers:
//   pollinations  — uses stored Pollinations key, models fetched live
//   openai        — standard OpenAI API key, gpt-4o / gpt-4-vision
//   anthropic     — Claude 3 Opus/Sonnet/Haiku via messages API
//   gemini        — Google Gemini via openai-compat endpoint
//   custom        — user-supplied base URL + key (OpenAI-compat)
//

const PROVIDERS = {
    pollinations: {
        id:    'pollinations',
        label: 'Pollinations AI',
        icon:  '🌸',
        hasVision: true,   // verified at model-fetch time
        keyLabel: 'Pollinations Key (via OAuth)',
        keyPlaceholder: 'Connect via OAuth below',
        oauthOnly: true,
        modelsUrl: POLLINATIONS_MODELS_URL,
        buildRequest(messages, model, key, opts) {
            return {
                url: `${POLLINATIONS_API_BASE}/v1/chat/completions`,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: { model, messages, max_tokens: opts.max_tokens || 800,
                    ...(opts.json ? { response_format: { type: 'json_object' } } : {}) },
            };
        },
    },
    openai: {
        id:    'openai',
        label: 'OpenAI',
        icon:  '🤖',
        hasVision: true,
        keyLabel: 'OpenAI API Key',
        keyPlaceholder: 'sk-…',
        defaultModel: 'gpt-4o',
        visionModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4-vision-preview'],
        buildRequest(messages, model, key, opts) {
            return {
                url: 'https://api.openai.com/v1/chat/completions',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: { model, messages, max_tokens: opts.max_tokens || 800,
                    ...(opts.json ? { response_format: { type: 'json_object' } } : {}) },
            };
        },
    },
    anthropic: {
        id:    'anthropic',
        label: 'Anthropic Claude',
        icon:  '🧠',
        hasVision: true,
        keyLabel: 'Anthropic API Key',
        keyPlaceholder: 'sk-ant-…',
        defaultModel: 'claude-3-5-sonnet-20241022',
        visionModels: ['claude-3-5-sonnet-20241022','claude-3-opus-20240229','claude-3-haiku-20240307','claude-opus-4-5','claude-sonnet-4-5'],
        buildRequest(messages, model, key, opts) {
            // Convert OpenAI-style messages to Anthropic format
            const system  = messages.find(m => m.role === 'system')?.content || '';
            const history = messages.filter(m => m.role !== 'system').map(m => {
                if (typeof m.content === 'string') return m;
                // Convert image_url to Anthropic base64 block
                const parts = m.content.map(p => {
                    if (p.type === 'text') return { type: 'text', text: p.text };
                    if (p.type === 'image_url') {
                        const url = p.image_url.url;
                        const [header, data] = url.split(',');
                        const mediaType = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
                        return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
                    }
                    return p;
                });
                return { role: m.role, content: parts };
            });
            return {
                url: 'https://api.anthropic.com/v1/messages',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                },
                body: { model, system, messages: history, max_tokens: opts.max_tokens || 800 },
                responseExtract: (data) => data.content?.[0]?.text || '',
            };
        },
    },
    gemini: {
        id:    'gemini',
        label: 'Google Gemini',
        icon:  '💎',
        hasVision: true,
        keyLabel: 'Google AI Studio Key',
        keyPlaceholder: 'AIza…',
        defaultModel: 'gemini-1.5-flash',
        visionModels: ['gemini-1.5-flash','gemini-1.5-pro','gemini-2.0-flash-exp','gemini-2.5-flash'],
        buildRequest(messages, model, key, opts) {
            // Use OpenAI-compat endpoint via Google
            return {
                url: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: { model, messages, max_tokens: opts.max_tokens || 800,
                    ...(opts.json ? { response_format: { type: 'json_object' } } : {}) },
            };
        },
    },
    custom: {
        id:    'custom',
        label: 'Custom (OpenAI-compat)',
        icon:  '🔧',
        hasVision: null,  // unknown until user confirms
        keyLabel: 'API Key',
        keyPlaceholder: 'your-key-here',
        defaultModel: '',
        buildRequest(messages, model, key, opts) {
            const base = (window._customApiBase || '').replace(/\/$/, '');
            return {
                url: `${base}/v1/chat/completions`,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: { model, messages, max_tokens: opts.max_tokens || 800,
                    ...(opts.json ? { response_format: { type: 'json_object' } } : {}) },
            };
        },
    },
    local: {
        id:       'local',
        label:    'Local (SmolVLM-256M)',
        icon:     '💻',
        hasVision: true,
        keyLabel: 'No key needed',
        keyPlaceholder: 'Runs in your browser',
        noKey: true,
        defaultModel: LOCAL_VLM_MODEL,
        visionModels: [LOCAL_VLM_MODEL],
        buildRequest() { return null; }, // not used — callLocalVision() handles it
    },
};

// Active provider state
let activeProvider = PROVIDERS.pollinations;
let providerKeys   = {};   // { providerId: 'key-string' }
let pollinationsKey = null; // kept for Pollinations OAuth compat

function getActiveKey() {
    if (activeProvider.id === 'pollinations') return pollinationsKey;
    return providerKeys[activeProvider.id] || null;
}

async function callChatAPI(messages, opts = {}) {
    // Local provider: route through in-browser SmolVLM
    if (activeProvider.id === 'local') {
        // Extract the image and text from the messages
        const userMsg = messages.find(m => m.role === 'user');
        let imageUrl = null, textPrompt = '';
        if (Array.isArray(userMsg?.content)) {
            for (const p of userMsg.content) {
                if (p.type === 'image_url') imageUrl = p.image_url.url;
                if (p.type === 'text')      textPrompt += p.text + ' ';
            }
        } else {
            textPrompt = userMsg?.content || '';
        }
        // Prepend system context to prompt
        const sysMsg = messages.find(m => m.role === 'system');
        const fullPrompt = (sysMsg ? sysMsg.content.slice(0, 500) + '\n\n' : '') + textPrompt.trim();
        if (imageUrl) return await callLocalVision(imageUrl, fullPrompt);
        throw new Error('Local vision model requires an image');
    }

    const key   = getActiveKey();
    if (!key) throw new Error(`No API key for ${activeProvider.label}`);
    const model = opts.model || getSelectedModel();
    const req   = activeProvider.buildRequest(messages, model, key, opts);

    const res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
    });

    if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
            if (activeProvider.id === 'pollinations') {
                clearStoredKey();
                pollinationsKey = null;
                document.getElementById('auth-overlay').classList.remove('hidden');
            }
            throw new Error(`Auth failed (${res.status}) — check your API key`);
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }

    const data = await res.json();

    // Allow provider to define custom response extraction
    if (req.responseExtract) return req.responseExtract(data);
    return data.choices?.[0]?.message?.content || '';
}

// ────────────────────────────────────────────────────────────
// 3b. LOCAL VISION MODEL  (SmolVLM-256M via Transformers.js)
// ────────────────────────────────────────────────────────────
//
// Activated when the active provider has hasVision !== true.
// Loads SmolVLM-256M-Instruct in-browser via WebGPU (or WASM fallback).
// Provides callLocalVision(screenshotDataUrl, prompt) → string
//

let _localVLMPipe   = null;   // Transformers.js pipeline once loaded
let _localVLMState  = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
let _localVLMError  = null;

// Check if current provider has vision
function providerHasVision() {
    if (activeProvider.id === 'local') return true;  // local IS vision
    if (activeProvider.id === 'custom') return PROVIDERS.custom.hasVision === true;
    return activeProvider.hasVision === true;
}

// Dynamically load Transformers.js CDN script once
function loadTransformersJS() {
    return new Promise((resolve, reject) => {
        if (window.__transformers__) { resolve(window.__transformers__); return; }
        if (document.getElementById('transformers-js-script')) {
            // Already injecting — wait
            const wait = setInterval(() => {
                if (window.__transformers__) { clearInterval(wait); resolve(window.__transformers__); }
            }, 200);
            return;
        }
        const s = document.createElement('script');
        s.id  = 'transformers-js-script';
        s.type = 'module';
        s.textContent = `
            import { pipeline, env } from '${LOCAL_VLM_CDN}';
            env.allowLocalModels = false;
            window.__transformers__ = { pipeline, env };
        `;
        s.onerror = () => reject(new Error('Failed to load Transformers.js'));
        document.head.appendChild(s);
        const wait = setInterval(() => {
            if (window.__transformers__) { clearInterval(wait); resolve(window.__transformers__); }
        }, 200);
        setTimeout(() => { clearInterval(wait); reject(new Error('Transformers.js load timeout')); }, 30000);
    });
}

async function initLocalVLM(onProgress) {
    if (_localVLMState === 'ready') return true;
    if (_localVLMState === 'loading') return false;
    _localVLMState = 'loading';
    _localVLMError = null;

    try {
        onProgress?.('Loading Transformers.js…', 5);
        const { pipeline, env } = await loadTransformersJS();

        onProgress?.('Downloading SmolVLM-256M model (~400 MB)…', 10);
        // Use WebGPU if available, fall back to WASM
        const device = navigator.gpu ? 'webgpu' : 'wasm';

        _localVLMPipe = await pipeline(
            'image-text-to-text',
            LOCAL_VLM_MODEL,
            {
                device,
                dtype: device === 'webgpu' ? 'fp16' : 'q4',
                progress_callback: (info) => {
                    if (info.status === 'progress') {
                        const pct = Math.round(10 + (info.progress || 0) * 0.85);
                        onProgress?.(`Downloading… ${Math.round(info.progress || 0)}%`, pct);
                    }
                },
            }
        );

        _localVLMState = 'ready';
        onProgress?.('Local vision model ready!', 100);
        return true;
    } catch (err) {
        console.error('Local VLM init error:', err);
        _localVLMState = 'error';
        _localVLMError = err.message;
        onProgress?.(`Error: ${err.message}`, -1);
        return false;
    }
}

async function callLocalVision(screenshotDataUrl, textPrompt) {
    if (_localVLMState !== 'ready' || !_localVLMPipe) {
        throw new Error('Local vision model not ready');
    }
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'image', url: screenshotDataUrl },
                { type: 'text',  text: textPrompt },
            ],
        },
    ];
    const result = await _localVLMPipe(messages, { max_new_tokens: 200 });
    return result?.[0]?.generated_text?.at(-1)?.content || '';
}

// ── Non-vision warning modal ──────────────────────────────
function showVisionRequiredModal() {
    document.getElementById('vision-required-modal').classList.add('open');
    document.getElementById('vision-required-backdrop').classList.add('open');
}
function hideVisionRequiredModal() {
    document.getElementById('vision-required-modal').classList.remove('open');
    document.getElementById('vision-required-backdrop').classList.remove('open');
}

// ── Local model loader modal ──────────────────────────────
function showLocalModelModal() {
    hideVisionRequiredModal();
    document.getElementById('local-model-modal').classList.add('open');
    document.getElementById('local-model-backdrop').classList.add('open');
    updateLocalModelProgress('Click Load to download SmolVLM-256M (~400 MB)', 0);
}
function hideLocalModelModal() {
    document.getElementById('local-model-modal').classList.remove('open');
    document.getElementById('local-model-backdrop').classList.remove('open');
}

function updateLocalModelProgress(msg, pct) {
    const bar  = document.getElementById('local-model-bar');
    const text = document.getElementById('local-model-status');
    if (text) text.textContent = msg;
    if (bar)  bar.style.width  = (pct < 0 ? 0 : Math.min(100, pct)) + '%';
    if (bar)  bar.style.background = pct < 0 ? '#e53935' : '';
}

document.getElementById('local-model-load-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('local-model-load-btn');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    const ok = await initLocalVLM(updateLocalModelProgress);
    if (ok) {
        // Switch active provider to local
        activeProvider = PROVIDERS.local;
        try { localStorage.setItem(PROVIDER_STORAGE, 'local'); } catch {}
        populateModelDropdown();
        hideLocalModelModal();
        tts.interrupt('Local vision model loaded! AI player is ready.');
        // If AI was waiting to start, retry
        if (_pendingAIStart) { _pendingAIStart = false; toggleAIPlayer(); }
    } else {
        btn.disabled = false;
        btn.textContent = 'Retry';
    }
});

document.getElementById('local-model-cancel-btn')?.addEventListener('click', hideLocalModelModal);
document.getElementById('local-model-backdrop')?.addEventListener('click', hideLocalModelModal);
document.getElementById('vision-required-backdrop')?.addEventListener('click', hideVisionRequiredModal);

document.getElementById('vision-req-connect-btn')?.addEventListener('click', () => {
    hideVisionRequiredModal();
    openProviderPanel();
});
document.getElementById('vision-req-local-btn')?.addEventListener('click', showLocalModelModal);

let _pendingAIStart = false;

// ────────────────────────────────────────────────────────────
// 4. AUTH (Pollinations OAuth)
// ────────────────────────────────────────────────────────────
const getStoredKey   = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };
const storeKey       = k  => { try { localStorage.setItem(STORAGE_KEY, k); } catch {} };
const clearStoredKey = () => { try { localStorage.removeItem(STORAGE_KEY); } catch {} };

function buildAuthUrl() {
    const params = new URLSearchParams({ redirect_uri: location.href.split('#')[0] });
    return `${POLLINATIONS_AUTH_URL}?${params}`;
}

function grabKeyFromHash() {
    const hash   = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const key    = params.get('api_key');
    if (key) history.replaceState(null, '', location.pathname + location.search);
    return key || null;
}

function initAuth() {
    const overlay    = document.getElementById('auth-overlay');
    const authBtn    = document.getElementById('auth-btn');
    const authStatus = document.getElementById('auth-status');

    const hashKey = grabKeyFromHash();
    if (hashKey) {
        storeKey(hashKey);
        pollinationsKey = hashKey;
        providerKeys.pollinations = hashKey;
        authStatus.textContent = '✅ Authorized! Loading game…';
        overlay.classList.add('hidden');
        document.getElementById('disconnect-btn').style.display = '';
        tts.interrupt('Connected! Your Pollinations account is linked. The game is ready.');
        return;
    }

    const stored = getStoredKey();
    if (stored) {
        pollinationsKey = stored;
        providerKeys.pollinations = stored;
        overlay.classList.add('hidden');
        document.getElementById('disconnect-btn').style.display = '';
        return;
    }

    overlay.classList.remove('hidden');
    tts.speak('Welcome to SM64 AI Player! Connect your Pollinations account to get started.');

    authBtn.addEventListener('click', () => {
        authStatus.textContent = '🔄 Redirecting to Pollinations…';
        authBtn.disabled = true;
        setTimeout(() => { window.location.href = buildAuthUrl(); }, 300);
    });

    document.getElementById('auth-tutorial-btn').addEventListener('click', () => openTutorial());
}

// ────────────────────────────────────────────────────────────
// 5. CANVAS / GAME SETUP
// ────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
canvas.style.touchAction = 'none';
canvas.addEventListener('mousedown', () => canvas.focus());

Object.assign(window.Module, {
    canvas,
    locateFile: (path) => (path.endsWith('.wasm') ? './sm64.wasm' : path),
});

canvas.focus();

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { e.stopPropagation(); return; }
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'Enter') canvas.focus();
}, { passive: false });

document.addEventListener('click', () => {
    try { if (Module?.SDL2?.audioContext?.state === 'suspended') Module.SDL2.audioContext.resume(); } catch {}
});

// ────────────────────────────────────────────────────────────
// 6. LIVE MODEL FETCHING (Pollinations)
// ────────────────────────────────────────────────────────────
let allVisionModels = [];
let showPaidModels  = false;

async function fetchVisionModels() {
    const select     = document.getElementById('model-select');
    const statusSpan = document.getElementById('model-status');

    select.innerHTML = '<option value="">Loading…</option>';
    select.disabled  = true;

    try {
        const res  = await fetch(POLLINATIONS_MODELS_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        allVisionModels = data.filter(m =>
            Array.isArray(m.input_modalities) && m.input_modalities.includes('image')
        );
        populateModelDropdown();
    } catch (err) {
        console.error('Failed to fetch models:', err);
        allVisionModels = [{ name: DEFAULT_MODEL, title: 'GPT-5.4 (fallback)', paid_only: false }];
        populateModelDropdown();
        if (statusSpan) statusSpan.textContent = '⚠ offline';
    }
}

function populateModelDropdown() {
    const select     = document.getElementById('model-select');
    const statusSpan = document.getElementById('model-status');
    if (!select) return;

    // For non-Pollinations providers, show their static vision model list
    if (activeProvider.id !== 'pollinations') {
        const models = activeProvider.visionModels || [];
        select.innerHTML = '';
        const grp = document.createElement('optgroup');
        if (activeProvider.id === 'local') {
            grp.label = '💻 Local Model (in-browser)';
        } else {
            grp.label = `${activeProvider.label} Vision Models`;
        }
        const saved = localStorage.getItem(MODEL_STORAGE_KEY) || activeProvider.defaultModel;
        for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = activeProvider.id === 'local'
                ? `SmolVLM-256M — ${_localVLMState === 'ready' ? '✅ loaded' : '⏳ not loaded'}`
                : m;
            if (m === saved) opt.selected = true;
            grp.appendChild(opt);
        }
        select.appendChild(grp);
        select.disabled = activeProvider.id === 'local'; // can't change local model
        if (statusSpan) statusSpan.textContent = activeProvider.id === 'local'
            ? (_localVLMState === 'ready' ? '✅ local' : '⏳ not loaded')
            : `${models.length} models`;
        return;
    }

    const visible   = showPaidModels ? allVisionModels : allVisionModels.filter(m => !m.paid_only);
    const savedModel = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL;
    const savedOK    = visible.some(m => m.name === savedModel);

    select.innerHTML = '';
    const free = visible.filter(m => !m.paid_only);
    const paid = visible.filter(m =>  m.paid_only);

    function addGroup(label, models) {
        if (!models.length) return;
        const grp = document.createElement('optgroup');
        grp.label = label;
        for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.textContent = m.title || m.name;
            if (m.paid_only) opt.classList.add('paid-model');
            if (m.name === (savedOK ? savedModel : DEFAULT_MODEL)) opt.selected = true;
            grp.appendChild(opt);
        }
        select.appendChild(grp);
    }

    addGroup('Free Models', free);
    if (showPaidModels) addGroup('Paid Models 💰', paid);

    select.disabled = false;
    const freeCount = allVisionModels.filter(m => !m.paid_only).length;
    const paidCount = allVisionModels.filter(m =>  m.paid_only).length;
    if (statusSpan) statusSpan.textContent = showPaidModels
        ? `${free.length + paid.length} models`
        : `${freeCount} free · ${paidCount} paid hidden`;
}

function getSelectedModel() {
    const sel = document.getElementById('model-select');
    const val = sel?.value;
    if (val) return val;
    return activeProvider.defaultModel || DEFAULT_MODEL;
}

document.getElementById('model-select').addEventListener('change', (e) => {
    try { localStorage.setItem(MODEL_STORAGE_KEY, e.target.value); } catch {}
});

document.getElementById('show-paid-toggle').addEventListener('change', (e) => {
    showPaidModels = e.target.checked;
    populateModelDropdown();
});

// ────────────────────────────────────────────────────────────
// 7. PROVIDER SETTINGS PANEL
// ────────────────────────────────────────────────────────────
function buildProviderPanel() {
    const panel = document.getElementById('provider-panel');
    if (!panel) return;
    panel.innerHTML = '';

    // Provider selector
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.innerHTML = '<label class="provider-label">AI Provider</label>';

    const sel = document.createElement('select');
    sel.id = 'provider-select';
    sel.className = 'provider-select';
    for (const [id, p] of Object.entries(PROVIDERS)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${p.icon} ${p.label}`;
        if (id === activeProvider.id) opt.selected = true;
        sel.appendChild(opt);
    }
    row.appendChild(sel);
    panel.appendChild(row);

    // Key input (hidden for Pollinations OAuth)
    const keyRow = document.createElement('div');
    keyRow.className = 'provider-row';
    keyRow.id = 'provider-key-row';

    const keyLabel = document.createElement('label');
    keyLabel.className = 'provider-label';
    keyLabel.textContent = activeProvider.keyLabel;

    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.id   = 'provider-key-input';
    keyInput.className = 'provider-key-input';
    keyInput.placeholder = activeProvider.keyPlaceholder;
    keyInput.value = providerKeys[activeProvider.id] || '';
    if (activeProvider.oauthOnly) { keyInput.disabled = true; keyInput.placeholder = 'Connected via OAuth'; }
    if (activeProvider.noKey) { keyInput.disabled = true; keyInput.placeholder = 'No key needed — runs locally'; }

    keyRow.appendChild(keyLabel);
    keyRow.appendChild(keyInput);
    panel.appendChild(keyRow);

    // Custom base URL row (only for custom provider)
    if (activeProvider.id === 'custom') {
        const urlRow = document.createElement('div');
        urlRow.className = 'provider-row';
        urlRow.innerHTML = '<label class="provider-label">Base URL</label>';
        const urlInput = document.createElement('input');
        urlInput.type = 'text'; urlInput.id = 'custom-base-url';
        urlInput.className = 'provider-key-input';
        urlInput.placeholder = 'https://your-api.example.com';
        urlInput.value = window._customApiBase || '';
        urlInput.addEventListener('input', () => { window._customApiBase = urlInput.value.trim(); });
        urlRow.appendChild(urlInput);
        panel.appendChild(urlRow);

        const visionRow = document.createElement('div');
        visionRow.className = 'provider-row';
        visionRow.innerHTML = '<label class="provider-label">Vision-capable?</label>';
        const visionCheck = document.createElement('input');
        visionCheck.type = 'checkbox'; visionCheck.id = 'custom-vision-check';
        visionCheck.checked = PROVIDERS.custom.hasVision === true;
        visionCheck.addEventListener('change', () => { PROVIDERS.custom.hasVision = visionCheck.checked; });
        visionRow.appendChild(visionCheck);
        panel.appendChild(visionRow);
    }

    // Save button
    const saveBtn = document.createElement('button');
    saveBtn.className = 'provider-save-btn';
    saveBtn.textContent = '✓ Save & Apply';
    saveBtn.addEventListener('click', () => {
        const newId = sel.value;
        activeProvider = PROVIDERS[newId];
        const newKey   = keyInput.value.trim();
        if (newKey && !activeProvider.oauthOnly) {
            providerKeys[newId] = newKey;
            try { localStorage.setItem(`sm64_key_${newId}`, newKey); } catch {}
        }
        try { localStorage.setItem(PROVIDER_STORAGE, newId); } catch {}
        populateModelDropdown();
        closeProviderPanel();
        tts.interrupt(`Switched to ${activeProvider.label}.`);
    });
    panel.appendChild(saveBtn);

    // Update key row on provider change
    sel.addEventListener('change', () => {
        const p = PROVIDERS[sel.value];
        keyLabel.textContent    = p.keyLabel;
        keyInput.placeholder    = p.noKey ? 'No key needed — runs locally' : p.keyPlaceholder;
        keyInput.disabled       = !!(p.oauthOnly || p.noKey);
        keyInput.value          = providerKeys[p.id] || '';
    });
}

function openProviderPanel() {
    buildProviderPanel();
    document.getElementById('provider-modal').classList.add('open');
    document.getElementById('provider-backdrop').classList.add('open');
}

function closeProviderPanel() {
    document.getElementById('provider-modal').classList.remove('open');
    document.getElementById('provider-backdrop').classList.remove('open');
}

document.getElementById('provider-btn')?.addEventListener('click', openProviderPanel);
document.getElementById('provider-backdrop')?.addEventListener('click', closeProviderPanel);
document.getElementById('close-provider-btn')?.addEventListener('click', closeProviderPanel);

// Restore saved provider + keys on load
function restoreProviderState() {
    try {
        const savedProvider = localStorage.getItem(PROVIDER_STORAGE);
        if (savedProvider && PROVIDERS[savedProvider]) activeProvider = PROVIDERS[savedProvider];
        for (const id of Object.keys(PROVIDERS)) {
            const k = localStorage.getItem(`sm64_key_${id}`);
            if (k) providerKeys[id] = k;
        }
    } catch {}
}

// ────────────────────────────────────────────────────────────
// 8. CONTROLS GUIDE  (one AI call, cached in localStorage)
// ────────────────────────────────────────────────────────────
const CONTROLS_STATIC = [
    { key: '↑ ↓ ← →',  action: 'Move Mario' },
    { key: 'X',         action: 'Jump / Skip dialog' },
    { key: 'Space',     action: 'Crouch / Duck' },
    { key: 'C',         action: 'Dive / Punch / Grab' },
    { key: 'Enter',     action: 'Pause / Skip dialog' },
    { key: 'Z',         action: 'Camera left' },
    { key: 'X + ↑',    action: 'Long jump (run first)' },
    { key: 'X + X',    action: 'Double / Triple jump' },
];

let controlsGuide = null;

function renderControlsGuide(data) {
    const panel = document.getElementById('controls-panel');
    if (!panel) return;
    panel.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'controls-title';
    title.textContent = '🎮 Controls';
    panel.appendChild(title);

    const rows = data || CONTROLS_STATIC;
    for (const row of rows) {
        const item = document.createElement('div');
        item.className = 'controls-item';
        item.innerHTML = `<kbd>${row.key}</kbd><span>${row.action}</span>`;
        panel.appendChild(item);
    }

    if (!data) {
        const note = document.createElement('div');
        note.className = 'controls-note';
        note.textContent = 'Connect account for AI-enhanced guide';
        panel.appendChild(note);
    }
}

async function fetchAIControlsGuide() {
    // Use cached version if available
    try {
        const cached = localStorage.getItem(CONTROLS_CACHE_KEY);
        if (cached) {
            controlsGuide = JSON.parse(cached);
            renderControlsGuide(controlsGuide);
            return;
        }
    } catch {}

    if (!getActiveKey()) { renderControlsGuide(null); return; }

    try {
        const raw = await callChatAPI([
            {
                role: 'system',
                content: `You are a Super Mario 64 expert. Generate a concise keyboard controls reference for the web version.
The controls are: Arrow keys = move, X = jump/skip dialog, Space = crouch, C = dive/punch/grab, Enter = pause/skip dialog.
Also include: long jump (run + crouch + jump), triple jump, wall kick, backflip, side somersault.

Respond with ONLY valid JSON array (no markdown fences):
[{"key": "display string", "action": "what it does"}, ...]

Keep it to 12-16 entries. Make action descriptions helpful for new players.`,
            },
            { role: 'user', content: 'Generate the controls guide.' },
        ], { max_tokens: 500 });

        const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(clean);
        if (Array.isArray(parsed) && parsed.length > 0) {
            controlsGuide = parsed;
            try { localStorage.setItem(CONTROLS_CACHE_KEY, JSON.stringify(parsed)); } catch {}
            renderControlsGuide(controlsGuide);
        }
    } catch (err) {
        console.warn('Controls guide AI call failed:', err);
        renderControlsGuide(null);
    }
}

document.getElementById('controls-toggle-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('controls-panel');
    if (!panel) return;
    const open = panel.classList.toggle('open');
    if (open && !controlsGuide) fetchAIControlsGuide();
});

// ────────────────────────────────────────────────────────────
// 9. TUTORIAL (Web Speech API via tts queue)
// ────────────────────────────────────────────────────────────
const TUTORIAL_STEPS = [
    {
        icon: '🍄', title: 'Welcome to SM64 AI Player',
        body: 'Watch an AI play Super Mario 64 in real time, get coached by your AI buddy, and give live instructions — all powered by your chosen AI provider.',
        narration: 'Welcome to SM64 AI Player! Watch an AI play Super Mario 64 in real time, get coached by your AI buddy, and give live instructions.',
    },
    {
        icon: '🔑', title: 'Step 1 — Connect Your Account',
        body: 'Click the green Connect button to link your Pollinations account via OAuth. Or open API Settings to use OpenAI, Anthropic, Gemini, or any custom OpenAI-compatible endpoint.',
        narration: 'Connect your Pollinations account with the green button, or open API Settings to use OpenAI, Anthropic, Gemini, or a custom endpoint.',
    },
    {
        icon: '🎮', title: 'Step 2 — Play It Yourself',
        body: 'The game loads automatically once connected. Use arrow keys to move, X to jump, Space to crouch, C to dive or punch, and Enter to skip dialog. Open the Controls guide for the full reference.',
        narration: 'Use arrow keys to move, X to jump, Space to crouch, C to dive or punch, and Enter to skip dialog. Open the Controls guide for the full reference.',
    },
    {
        icon: '🤖', title: 'Step 3 — AI Player',
        body: 'Click AI Play to let the AI take over. Share your screen when prompted so the AI can see the game. It analyzes each frame, decides what to do, and plays — narrating its thoughts out loud.',
        narration: 'Click AI Play to let the AI take over. Share your screen so the AI can see the game. It will analyze each frame and play, narrating its thoughts out loud.',
    },
    {
        icon: '💬', title: 'Step 4 — Give the AI Instructions',
        body: 'While the AI plays, type a message at the bottom and press Send. Try: "go find a star" or "jump into the painting". The AI factors your instruction into its next move.',
        narration: 'While the AI plays, type instructions at the bottom and press Send. Try: go find a star, or jump into the painting.',
    },
    {
        icon: '🧡', title: 'Step 5 — AI Buddy Coach',
        body: 'The Buddy Coach watches your gameplay and gives tips every 15 seconds. Click Buddy, share your screen, and it will coach you with encouragement and strategy advice.',
        narration: 'The Buddy Coach watches your gameplay and gives tips every 15 seconds. Click Buddy, share your screen, and it will coach you.',
    },
    {
        icon: '📚', title: 'Step 6 — Study & Memory',
        body: 'Click Study to have the AI read the SM64 guide and generate strategy notes. Click Memory to review those notes and any mistakes the AI has logged.',
        narration: 'Click Study to have the AI read the SM64 guide and generate strategy notes. Click Memory to review them.',
    },
    {
        icon: '🏆', title: "You're All Set!",
        body: "That's everything! Reopen this tutorial anytime with the ❓ button. Connect your account and have fun!",
        narration: "That's everything! Reopen this tutorial anytime with the help button. Connect your account and have fun!",
    },
];

let tutorialStep = 0;

function openTutorial(startStep = 0) {
    tutorialStep = startStep;
    document.getElementById('tutorial-modal').classList.add('open');
    document.getElementById('tutorial-backdrop').classList.add('open');
    renderTutorialStep();
}

function closeTutorial() {
    document.getElementById('tutorial-modal').classList.remove('open');
    document.getElementById('tutorial-backdrop').classList.remove('open');
    tts.stop();
}

function renderTutorialStep() {
    const step = TUTORIAL_STEPS[tutorialStep];
    document.getElementById('tutorial-progress').textContent = `Step ${tutorialStep + 1} of ${TUTORIAL_STEPS.length}`;
    document.getElementById('tutorial-icon').textContent  = step.icon;
    document.getElementById('tutorial-title').textContent = step.title;
    document.getElementById('tutorial-body').textContent  = step.body;

    const prevBtn = document.getElementById('tutorial-prev-btn');
    const nextBtn = document.getElementById('tutorial-next-btn');
    prevBtn.style.visibility = tutorialStep === 0 ? 'hidden' : 'visible';
    nextBtn.textContent = tutorialStep === TUTORIAL_STEPS.length - 1 ? 'Done ✓' : 'Next →';

    if (step.narration) tts.interrupt(step.narration);
}

document.getElementById('tutorial-next-btn').addEventListener('click', () => {
    if (tutorialStep < TUTORIAL_STEPS.length - 1) { tutorialStep++; renderTutorialStep(); }
    else closeTutorial();
});
document.getElementById('tutorial-prev-btn').addEventListener('click', () => {
    if (tutorialStep > 0) { tutorialStep--; renderTutorialStep(); }
});
document.getElementById('tutorial-close-btn').addEventListener('click', closeTutorial);
document.getElementById('tutorial-backdrop').addEventListener('click', closeTutorial);
document.getElementById('help-btn').addEventListener('click', () => openTutorial(0));

// ────────────────────────────────────────────────────────────
// 10. DISCONNECT
// ────────────────────────────────────────────────────────────
document.getElementById('disconnect-btn').addEventListener('click', () => {
    if (!confirm('Disconnect your Pollinations account from this browser?')) return;
    clearStoredKey();
    pollinationsKey = null;
    delete providerKeys.pollinations;
    stopAIPlayer();
    stopBuddy();
    document.getElementById('disconnect-btn').style.display = 'none';
    document.getElementById('auth-overlay').classList.remove('hidden');
    tts.interrupt('Disconnected. Connect your Pollinations account to continue.');
});

// ────────────────────────────────────────────────────────────
// 11. TRAINING DATA (cached)
// ────────────────────────────────────────────────────────────
let _trainingCache = null;
async function loadTrainingData() {
    if (_trainingCache) return _trainingCache;
    let t1 = '', t2 = '';
    try { t1 = await (await fetch('./quick-fox-085gw.txt')).text(); } catch {}
    try { t2 = await (await fetch('./brisk-spark-08poq.txt')).text(); } catch {}
    _trainingCache = { t1, t2 };
    return _trainingCache;
}

// ────────────────────────────────────────────────────────────
// 12. SCREEN CAPTURE (single persistent video element)
// ────────────────────────────────────────────────────────────
let _captureVideo = null;
let _lastFrameHash = null;
let _identicalFrameCount = 0;

async function captureScreen(stream) {
    if (!stream) return null;
    try {
        if (!_captureVideo) {
            _captureVideo = document.createElement('video');
            _captureVideo.muted = true;
            _captureVideo.playsInline = true;
        }
        if (_captureVideo.srcObject !== stream) {
            _captureVideo.srcObject = stream;
            await _captureVideo.play();
            await new Promise(resolve => {
                if (_captureVideo.readyState >= 2) { resolve(); return; }
                _captureVideo.onloadedmetadata = resolve;
            });
        }
        const w = _captureVideo.videoWidth  || 640;
        const h = _captureVideo.videoHeight || 480;
        const tmp = document.createElement('canvas');
        tmp.width  = Math.min(w, 1280);
        tmp.height = Math.round(h * (tmp.width / w));
        tmp.getContext('2d').drawImage(_captureVideo, 0, 0, tmp.width, tmp.height);
        return tmp.toDataURL('image/jpeg', 0.72);
    } catch (err) {
        console.error('Screen capture error:', err);
        return null;
    }
}

// Quick perceptual hash of a data URL (sample 16 pixels)
function quickHash(dataUrl) {
    if (!dataUrl) return '';
    return dataUrl.slice(dataUrl.length - 200);
}

function isFrameIdentical(dataUrl) {
    const h = quickHash(dataUrl);
    if (h === _lastFrameHash) {
        _identicalFrameCount++;
        return _identicalFrameCount >= IDLE_FRAME_SKIP;
    }
    _lastFrameHash = h;
    _identicalFrameCount = 0;
    return false;
}

// ────────────────────────────────────────────────────────────
// 13. AI PLAYER STATE & THROTTLING
// ────────────────────────────────────────────────────────────
let aiPlayerActive   = false;
let aiStream         = null;
let aiInterval       = null;
let aiMode           = 'auto';
let aiManualState    = 'idle';
let aiPlannedActions = null;
let aiMemory         = [];
let aiNotes          = [];
let userInstruction  = '';
let gameSpeed        = 1;
let playerMovementDetected = false;

// Throttle / back-off state
let _lastThinkTime   = 0;
let _consecutiveErrors = 0;
let _isThinking      = false;   // prevent concurrent calls

// Rapid-fire mode state
let _rapidFireActive = false;
let _rapidFireTurns  = 0;
let _rapidFireInterval = null;

const aiBtn    = document.getElementById('ai-player-btn');
const aiStatus = document.getElementById('ai-status');

const keyMap = {
    ArrowUp:    'ArrowUp',
    ArrowDown:  'ArrowDown',
    ArrowLeft:  'ArrowLeft',
    ArrowRight: 'ArrowRight',
    jump:       'KeyX',
    crouch:     'Space',
    action:     'KeyC',
    start:      'Enter',
};

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
    speedLabel.textContent = `${gameSpeed}×`;
    if (aiInterval) { clearInterval(aiInterval); aiInterval = null; }
    if (aiPlayerActive && aiMode === 'auto') scheduleAILoop();
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
const instructionInput   = document.getElementById('ai-instruction');
const sendInstructionBtn = document.getElementById('send-instruction');
sendInstructionBtn.addEventListener('click', () => {
    const val = instructionInput.value.trim();
    if (val) {
        userInstruction = val;
        updateAIStatus(`📝 Instruction: "${userInstruction}"`);
        instructionInput.value = '';
        tts.speak(`Got it. I'll ${val}.`);
    }
});
instructionInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendInstructionBtn.click(); });

// ────────────────────────────────────────────────────────────
// 14. HELPERS
// ────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

function simulateKeyPress(key, duration = 100) {
    const opts = { code: key, key, bubbles: true, cancelable: true };
    canvas.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    setTimeout(() => {
        canvas.dispatchEvent(new KeyboardEvent('keyup', opts));
        document.dispatchEvent(new KeyboardEvent('keyup', opts));
    }, Math.max(50, duration));
}

function updateAIStatus(message) {
    aiStatus.style.display = 'block';
    aiStatus.textContent   = message;
}

// ────────────────────────────────────────────────────────────
// 15. AI THINK  (with throttle + frame-skip)
// ────────────────────────────────────────────────────────────
async function aiThink() {
    if (_isThinking) return null;

    // Throttle: enforce minimum interval
    const now = Date.now();
    const minInterval = MIN_THINK_INTERVAL_MS * (1 + _consecutiveErrors * 0.5);
    if (now - _lastThinkTime < minInterval) {
        updateAIStatus(`⏳ Cooling down (${Math.ceil((minInterval - (now - _lastThinkTime)) / 1000)}s)…`);
        return null;
    }

    // Pause AI if player is actively providing input
    if (playerMovementDetected) {
        updateAIStatus('⏸ Player is playing — AI paused');
        return null;
    }

    _isThinking = true;
    _lastThinkTime = now;
    updateAIStatus('🤔 Thinking…');

    try {
        const screenshot = await captureScreen(aiStream);
        if (!screenshot) { updateAIStatus('❌ Failed to capture screen'); _isThinking = false; return null; }

        // Skip if frame is identical to recent ones (nothing changed)
        if (isFrameIdentical(screenshot)) {
            updateAIStatus('💤 Screen unchanged — skipping inference');
            _isThinking = false;
            return null;
        }

        const { t1, t2 } = await loadTrainingData();

        const movementCtx = '\n\nNOTE: The player is idle (no input detected).';
        const memoryCtx   = aiMemory.length > 0
            ? `\n\nPAST MISTAKES TO AVOID:\n${aiMemory.slice(-5).map((m, i) => `${i + 1}. ${m}`).join('\n')}`
            : '';
        const notesCtx    = aiNotes.length > 0
            ? `\n\nYOUR PRE-GAME STUDY NOTES:\n${aiNotes.join('\n')}`
            : '';
        const instrCtx    = userInstruction
            ? `\n\nUSER INSTRUCTION (follow this): ${userInstruction}`
            : '';
        const trainingCtx = (t1 || t2)
            ? `\n\nTRAINING DATA:\n=== SET 1 ===\n${t1.slice(0, 3500)}\n\n=== SET 2 ===\n${t2.slice(0, 3500)}`
            : '';

        const systemPrompt = `You are an AI playing Super Mario 64. Analyze the screenshot and decide what actions to take.

GAME OBJECTIVE:
1. Start outside the castle — head to the entrance bridge and go inside
2. Skip dialog by pressing jump (X) or start (Enter) repeatedly
3. Once inside, do NOT run back out — proceed forward
4. Find the first door (no star requirement) and enter it
5. Jump into the painting to start the first level
6. Collect stars to progress

Controls: ArrowUp/Down/Left/Right = move, jump (X) = jump/skip dialog, start (Enter) = pause/skip dialog, crouch (Space) = duck, action (C) = dive/punch/grab
${movementCtx}${memoryCtx}${notesCtx}${instrCtx}${trainingCtx}

Respond with ONLY valid JSON (no markdown fences):
{
  "actions": [["action1"], ["action2", "action3"]],
  "thought": "brief strategy",
  "speech": "short streamer commentary (max 15 words) — omit if rapid_fire is true",
  "mistake": "error noticed or null",
  "rapid_fire": false
}

Set "rapid_fire": true ONLY when you need to make many fast decisions (e.g. mid-jump sequence, navigating a tight corridor, chasing a star). Set it back to false when the situation stabilises.
Max 5 action groups. Valid names: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, jump, start, crouch, action`;

        const base64Image = screenshot.replace(/^data:image\/(png|jpeg);base64,/, '');
        const mimeType    = screenshot.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';

        const rawContent = await callChatAPI([
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What should I do?' },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
                ],
            },
        ], { json: true, max_tokens: 400 });

        const clean    = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const response = JSON.parse(clean);

        updateAIStatus(`💭 ${response.thought}`);
        _consecutiveErrors = 0;

        if (response.mistake && response.mistake !== 'null' && response.mistake !== null) {
            aiMemory.push(response.mistake);
            if (aiMemory.length > 20) aiMemory.shift();
        }

        // Handle rapid-fire mode toggle
        if (response.rapid_fire === true && !_rapidFireActive) {
            enterRapidFire();
        } else if (response.rapid_fire === false && _rapidFireActive) {
            exitRapidFire();
        }

        // AI speech: skip in rapid-fire mode, otherwise queue without overlap
        if (response.speech && !_rapidFireActive) {
            if (tts.isPlaying) {
                tts.drain();   // clear queue but let current finish
                tts.speak(response.speech);
            } else {
                tts.speak(response.speech);
            }
        }

        _isThinking = false;
        return response;

    } catch (err) {
        console.error('AI think error:', err);
        _consecutiveErrors++;
        updateAIStatus(`❌ ${err.message}`);
        if (_consecutiveErrors >= MAX_ERRORS_BEFORE_BACKOFF) {
            updateAIStatus(`⚠ ${_consecutiveErrors} errors — backing off`);
            tts.speak('Having trouble thinking. Backing off for a bit.');
        }
        _isThinking = false;
        return null;
    }
}

// ────────────────────────────────────────────────────────────
// 16. AI EXECUTE
// ────────────────────────────────────────────────────────────
async function aiExecute(response) {
    if (!response?.actions?.length) return;
    const groups = response.actions;
    updateAIStatus(`🎮 Executing ${groups.length} action group${groups.length > 1 ? 's' : ''}…`);

    const windowMs       = 4000 / gameSpeed;
    const actionDuration = Math.max(120, windowMs / groups.length);

    for (let i = 0; i < groups.length; i++) {
        if (!aiPlayerActive) break;
        const group = Array.isArray(groups[i]) ? groups[i] : [groups[i]];
        for (const action of group) {
            const keyCode = keyMap[action];
            if (keyCode) simulateKeyPress(keyCode, Math.max(80, actionDuration * 0.75));
        }
        updateAIStatus(`🎮 [${i + 1}/${groups.length}] ${group.join(' + ')}`);
        await delay(actionDuration);
    }
    updateAIStatus('✅ Done');
}

async function aiThinkAndAct() {
    if (!aiPlayerActive) return;
    const resp = await aiThink();
    if (resp && aiPlayerActive) await aiExecute(resp);
}

// ── Rapid-fire mode ─────────────────────────────────────────────────
function enterRapidFire() {
    if (_rapidFireActive) return;
    _rapidFireActive = true;
    _rapidFireTurns  = 0;
    tts.silence(true);  // kill TTS immediately

    // Clear normal loop, start fast loop
    if (aiInterval) { clearInterval(aiInterval); aiInterval = null; }
    if (_rapidFireInterval) { clearInterval(_rapidFireInterval); }

    // Show indicator
    const ind = document.getElementById('rapid-fire-indicator');
    if (ind) ind.classList.add('active');
    updateAIStatus('⚡ RAPID FIRE — locked in');

    _rapidFireInterval = setInterval(async () => {
        if (!aiPlayerActive || !_rapidFireActive || _isThinking) return;
        _rapidFireTurns++;
        if (_rapidFireTurns >= RAPID_FIRE_MAX_TURNS) {
            exitRapidFire();
            return;
        }
        const ind2 = document.getElementById('rapid-fire-indicator');
        if (ind2) ind2.querySelector('.rf-turns').textContent = `${_rapidFireTurns}/${RAPID_FIRE_MAX_TURNS}`;
        await aiThinkAndAct();
    }, RAPID_FIRE_INTERVAL_MS);
}

function exitRapidFire() {
    if (!_rapidFireActive) return;
    _rapidFireActive = false;
    _rapidFireTurns  = 0;
    tts.silence(false); // re-enable TTS

    if (_rapidFireInterval) { clearInterval(_rapidFireInterval); _rapidFireInterval = null; }

    // Hide indicator
    const ind = document.getElementById('rapid-fire-indicator');
    if (ind) ind.classList.remove('active');

    // Resume normal loop if AI player is still active
    if (aiPlayerActive && aiMode === 'auto') scheduleAILoop();
    tts.speak('Rapid fire mode ended. Back to normal pace.');
    updateAIStatus('✅ Rapid fire ended — resuming normal loop');
}

function scheduleAILoop() {
    const cycle = Math.max(MIN_THINK_INTERVAL_MS, 8000 / gameSpeed);
    aiInterval  = setInterval(async () => {
        if (!aiPlayerActive || _isThinking || _rapidFireActive) return;
        await aiThinkAndAct();
    }, cycle);
}

// ────────────────────────────────────────────────────────────
// 17. TOGGLE AI PLAYER
// ────────────────────────────────────────────────────────────
async function toggleAIPlayer() {
    // Check vision capability first
    if (!providerHasVision()) {
        _pendingAIStart = true;
        showVisionRequiredModal();
        return;
    }
    // Local provider: ensure model is loaded
    if (activeProvider.id === 'local' && _localVLMState !== 'ready') {
        _pendingAIStart = true;
        showLocalModelModal();
        return;
    }

    const key = getActiveKey();
    if (!key && activeProvider.id !== 'local') {
        if (activeProvider.id === 'pollinations') {
            document.getElementById('auth-overlay').classList.remove('hidden');
        } else {
            tts.interrupt(`Please add your ${activeProvider.label} API key in API Settings.`);
            openProviderPanel();
        }
        return;
    }

    if (!aiPlayerActive) {
        try {
            aiStream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 5, max: 10 } },
                audio: false,
            });
        } catch {
            tts.interrupt('Screen sharing was denied. Please try again and select the window showing the game.');
            return;
        }

        aiPlayerActive = true;
        _consecutiveErrors = 0;
        _lastFrameHash = null;
        _identicalFrameCount = 0;
        aiStream.getVideoTracks()[0].addEventListener('ended', stopAIPlayer);

        if (aiMode === 'auto') {
            aiBtn.textContent = '⏹ Stop AI';
            aiBtn.classList.add('active');
            updateAIStatus('🤖 AI Player Active');
            tts.speak('AI player activated. Analyzing the screen now.');
            scheduleAILoop();
            aiThinkAndAct();
        } else {
            aiManualState = 'idle';
            aiBtn.textContent = '🧠 Think';
            aiBtn.classList.add('active');
            updateAIStatus('🤖 Manual Mode — press to think');
        }

    } else {
        aiMode === 'manual' ? handleManualModeClick() : stopAIPlayer();
    }
}

async function handleManualModeClick() {
    if (aiManualState === 'idle') {
        aiManualState = 'thinking';
        aiBtn.textContent = '⏳ Thinking…';
        aiBtn.disabled    = true;
        aiPlannedActions  = await aiThink();
        if (aiPlannedActions) {
            aiManualState = 'ready';
            aiBtn.textContent = '▶ Execute';
            aiBtn.disabled    = false;
            updateAIStatus('✅ Plan ready — press to execute');
        } else {
            aiManualState = 'idle';
            aiBtn.textContent = '🧠 Think';
            aiBtn.disabled    = false;
        }
    } else if (aiManualState === 'ready') {
        aiManualState = 'executing';
        aiBtn.textContent = '⏹ Stop';
        await aiExecute(aiPlannedActions);
        aiManualState = 'idle';
        aiBtn.textContent = '🧠 Think';
        updateAIStatus('💤 Idle — press to think again');
    } else if (aiManualState === 'executing') {
        stopAIPlayer();
    }
}

function stopAIPlayer() {
    aiPlayerActive = false;
    _isThinking    = false;

    // Clean up rapid-fire mode
    if (_rapidFireActive) {
        _rapidFireActive = false;
        _rapidFireTurns  = 0;
        if (_rapidFireInterval) { clearInterval(_rapidFireInterval); _rapidFireInterval = null; }
        const ind = document.getElementById('rapid-fire-indicator');
        if (ind) ind.classList.remove('active');
        tts.silence(false);
    }

    if (aiStream)      { aiStream.getTracks().forEach(t => t.stop()); aiStream = null; }
    if (aiInterval)    { clearInterval(aiInterval); aiInterval = null; }
    if (_captureVideo) { _captureVideo.srcObject = null; }
    aiManualState    = 'idle';
    aiPlannedActions = null;
    aiBtn.textContent = '🤖 AI Play';
    aiBtn.classList.remove('active');
    aiBtn.disabled    = false;
    aiStatus.style.display = 'none';
    tts.speak('AI player stopped.');
}

aiBtn.addEventListener('click', toggleAIPlayer);
document.getElementById('rf-exit-btn')?.addEventListener('click', exitRapidFire);

aiBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (aiPlayerActive) stopAIPlayer();
    aiMode = aiMode === 'auto' ? 'manual' : 'auto';
    const label = aiMode === 'auto' ? 'Auto' : 'Manual';
    aiBtn.textContent = `🤖 AI Play (${label})`;
    tts.interrupt(`Switched to ${label} mode.`);
    setTimeout(() => { if (!aiPlayerActive) aiBtn.textContent = '🤖 AI Play'; }, 2500);
});

// ────────────────────────────────────────────────────────────
// 18. AI BUDDY COACH
// ────────────────────────────────────────────────────────────
let buddyActive   = false;
let buddyInterval = null;
let buddyStream   = null;

const buddyBtn   = document.getElementById('ai-buddy-btn');
const buddyPanel = document.getElementById('buddy-panel');
const buddyText  = document.getElementById('buddy-text');

async function buddyAdvise() {
    if (!buddyActive) return;
    buddyText.textContent = '🤔 Analyzing…';

    const streamToUse = aiStream || buddyStream;
    if (!streamToUse) { buddyText.textContent = '❌ No screen share active!'; return; }

    try {
        const screenshot = await captureScreen(streamToUse);
        if (!screenshot) { buddyText.textContent = '❌ Could not capture screen'; return; }

        const base64Image = screenshot.replace(/^data:image\/(png|jpeg);base64,/, '');
        const mimeType    = screenshot.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';

        const rawContent = await callChatAPI([
            {
                role: 'system',
                content: `You are an AI Buddy Coach for Super Mario 64. Give helpful, friendly advice in 2 sentences max.
Respond with ONLY valid JSON (no markdown fences):
{"text": "advice", "speech": "conversational version (max 20 words)"}`,
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What advice do you have?' },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
                ],
            },
        ], { json: true, max_tokens: 200 });

        const clean  = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const advice = JSON.parse(clean);
        buddyText.textContent = `💬 ${advice.text}`;
        if (advice.speech) tts.speak(advice.speech);

    } catch (err) {
        buddyText.textContent = `❌ ${err.message}`;
    }
}

async function toggleBuddy() {
    const key = getActiveKey();
    if (!key) {
        if (activeProvider.id === 'pollinations') document.getElementById('auth-overlay').classList.remove('hidden');
        else openProviderPanel();
        return;
    }

    if (!buddyActive) {
        if (!aiStream && !buddyStream) {
            try {
                buddyStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { frameRate: { ideal: 3, max: 5 } },
                    audio: false,
                });
                buddyStream.getVideoTracks()[0].addEventListener('ended', stopBuddy);
            } catch {
                tts.interrupt('Screen sharing was denied. Please try again.');
                return;
            }
        }

        buddyActive = true;
        buddyBtn.classList.add('active');
        buddyBtn.textContent = '⏹ Stop Buddy';
        buddyPanel.style.display = 'block';
        buddyText.textContent = "👋 Hey! I'm watching your gameplay!";
        buddyInterval = setInterval(buddyAdvise, 15000);
        setTimeout(buddyAdvise, 2000);

    } else {
        stopBuddy();
    }
}

function stopBuddy() {
    buddyActive = false;
    buddyBtn.classList.remove('active');
    buddyBtn.textContent = '🧡 Buddy';
    buddyPanel.style.display = 'none';
    if (buddyInterval) { clearInterval(buddyInterval); buddyInterval = null; }
    if (buddyStream && !aiPlayerActive) {
        buddyStream.getTracks().forEach(t => t.stop());
        buddyStream = null;
        if (_captureVideo) _captureVideo.srcObject = null;
    }
}

buddyBtn.addEventListener('click', toggleBuddy);

// ────────────────────────────────────────────────────────────
// 19. MEMORY VIEWER
// ────────────────────────────────────────────────────────────
document.getElementById('view-memory-btn').addEventListener('click', () => {
    const panel    = document.getElementById('memory-panel');
    const backdrop = document.getElementById('memory-backdrop');
    const content  = document.getElementById('memory-content');

    let text = '=== AI STUDY NOTES ===\n';
    text += aiNotes.length > 0
        ? aiNotes.map((n, i) => `${i + 1}. ${n}`).join('\n')
        : 'No study notes yet. Click Study to generate them.';
    text += '\n\n=== MISTAKES & LEARNINGS ===\n';
    text += aiMemory.length > 0
        ? aiMemory.map((m, i) => `${i + 1}. ${m}`).join('\n')
        : 'No mistakes recorded yet.';

    content.textContent = text;
    panel.style.display = 'block';
    backdrop.classList.add('open');
});

document.getElementById('close-memory-btn').addEventListener('click', () => {
    document.getElementById('memory-panel').style.display = 'none';
    document.getElementById('memory-backdrop').classList.remove('open');
});
document.getElementById('memory-backdrop').addEventListener('click', () => {
    document.getElementById('memory-panel').style.display = 'none';
    document.getElementById('memory-backdrop').classList.remove('open');
});

// ────────────────────────────────────────────────────────────
// 20. PRE-GAME STUDY NOTES
// ────────────────────────────────────────────────────────────
document.getElementById('pregame-notes-btn').addEventListener('click', async () => {
    if (!getActiveKey()) {
        if (activeProvider.id === 'pollinations') document.getElementById('auth-overlay').classList.remove('hidden');
        else openProviderPanel();
        return;
    }

    const btn = document.getElementById('pregame-notes-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Studying…';
    tts.speak('Starting to study the SM64 guide. This will take a moment.');

    try {
        const { t1, t2 } = await loadTrainingData();

        const rawContent = await callChatAPI([
            {
                role: 'system',
                content: `Analyze these Super Mario 64 gameplay guides and extract 10-14 concise, actionable strategy notes.
Respond with ONLY valid JSON (no markdown fences):
{"notes": ["note1", "note2", ...]}`,
            },
            {
                role: 'user',
                content: `Guides:\n\n=== GUIDE 1 ===\n${t1.slice(0, 5000)}\n\n=== GUIDE 2 ===\n${t2.slice(0, 5000)}`,
            },
        ], { json: true, max_tokens: 700 });

        const clean  = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const result = JSON.parse(clean);
        aiNotes = result.notes || [];

        btn.textContent = `✓ ${aiNotes.length} Notes Ready`;
        btn.style.background = '#2e7d32';
        tts.interrupt(`Done! Generated ${aiNotes.length} strategy notes.`);
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = '📚 Study';
            btn.style.background = '';
        }, 3000);

        document.getElementById('view-memory-btn').click();

    } catch (err) {
        console.error('Study notes error:', err);
        btn.textContent = '❌ Error';
        btn.style.background = '#b71c1c';
        tts.interrupt('Study failed. Please try again.');
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = '📚 Study';
            btn.style.background = '';
        }, 3000);
    }
});

// ────────────────────────────────────────────────────────────
// 21. PERSISTENT SAVE (Emscripten IDBFS)
// ────────────────────────────────────────────────────────────
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
            window.addEventListener('beforeunload', () => { try { Module.FS.syncfs(false, () => {}); } catch {} });
            document.addEventListener('visibilitychange', () => { if (document.hidden) window.saveNow(); });
        }
    } catch (err) { console.error('save init error:', err); }
};

// ────────────────────────────────────────────────────────────
// 22. BOOT
// ────────────────────────────────────────────────────────────
restoreProviderState();
fetchVisionModels();
initAuth();
renderControlsGuide(null);   // show static controls immediately
// Voices may not be loaded yet — wait for them then re-render tutorial if open
window.speechSynthesis?.addEventListener('voiceschanged', () => {});

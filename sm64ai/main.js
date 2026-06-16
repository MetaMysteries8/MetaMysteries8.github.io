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

// Publishable App Key (BYOP client_id). Safe to ship client-side. Passed as
// `client_id` on the authorize URL so the consent screen shows this app's name
// and author, attributes traffic for tier upgrades, and credits developer
// earnings on inference users spend. NOT used as a standalone API key.
const POLLINATIONS_APP_KEY    = 'pk_JBemDN4TzwP8Ls2v';

// OpenRouter — OpenAI-compatible aggregator
const OPENROUTER_API_BASE     = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODELS_URL   = 'https://openrouter.ai/api/v1/models';

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

// Vision-bridge: SmolVLM captions the screen, text sent to visionless cloud LLM
// Caption is intentionally short to save tokens on the cloud side
const BRIDGE_CAPTION_MAX_TOKENS = 80;

// ── SM64 Memory Reader ──────────────────────────────────────
// N64 NTSC US RAM addresses for gMarioStates[0] struct
// The WASM port maps N64 RAM into a linear buffer; we find the base
// by scanning Module.HEAPU8 for the known struct layout.
//
// All offsets are relative to the N64 RAM base (0x80000000 stripped).
// We read them as: Module.HEAP32[(base + offset) >> 2]  (32-bit)
//              or: Module.HEAPU8[base + offset]          (8-bit)
//
const N64_RAM_ADDR = {
    // gMarioStates[0] fields (NTSC US)
    MARIO_ACTION:    0x0033B17C,  // u32  — current action ID
    MARIO_X:         0x0033B1AC,  // f32  — world X
    MARIO_Y:         0x0033B1B0,  // f32  — world Y
    MARIO_Z:         0x0033B1B4,  // f32  — world Z
    MARIO_SPEED:     0x0033B1C4,  // f32  — horizontal speed
    MARIO_COINS:     0x0033B218,  // s16  — coins
    MARIO_STARS:     0x0033B21A,  // s16  — stars collected
    MARIO_LIVES:     0x0033B21D,  // s8   — lives
    MARIO_HEALTH:    0x0033B21E,  // s16  — health (upper byte = wedges, 0x0880 = full)
    MARIO_CAP_TIMER: 0x0033B226,  // u16  — cap timer
    MARIO_LEVEL:     0x0033B249,  // u8   — current level number
    MARIO_AREA:      0x0033B24A,  // u8   — current area
    // Camera
    CAM_X:           0x0033C6A4,  // f32
    CAM_Y:           0x0033C6A8,  // f32
    CAM_Z:           0x0033C6AC,  // f32
    CAM_H_ANGLE:     0x0033C6E4,  // s16  — horizontal angle
};

// Human-readable level names
const LEVEL_NAMES = {
    1:'Main Menu', 4:'Castle Grounds', 6:'Bob-omb Battlefield', 7:'Whomp\'s Fortress',
    8:'Jolly Roger Bay', 9:'Cool Cool Mountain', 10:'Big Boo\'s Haunt', 11:'Hazy Maze Cave',
    12:'Lethal Lava Land', 13:'Shifting Sand Land', 14:'Dire Dire Docks', 15:'Snowman\'s Land',
    16:'Wet-Dry World', 17:'Tall Tall Mountain', 18:'Tiny-Huge Island', 19:'Tick Tock Clock',
    20:'Rainbow Ride', 24:'Bowser in the Dark World', 27:'Bowser in the Fire Sea',
    28:'Bowser in the Sky', 29:'Peach\'s Secret Slide', 30:'Cavern of the Metal Cap',
    33:'Vanish Cap Under the Moat', 34:'Winged Mario Over the Rainbow',
    36:'Castle Inside', 37:'Courtyard',
};

// Action ID → readable name (partial map for most common states)
const ACTION_NAMES = {
    0x00000000:'idle', 0x00000001:'start jump', 0x00000002:'jump', 0x00000004:'double jump',
    0x00000008:'triple jump', 0x00000010:'backflip', 0x00000020:'steep jump',
    0x00000040:'wall kick', 0x00000080:'side flip', 0x00000100:'long jump',
    0x00000200:'water jump', 0x00000400:'dive', 0x00000800:'freefall',
    0x00001000:'slide jump', 0x00002000:'air throw', 0x00004000:'twirl jump',
    0x00008000:'ground pound', 0x00010000:'braking', 0x00020000:'crouching',
    0x00040000:'crawling', 0x00080000:'stop slide', 0x00100000:'slide kick',
    0x00200000:'hold braking', 0x00400000:'hold idle', 0x00800000:'hold heavy idle',
    0x01000000:'walking', 0x02000000:'hold walking', 0x04000000:'turning',
    0x08000000:'finish turning', 0x10000000:'sliding', 0x20000000:'hold sliding',
    0x40000000:'riding shell', 0x80000000:'swimming',
};

// State of the memory reader
let _wasmBase = -1;          // offset in HEAPU8 where N64 RAM starts
let _gameState = null;       // last successfully read state object
let _gameStateReady = false; // true once base is found

function _findWasmBase() {
    // Strategy: scan HEAPU8 for a pattern that looks like the Mario struct.
    // The health field at 0x33B21E is typically 0x0880 (full health) on startup.
    // We look for that 16-bit value at the expected offset from candidate bases.
    // Emscripten typically places N64 RAM at a fixed offset (often 0x10000 or 0x20000).
    // We try a range of likely bases.
    if (!Module.HEAPU8) return -1;
    const heap = Module.HEAPU8;
    // Try common Emscripten base offsets for the N64 RAM region
    const candidates = [];
    for (let base = 0x10000; base < Math.min(heap.length, 0x800000); base += 0x10000) {
        candidates.push(base);
    }
    for (const base of candidates) {
        const healthOff = base + N64_RAM_ADDR.MARIO_HEALTH;
        if (healthOff + 2 > heap.length) continue;
        // Health should be between 0x0100 (1 wedge) and 0x0880 (full)
        const health = (heap[healthOff] << 8) | heap[healthOff + 1];
        if (health >= 0x0100 && health <= 0x0880) {
            // Also check lives (should be 1-99)
            const livesOff = base + N64_RAM_ADDR.MARIO_LIVES;
            if (livesOff >= heap.length) continue;
            const lives = heap[livesOff];
            if (lives >= 1 && lives <= 99) {
                console.log(`[SM64 Memory] Found WASM base at 0x${base.toString(16)} (health=0x${health.toString(16)}, lives=${lives})`);
                return base;
            }
        }
    }
    return -1;
}

function readGameState() {
    if (!_gameStateReady) {
        // Try to find base if not yet found
        if (_wasmBase === -1) {
            _wasmBase = _findWasmBase();
            if (_wasmBase === -1) return null;
        }
        _gameStateReady = true;
    }

    try {
        const heap8  = Module.HEAPU8;
        const heap32 = Module.HEAP32;
        if (!heap8 || !heap32) return null;

        const b = _wasmBase;

        // Helper: read float at N64 address
        const readF32 = (addr) => {
            const off = (b + addr) >> 2;
            if (off * 4 + 4 > heap8.length) return 0;
            // N64 is big-endian; WASM is little-endian — swap bytes
            const raw = heap8.slice(b + addr, b + addr + 4);
            const swapped = new Uint8Array([raw[3], raw[2], raw[1], raw[0]]);
            return new DataView(swapped.buffer).getFloat32(0);
        };

        // Helper: read unsigned 16-bit big-endian
        const readU16 = (addr) => {
            const off = b + addr;
            if (off + 2 > heap8.length) return 0;
            return (heap8[off] << 8) | heap8[off + 1];
        };

        // Helper: read signed 16-bit big-endian
        const readS16 = (addr) => {
            const v = readU16(addr);
            return v >= 0x8000 ? v - 0x10000 : v;
        };

        // Helper: read unsigned 8-bit
        const readU8 = (addr) => {
            const off = b + addr;
            if (off >= heap8.length) return 0;
            return heap8[off];
        };

        // Helper: read unsigned 32-bit big-endian
        const readU32 = (addr) => {
            const off = b + addr;
            if (off + 4 > heap8.length) return 0;
            return ((heap8[off] << 24) | (heap8[off+1] << 16) | (heap8[off+2] << 8) | heap8[off+3]) >>> 0;
        };

        const actionId = readU32(N64_RAM_ADDR.MARIO_ACTION);
        const healthRaw = readU16(N64_RAM_ADDR.MARIO_HEALTH);
        const healthWedges = (healthRaw >> 8) & 0xFF; // upper byte = wedge count (max 8)
        const levelId = readU8(N64_RAM_ADDR.MARIO_LEVEL);

        const state = {
            x:       Math.round(readF32(N64_RAM_ADDR.MARIO_X)),
            y:       Math.round(readF32(N64_RAM_ADDR.MARIO_Y)),
            z:       Math.round(readF32(N64_RAM_ADDR.MARIO_Z)),
            speed:   Math.round(readF32(N64_RAM_ADDR.MARIO_SPEED) * 10) / 10,
            coins:   readS16(N64_RAM_ADDR.MARIO_COINS),
            stars:   readS16(N64_RAM_ADDR.MARIO_STARS),
            lives:   readU8(N64_RAM_ADDR.MARIO_LIVES),
            health:  healthWedges,  // 0-8 wedges
            capTimer: readU16(N64_RAM_ADDR.MARIO_CAP_TIMER),
            levelId,
            levelName: LEVEL_NAMES[levelId] || `Level ${levelId}`,
            area:    readU8(N64_RAM_ADDR.MARIO_AREA),
            actionId,
            actionName: ACTION_NAMES[actionId] || `action_0x${actionId.toString(16)}`,
            camX:    Math.round(readF32(N64_RAM_ADDR.CAM_X)),
            camY:    Math.round(readF32(N64_RAM_ADDR.CAM_Y)),
            camZ:    Math.round(readF32(N64_RAM_ADDR.CAM_Z)),
            camAngle: readS16(N64_RAM_ADDR.CAM_H_ANGLE),
        };

        // Sanity check: lives must be plausible
        if (state.lives < 0 || state.lives > 99) return null;
        if (state.stars < 0 || state.stars > 120) return null;

        _gameState = state;
        updateMemoryHUD(state);
        return state;
    } catch (err) {
        console.warn('[SM64 Memory] Read error:', err);
        return null;
    }
}

function gameStateToText(state) {
    if (!state) return '';
    const hp = '❤'.repeat(Math.max(0, state.health)) + '🖤'.repeat(Math.max(0, 8 - state.health));
    return [
        `LIVE GAME STATE (read from WASM memory):`,
        `  Level: ${state.levelName} (area ${state.area})`,
        `  Mario pos: X=${state.x}, Y=${state.y}, Z=${state.z}`,
        `  Speed: ${state.speed} units/frame | Action: ${state.actionName}`,
        `  Health: ${hp} (${state.health}/8 wedges)`,
        `  Stars: ${state.stars} | Coins: ${state.coins} | Lives: ${state.lives}`,
        `  Camera: X=${state.camX}, Y=${state.camY}, Z=${state.camZ} (angle ${state.camAngle})`,
        state.capTimer > 0 ? `  Cap timer: ${state.capTimer} frames remaining` : '',
    ].filter(Boolean).join('\n');
}

function updateMemoryHUD(state) {
    const chip = document.getElementById('memory-hud-chip');
    if (chip && state) {
        chip.textContent = `⭐${state.stars} ❤${state.health}/8 🪙${state.coins} 🍄${state.lives} | ${state.levelName}`;
        chip.title = gameStateToText(state);
        chip.style.display = 'block';
    }
    // Feed the broadcast-style streamer overlay too (cheap, only paints when visible)
    if (typeof updateStreamerOverlay === 'function') updateStreamerOverlay(state);
}

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
                    ...(opts.tools ? { tools: opts.tools, tool_choice: opts.tool_choice || 'auto' } : {}),
                    ...(opts.json && !opts.tools ? { response_format: { type: 'json_object' } } : {}) },
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
                    ...(opts.tools ? { tools: opts.tools, tool_choice: opts.tool_choice || 'auto' } : {}),
                    ...(opts.json && !opts.tools ? { response_format: { type: 'json_object' } } : {}) },
            };
        },
    },
    openrouter: {
        id:    'openrouter',
        label: 'OpenRouter',
        icon:  '🛰️',
        hasVision: true,           // gated per-model; vision list fetched live
        keyLabel: 'OpenRouter API Key',
        keyPlaceholder: 'sk-or-…',
        modelsUrl: OPENROUTER_MODELS_URL,
        defaultModel: 'openai/gpt-4o-mini',
        visionModels: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet',
                       'google/gemini-2.0-flash-001', 'x-ai/grok-2-vision-1212',
                       'qwen/qwen2.5-vl-72b-instruct', 'meta-llama/llama-3.2-90b-vision-instruct'],
        buildRequest(messages, model, key, opts) {
            return {
                url: `${OPENROUTER_API_BASE}/chat/completions`,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                    'HTTP-Referer': location.origin,
                    'X-Title': 'SM64 AI Player',
                },
                body: { model, messages, max_tokens: opts.max_tokens || 800,
                    ...(opts.tools ? { tools: opts.tools, tool_choice: opts.tool_choice || 'auto' } : {}),
                    ...(opts.json && !opts.tools ? { response_format: { type: 'json_object' } } : {}) },
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
                    ...(opts.tools ? { tools: opts.tools, tool_choice: opts.tool_choice || 'auto' } : {}),
                    ...(opts.json && !opts.tools ? { response_format: { type: 'json_object' } } : {}) },
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
                    ...(opts.tools ? { tools: opts.tools, tool_choice: opts.tool_choice || 'auto' } : {}),
                    ...(opts.json && !opts.tools ? { response_format: { type: 'json_object' } } : {}) },
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
    // Local provider: route through in-browser SmolVLM (full VQA mode)
    if (activeProvider.id === 'local') {
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
        const sysMsg = messages.find(m => m.role === 'system');
        const fullPrompt = (sysMsg ? sysMsg.content.slice(0, 500) + '\n\n' : '') + textPrompt.trim();
        if (imageUrl) return await callLocalVision(imageUrl, fullPrompt);
        throw new Error('Local vision model requires an image');
    }

    // Vision-bridge mode: provider has no vision, but SmolVLM is loaded
    // Use the cached background caption (updated every 2.5s) instead of blocking
    if (!providerHasVision() && _localVLMState === 'ready' && !opts._bridgeCaption) {
        // Extract image from messages
        const userMsg = messages.find(m => m.role === 'user');
        let imageUrl = null;
        const textParts = [];
        if (Array.isArray(userMsg?.content)) {
            for (const p of userMsg.content) {
                if (p.type === 'image_url') imageUrl = p.image_url.url;
                if (p.type === 'text')      textParts.push(p.text);
            }
        }
        if (imageUrl) {
            // Use cached bridge caption if available, otherwise fallback to live
            let caption = _bridgeCaption;
            if (!caption) {
                // First call or cache missed — do one live caption (still slow, but only once)
                const prompt = buildBridgePrompt();
                const base64 = imageUrl.replace(/^data:image\/(png|jpeg);base64,/, '');
                const mime = imageUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
                const dataUrl = `data:${mime};base64,${base64}`;
                caption = await callLocalVision(dataUrl, prompt, { maxTokens: 60, downscale: 384 });
                _bridgeCaption = caption;
                _bridgeCaptionHash = quickHash(imageUrl);
            }

            // Step 2: Replace image with caption text in messages for cloud LLM
            const bridgedMessages = messages.map(m => {
                if (m.role !== 'user') return m;
                const textContent = textParts.join(' ');
                return {
                    role: 'user',
                    content: `[SCREEN DESCRIPTION from local vision model]: ${caption}\n\n${textContent}`,
                };
            });

            // Step 3: Call cloud LLM with text-only messages
            return await callChatAPI(bridgedMessages, { ...opts, _bridgeCaption: true });
        }
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
    // Tool-calling callers need the full assistant message (tool_calls + content)
    if (opts.returnRaw) return data.choices?.[0]?.message || {};
    return data.choices?.[0]?.message?.content || '';
}

// ── Memory tool (OpenAI/function-calling) ────────────────────
// The model can call this on demand to pull fresh RAM state instead of
// relying solely on the snapshot injected into the prompt.
const GAME_STATE_TOOL = {
    type: 'function',
    function: {
        name: 'get_game_state',
        description: 'Read live Super Mario 64 state directly from game RAM: ' +
            'Mario position (x,y,z), facing/action, horizontal speed, health wedges, ' +
            'stars, coins, lives, current level/area, and camera. Call this whenever you ' +
            'need precise, up-to-the-moment numbers (e.g. to judge distance, height, or speed).',
        parameters: { type: 'object', properties: {}, required: [] },
    },
};

// Providers whose chat endpoint accepts OpenAI-style `tools`
const TOOL_CAPABLE_PROVIDERS = new Set(['pollinations', 'openai', 'openrouter', 'gemini', 'custom']);

// Per-model tool support (populated from model metadata when available).
// null = unknown (we optimistically try once, then remember the result).
const _modelToolSupport = {};

function modelMaySupportTools(model) {
    if (!TOOL_CAPABLE_PROVIDERS.has(activeProvider.id)) return false;
    if (activeProvider.id === 'local') return false;
    const known = _modelToolSupport[model];
    return known !== false; // try when true or unknown
}

// Run one chat turn that may use the get_game_state tool.
// Falls back transparently to a plain call if the provider/model rejects tools.
async function callChatWithTools(messages, opts = {}) {
    const model = opts.model || getSelectedModel();
    if (!modelMaySupportTools(model)) {
        return await callChatAPI(messages, opts);
    }

    try {
        const convo = [...messages];
        let rounds = 0;
        while (rounds++ < 3) {
            const msg = await callChatAPI(convo, {
                ...opts, returnRaw: true, tools: [GAME_STATE_TOOL], tool_choice: 'auto',
            });
            _modelToolSupport[model] = true; // it accepted the tools field

            const calls = msg.tool_calls || [];
            if (!calls.length) return msg.content || '';

            convo.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
            for (const call of calls) {
                let result = 'No game state available yet.';
                if (call.function?.name === 'get_game_state') {
                    const st = readGameState();
                    result = st ? gameStateToText(st) : 'Game state not readable yet (still booting).';
                }
                convo.push({ role: 'tool', tool_call_id: call.id, content: result });
            }
        }
        // Too many tool rounds — make a final plain pass
        return await callChatAPI(convo, opts);
    } catch (err) {
        // Most likely the model/provider doesn't accept tools — remember & retry plainly
        if (/tool|function|unsupported|invalid|400/i.test(err.message || '')) {
            _modelToolSupport[model] = false;
            console.warn(`[Tools] ${model} rejected tools — falling back to injection:`, err.message);
            return await callChatAPI(messages, opts);
        }
        throw err;
    }
}

// ────────────────────────────────────────────────────────────
// 3b. LOCAL VISION MODEL  (SmolVLM-256M via Transformers.js)
// ────────────────────────────────────────────────────────────
//
// Activated when the active provider has hasVision !== true.
// Loads SmolVLM-256M-Instruct in-browser via WebGPU (or WASM fallback).
// Provides callLocalVision(screenshotDataUrl, prompt) → string
//

// SmolVLM uses the low-level AutoProcessor + AutoModelForVision2Seq API,
// NOT the pipeline() API (which doesn't support image-text-to-text in v3).
let _localVLMProcessor = null;  // AutoProcessor instance
let _localVLMModel     = null;  // AutoModelForVision2Seq instance
let _localVLMState     = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
let _localVLMError     = null;

// Check if current provider has vision
function providerHasVision() {
    if (activeProvider.id === 'local') return true;  // local IS vision
    if (activeProvider.id === 'custom') return PROVIDERS.custom.hasVision === true;
    // OpenRouter: vision depends on the specific model the user picked
    if (activeProvider.id === 'openrouter') return openrouterSelectedHasVision();
    return activeProvider.hasVision === true;
}

// Dynamically load Transformers.js CDN script once
// SmolVLM needs AutoProcessor + AutoModelForVision2Seq (not pipeline)
function loadTransformersJS() {
    return new Promise((resolve, reject) => {
        if (window.__transformers__) { resolve(window.__transformers__); return; }
        if (document.getElementById('transformers-js-script')) {
            // Already injecting — wait for it to finish
            const wait = setInterval(() => {
                if (window.__transformers__) { clearInterval(wait); resolve(window.__transformers__); }
            }, 200);
            return;
        }
        const s = document.createElement('script');
        s.id   = 'transformers-js-script';
        s.type = 'module';
        // Import the full set of classes needed for SmolVLM
        s.textContent = `
            import {
                AutoProcessor,
                AutoModelForVision2Seq,
                RawImage,
                env
            } from '${LOCAL_VLM_CDN}';
            env.allowLocalModels = false;
            window.__transformers__ = { AutoProcessor, AutoModelForVision2Seq, RawImage, env };
        `;
        s.onerror = () => reject(new Error('Failed to load Transformers.js from CDN'));
        document.head.appendChild(s);
        const wait = setInterval(() => {
            if (window.__transformers__) { clearInterval(wait); resolve(window.__transformers__); }
        }, 200);
        setTimeout(() => { clearInterval(wait); reject(new Error('Transformers.js load timeout (90s)')); }, 90000);
    });
}

async function initLocalVLM(onProgress) {
    if (_localVLMState === 'ready') return true;
    if (_localVLMState === 'loading') return false;
    _localVLMState = 'loading';
    _localVLMError = null;

    try {
        onProgress?.('Loading Transformers.js…', 5);
        const { AutoProcessor, AutoModelForVision2Seq, env } = await loadTransformersJS();

        // Use WebGPU if available, fall back to WASM
        const device = (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm';
        onProgress?.(`Downloading SmolVLM-256M (~400 MB) via ${device.toUpperCase()}…`, 10);

        const progressCb = (info) => {
            if (info.status === 'progress' && typeof info.progress === 'number') {
                const pct = Math.round(10 + info.progress * 0.85);
                onProgress?.(`Downloading… ${Math.round(info.progress)}%`, pct);
            } else if (info.status === 'initiate') {
                onProgress?.(`Fetching ${info.file || 'model files'}…`, 12);
            } else if (info.status === 'done') {
                onProgress?.(`Loaded ${info.file || 'file'}`, 90);
            }
        };

        // Load processor (tokenizer + image processor)
        onProgress?.('Loading processor…', 8);
        _localVLMProcessor = await AutoProcessor.from_pretrained(LOCAL_VLM_MODEL, {
            progress_callback: progressCb,
        });

        // Load model with per-component dtypes for best compat
        // embed_tokens: fp32 avoids NaN on devices with limited fp16 support
        // vision_encoder + decoder: q4 for WASM (small/fast), fp16 for WebGPU
        const dtype = device === 'webgpu'
            ? { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'fp16' }
            : { embed_tokens: 'fp32', vision_encoder: 'q4',   decoder_model_merged: 'q4'   };

        const tryLoadModel = async (dtypeArg) => AutoModelForVision2Seq.from_pretrained(
            LOCAL_VLM_MODEL,
            { dtype: dtypeArg, device, progress_callback: progressCb }
        );

        try {
            _localVLMModel = await tryLoadModel(dtype);
        } catch (dtypeErr) {
            console.warn('[SmolVLM] dtype failed, retrying with fp32 everywhere:', dtypeErr.message);
            onProgress?.('Retrying with fp32 (broader compat)…', 20);
            _localVLMModel = await tryLoadModel('fp32');
        }

        _localVLMState = 'ready';
        onProgress?.('Local vision model ready! ✅', 100);

        // Warmup: do a dummy inference so the first real caption isn't laggy
        try {
            const { RawImage } = window.__transformers__;
            const warmImg = new RawImage(new Uint8ClampedArray(224 * 224 * 4), 224, 224);
            const warmMsgs = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'hi' }] }];
            const warmPrompt = _localVLMProcessor.apply_chat_template(warmMsgs, { add_generation_prompt: true });
            const warmInputs = await _localVLMProcessor(warmPrompt, [warmImg], { do_image_splitting: false });
            await _localVLMModel.generate({ ...warmInputs, max_new_tokens: 1 });
        } catch (warmErr) {
            console.warn('[SmolVLM] Warmup failed (non-critical):', warmErr.message);
        }

        // Start background captioning loop for bridge mode
        startBridgeCaptionLoop();

        return true;
    } catch (err) {
        console.error('Local VLM init error:', err);
        _localVLMState = 'error';
        _localVLMError = err.message;
        onProgress?.(`❌ Error: ${err.message}`, -1);
        return false;
    }
}

// ── Background bridge captioning ─────────────────────────────
let _bridgeCaption = null;
let _bridgeCaptionHash = null;
let _bridgeCaptionLoopId = null;

function startBridgeCaptionLoop() {
    if (_bridgeCaptionLoopId) return;
    _bridgeCaptionLoopId = setInterval(async () => {
        if (!aiPlayerActive && !buddyActive) return;
        if (!aiStream && !buddyStream) return;
        try {
            const stream = aiStream || buddyStream;
            const screenshot = await captureScreen(stream);
            if (!screenshot) return;
            const hash = quickHash(screenshot);
            if (hash === _bridgeCaptionHash) return; // unchanged
            _bridgeCaptionHash = hash;
            const prompt = buildBridgePrompt();
            const base64 = screenshot.replace(/^data:image\/(png|jpeg);base64,/, '');
            const mime = screenshot.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
            const dataUrl = `data:${mime};base64,${base64}`;
            _bridgeCaption = await callLocalVision(dataUrl, prompt, { maxTokens: 60, downscale: 384 });
        } catch (err) {
            // Silent fail — bridge is best-effort
        }
    }, 2500); // refresh every 2.5s
}

function stopBridgeCaptionLoop() {
    if (_bridgeCaptionLoopId) { clearInterval(_bridgeCaptionLoopId); _bridgeCaptionLoopId = null; }
    _bridgeCaption = null;
    _bridgeCaptionHash = null;
}

function buildBridgePrompt() {
    const state = _gameState;
    const ctx = state
        ? `Mario is at ${state.levelName}, pos(${state.x},${state.y},${state.z}), action:${state.actionName}, speed:${state.speed}, health:${state.health}/8, stars:${state.stars}, coins:${state.coins}`
        : '';
    return `Describe this SM64 screenshot in ONE sentence. ${ctx} Focus: Mario's action, nearby enemies/obstacles, and HUD.`;
}

async function callLocalVision(screenshotDataUrl, textPrompt, opts = {}) {
    if (_localVLMState !== 'ready' || !_localVLMProcessor || !_localVLMModel) {
        throw new Error('Local vision model not ready');
    }
    const { RawImage } = window.__transformers__;

    // Load the screenshot into a RawImage
    let image = await RawImage.fromURL(screenshotDataUrl);

    // Downscale large screenshots for speed (SmolVLM expects ~224-384)
    const targetSize = opts.downscale || 384;
    if (image.width > targetSize || image.height > targetSize) {
        image = await image.resize(targetSize, targetSize);
    }

    // Build chat-style message for SmolVLM
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'image' },
                { type: 'text', text: textPrompt },
            ],
        },
    ];

    // Apply chat template to get the prompt string
    const prompt = _localVLMProcessor.apply_chat_template(messages, {
        add_generation_prompt: true,
    });

    // Tokenise + process image
    const inputs = await _localVLMProcessor(prompt, [image], {
        do_image_splitting: false,
    });

    // Generate
    const maxTokens = opts.maxTokens || 120;
    const generatedIds = await _localVLMModel.generate({
        ...inputs,
        max_new_tokens: maxTokens,
    });

    // Decode only the newly generated tokens (strip the input prefix)
    const inputLen = inputs.input_ids.dims.at(-1);
    const newIds   = generatedIds.slice(null, [inputLen, null]);
    const decoded  = _localVLMProcessor.batch_decode(newIds, { skip_special_tokens: true });
    return (decoded[0] || '').trim();
}

// ── Non-vision warning modal ──────────────────────────────
function showVisionRequiredModal() {
    // Update the modal text based on SmolVLM state
    const localBtn = document.getElementById('vision-req-local-btn');
    if (localBtn) {
        if (_localVLMState === 'ready') {
            localBtn.textContent = '💻 Use Local Vision Bridge';
        } else if (_localVLMState === 'loading') {
            localBtn.textContent = '⏳ Loading…';
            localBtn.disabled = true;
        } else {
            localBtn.textContent = '💻 Load Local Model';
            localBtn.disabled = false;
        }
    }
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
        // Only switch to local provider if user isn't already on a cloud provider
        // If they're on a cloud provider with vision=false, keep it and use bridge mode
        const wasOnCustom = activeProvider.id === 'custom' && !PROVIDERS.custom.hasVision;
        const wasOnOtherCloud = activeProvider.id !== 'local' && !providerHasVision();

        if (wasOnCustom || wasOnOtherCloud) {
            // Bridge mode: keep current cloud provider, SmolVLM handles vision
            populateModelDropdown();
            hideLocalModelModal();
            tts.interrupt('Vision bridge ready! SmolVLM will describe the screen for your cloud AI.');
        } else {
            // Switch to local provider
            activeProvider = PROVIDERS.local;
            try { localStorage.setItem(PROVIDER_STORAGE, 'local'); } catch {}
            populateModelDropdown();
            hideLocalModelModal();
            tts.interrupt('Local vision model loaded! AI player is ready.');
        }

        // Update the provider panel local row if it's open
        const localStatusEl = document.getElementById('provider-local-status');
        const loadLocalBtnEl = document.getElementById('provider-load-local-btn');
        if (localStatusEl) localStatusEl.textContent = 'SmolVLM-256M: ✅ Loaded';
        if (loadLocalBtnEl) { loadLocalBtnEl.textContent = '✅ Loaded'; loadLocalBtnEl.disabled = true; }

        // If AI was waiting to start, retry
        if (_pendingAIStart) { _pendingAIStart = false; toggleAIPlayer(); }
    } else {
        btn.disabled = false;
        btn.textContent = '↺ Retry';
    }
});

document.getElementById('local-model-cancel-btn')?.addEventListener('click', hideLocalModelModal);
document.getElementById('local-model-backdrop')?.addEventListener('click', hideLocalModelModal);
document.getElementById('vision-required-backdrop')?.addEventListener('click', hideVisionRequiredModal);

document.getElementById('vision-req-connect-btn')?.addEventListener('click', () => {
    hideVisionRequiredModal();
    openProviderPanel('custom');
});
document.getElementById('vision-req-local-btn')?.addEventListener('click', () => {
    if (_localVLMState === 'ready') {
        // SmolVLM already loaded — just enable bridge mode and start AI
        hideVisionRequiredModal();
        tts.interrupt('Vision bridge active. Local model will describe the screen for your cloud AI.');
        if (_pendingAIStart) { _pendingAIStart = false; toggleAIPlayer(); }
    } else {
        showLocalModelModal();
    }
});

let _pendingAIStart = false;
let _memoryOnlyNoticeShown = false;

// ────────────────────────────────────────────────────────────
// 4. AUTH (Pollinations OAuth)
// ────────────────────────────────────────────────────────────
const getStoredKey   = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };
const storeKey       = k  => { try { localStorage.setItem(STORAGE_KEY, k); } catch {} };
const clearStoredKey = () => { try { localStorage.removeItem(STORAGE_KEY); } catch {} };

function buildAuthUrl() {
    // client_id = our publishable App Key, so the consent screen shows the app
    // name + author and inference users spend credits developer earnings to us.
    const params = new URLSearchParams({
        redirect_uri: location.href.split('#')[0],
        client_id:    POLLINATIONS_APP_KEY,
        // usage scope → lets us read balance + per-request cost for the energy bar
        scope:        'usage',
    });
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

// Live model list from OpenRouter (/models needs no auth). We read each model's
// capabilities so the app knows, per model, whether it supports vision (image
// input) and tool-calling — then picks the right perception mode automatically.
let _openrouterModelsCache = null;
// Per-model capability map: { [id]: { vision: bool, tools: bool, name } }
const _openrouterModelMeta = {};

async function fetchOpenRouterModels() {
    const select     = document.getElementById('model-select');
    const statusSpan = document.getElementById('model-status');
    if (!select) return;

    if (_openrouterModelsCache) { renderOpenRouterModels(_openrouterModelsCache); return; }

    select.innerHTML = '<option value="">Loading models…</option>';
    select.disabled  = true;
    if (statusSpan) statusSpan.textContent = 'fetching…';

    try {
        const res  = await fetch(OPENROUTER_MODELS_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data.data || []).map(m => {
            const vision = (m.architecture?.input_modalities || []).includes('image');
            const tools  = (m.supported_parameters || []).includes('tools');
            const meta   = { id: m.id, name: m.name || m.id, vision, tools };
            _openrouterModelMeta[m.id] = meta;
            // Pre-seed tool support so we don't waste a probe call
            _modelToolSupport[m.id] = tools;
            return meta;
        }).sort((a, b) => a.id.localeCompare(b.id));

        _openrouterModelsCache = models.length ? models : null;
        PROVIDERS.openrouter.visionModels = models.filter(m => m.vision).map(m => m.id);
        renderOpenRouterModels(models);
    } catch (err) {
        console.warn('[OpenRouter] model fetch failed, using static list:', err);
        renderOpenRouterModels((PROVIDERS.openrouter.visionModels || [])
            .map(id => ({ id, name: id, vision: true, tools: true })));
        if (statusSpan) statusSpan.textContent = '⚠ offline list';
    }
}

function renderOpenRouterModels(models) {
    const select     = document.getElementById('model-select');
    const statusSpan = document.getElementById('model-status');
    if (!select) return;
    select.innerHTML = '';

    const vision = models.filter(m => m.vision);
    const text   = models.filter(m => !m.vision);
    const saved  = localStorage.getItem(MODEL_STORAGE_KEY) || PROVIDERS.openrouter.defaultModel;

    const addGroup = (label, list) => {
        if (!list.length) return;
        const grp = document.createElement('optgroup');
        grp.label = label;
        for (const m of list) {
            const opt = document.createElement('option');
            opt.value = m.id;
            // Tag capabilities so the user can see them at a glance
            const tags = `${m.vision ? ' 👁️' : ''}${m.tools ? ' 🛠️' : ''}`;
            opt.textContent = `${m.name}${tags}`;
            if (m.id === saved) opt.selected = true;
            grp.appendChild(opt);
        }
        select.appendChild(grp);
    };

    // Vision models first (recommended), then text-only (memory-only / bridge play)
    addGroup('👁️ Vision models (see the screen)', vision);
    addGroup('🧠 Text-only models (memory-only / bridge)', text);

    select.disabled = false;
    if (statusSpan) statusSpan.textContent = `${vision.length} vision · ${text.length} text-only`;
}

// Does the currently-selected OpenRouter model support image input?
function openrouterSelectedHasVision() {
    const model = getSelectedModel();
    const meta  = _openrouterModelMeta[model];
    if (!meta) return true;          // unknown — assume vision (safe default for cloud)
    return meta.vision === true;
}

// Debounce to prevent rapid successive calls
let _customModelsFetchPending = false;
let _customModelsLastFetch = 0;

// Fetch models from a custom OpenAI-compatible endpoint via /v1/models
async function fetchCustomModels() {
    const select     = document.getElementById('model-select');
    const statusSpan = document.getElementById('model-status');
    if (!select) return;

    // Debounce: skip if already fetching or fetched < 2s ago
    if (_customModelsFetchPending) return;
    const now = Date.now();
    if (now - _customModelsLastFetch < 2000) return;
    _customModelsFetchPending = true;
    _customModelsLastFetch = now;

    // Read base URL from memory or localStorage, strip trailing slash
    const base = (window._customApiBase || localStorage.getItem('sm64_custom_base') || '').trim().replace(/\/+$/, '');
    if (!base) {
        select.innerHTML = '<option value="">⚙️ Set Base URL in API Settings first</option>';
        select.disabled = true;
        if (statusSpan) statusSpan.textContent = 'no URL';
        _customModelsFetchPending = false;
        return;
    }

    select.innerHTML = '<option value="">Loading models…</option>';
    select.disabled  = true;
    if (statusSpan) statusSpan.textContent = 'fetching…';

    // Sanitize key: strip all whitespace including invisible unicode
    const rawKey = providerKeys['custom'] || localStorage.getItem('sm64_key_custom') || '';
    const key = rawKey.replace(/[\s\u200B-\u200D\uFEFF]/g, '');

    // Build headers — only add Authorization if we actually have a key
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const doFetch = (hdrs) => fetch(`${base}/v1/models`, { headers: hdrs });

    try {
        let res = await doFetch(headers);

        // If 401 and we sent a key, try once more without auth
        // (some local servers like Ollama/LM Studio don't need auth)
        if (res.status === 401 && key) {
            const noAuthHeaders = { 'Content-Type': 'application/json' };
            const res2 = await doFetch(noAuthHeaders);
            if (res2.ok) {
                res = res2;
            } else {
                // Both failed — show friendly error, don't throw to console
                select.innerHTML = '<option value="">🔑 401 — check API key in ⚙️ API Settings</option>';
                select.disabled = true;
                if (statusSpan) statusSpan.textContent = '🔑 401';
                return;
            }
        } else if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();

        // OpenAI /v1/models returns { data: [ { id, object, ... }, ... ] }
        const rawModels = Array.isArray(data) ? data
            : Array.isArray(data.data) ? data.data
            : [];

        const modelIds = rawModels
            .map(m => (typeof m === 'string' ? m : m.id || m.name || ''))
            .filter(Boolean)
            .sort();

        select.innerHTML = '';
        if (!modelIds.length) {
            select.innerHTML = '<option value="">No models returned</option>';
            select.disabled = true;
            if (statusSpan) statusSpan.textContent = '0 models';
            return;
        }

        const saved = localStorage.getItem(MODEL_STORAGE_KEY) || modelIds[0];
        const grp = document.createElement('optgroup');
        grp.label = PROVIDERS.custom.hasVision
            ? '🔧 Custom Models (vision enabled)'
            : '🔧 Custom Models (bridge mode)';

        for (const id of modelIds) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            if (id === saved) opt.selected = true;
            grp.appendChild(opt);
        }
        select.appendChild(grp);
        select.disabled = false;
        if (statusSpan) statusSpan.textContent = `${modelIds.length} models`;

        // Cache the list on the provider for re-use
        PROVIDERS.custom.visionModels = modelIds;
        PROVIDERS.custom.defaultModel = modelIds.includes(saved) ? saved : modelIds[0];

    } catch (err) {
        // Only log non-auth errors to console
        if (!err.message.includes('401')) console.error('[Custom] /v1/models fetch failed:', err);
        select.innerHTML = `<option value="">⚠ ${err.message} — check ⚙️ API Settings</option>`;
        select.disabled = true;
        if (statusSpan) statusSpan.textContent = '⚠ error';
    } finally {
        _customModelsFetchPending = false;
    }
}

function populateModelDropdown() {
    const select     = document.getElementById('model-select');
    const statusSpan = document.getElementById('model-status');
    if (!select) return;

    // Local provider — single fixed model
    if (activeProvider.id === 'local') {
        select.innerHTML = '';
        const grp = document.createElement('optgroup');
        grp.label = '💻 Local Model (in-browser)';
        const opt = document.createElement('option');
        opt.value = LOCAL_VLM_MODEL;
        opt.textContent = `SmolVLM-256M — ${_localVLMState === 'ready' ? '✅ loaded' : '⏳ not loaded'}`;
        opt.selected = true;
        grp.appendChild(opt);
        select.appendChild(grp);
        select.disabled = true;
        if (statusSpan) statusSpan.textContent = _localVLMState === 'ready' ? '✅ local' : '⏳ not loaded';
        return;
    }

    // Custom OpenAI-compat provider — fetch /v1/models dynamically
    if (activeProvider.id === 'custom') {
        fetchCustomModels();
        return;
    }

    // OpenRouter — fetch vision models live (cached)
    if (activeProvider.id === 'openrouter') {
        fetchOpenRouterModels();
        return;
    }

    // Named providers (openai, anthropic, gemini) — show static vision model list
    if (activeProvider.id !== 'pollinations') {
        const models = activeProvider.visionModels || [];
        select.innerHTML = '';
        const grp = document.createElement('optgroup');
        grp.label = `${activeProvider.label} Vision Models`;
        const saved = localStorage.getItem(MODEL_STORAGE_KEY) || activeProvider.defaultModel;
        for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m === saved) opt.selected = true;
            grp.appendChild(opt);
        }
        select.appendChild(grp);
        select.disabled = false;
        if (statusSpan) statusSpan.textContent = `${models.length} models`;
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
    if (val && val !== 'Loading models…' && val !== 'Loading…') return val;
    return activeProvider?.defaultModel || DEFAULT_MODEL;
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

    // Vision source row (applies to every provider) — canvas grab vs screen-share
    const visRow = document.createElement('div');
    visRow.className = 'provider-row';
    const visLabel = document.createElement('label');
    visLabel.className = 'provider-label';
    visLabel.textContent = 'AI vision source';
    const visSel = document.createElement('select');
    visSel.className = 'provider-select';
    visSel.innerHTML = `
        <option value="canvas">🎯 Game canvas (no popup, recommended)</option>
        <option value="screen">🖥️ Screen share (window/tab)</option>`;
    visSel.value = _visionSource;
    visSel.addEventListener('change', () => setVisionSource(visSel.value));
    visRow.appendChild(visLabel);
    visRow.appendChild(visSel);
    panel.appendChild(visRow);

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

    // Placeholder for dynamic custom rows — inserted after key row
    const customRowsContainer = document.createElement('div');
    customRowsContainer.id = 'custom-provider-rows';
    panel.appendChild(customRowsContainer);

    function buildCustomRows(providerId) {
        customRowsContainer.innerHTML = '';
        if (providerId !== 'custom') return;

        // Base URL input
        const urlRow = document.createElement('div');
        urlRow.className = 'provider-row';
        const urlLabel = document.createElement('label');
        urlLabel.className = 'provider-label';
        urlLabel.textContent = 'Base URL';
        const urlInput = document.createElement('input');
        urlInput.type = 'text'; urlInput.id = 'custom-base-url';
        urlInput.className = 'provider-key-input';
        urlInput.placeholder = 'https://your-api.example.com';
        urlInput.value = window._customApiBase
            || (localStorage.getItem('sm64_custom_base') || '');
        urlInput.addEventListener('input', () => {
            window._customApiBase = urlInput.value.trim();
        });
        urlRow.appendChild(urlLabel);
        urlRow.appendChild(urlInput);
        customRowsContainer.appendChild(urlRow);

        // Vision toggle row
        const visionRow = document.createElement('div');
        visionRow.className = 'provider-row provider-vision-row';

        const visionLabelEl = document.createElement('label');
        visionLabelEl.className = 'provider-label';
        visionLabelEl.textContent = 'Model supports vision (image input)';

        const visionToggleWrap = document.createElement('label');
        visionToggleWrap.className = 'provider-toggle-wrap';

        const visionCheck = document.createElement('input');
        visionCheck.type = 'checkbox'; visionCheck.id = 'custom-vision-check';
        visionCheck.checked = PROVIDERS.custom.hasVision === true;

        const toggleTrack = document.createElement('span');
        toggleTrack.className = 'toggle-track';
        const toggleThumb = document.createElement('span');
        toggleThumb.className = 'toggle-thumb';
        toggleTrack.appendChild(toggleThumb);

        const visionToggleLabel = document.createElement('span');
        visionToggleLabel.className = 'provider-toggle-label';
        visionToggleLabel.id = 'custom-vision-label';
        visionToggleLabel.textContent = PROVIDERS.custom.hasVision ? 'Vision ON' : 'Visionless — bridge mode';

        visionCheck.addEventListener('change', () => {
            PROVIDERS.custom.hasVision = visionCheck.checked;
            visionToggleLabel.textContent = visionCheck.checked ? 'Vision ON' : 'Visionless — bridge mode';
            bridgeNote.style.display = visionCheck.checked ? 'none' : 'block';
            try { localStorage.setItem('sm64_custom_vision', visionCheck.checked ? '1' : '0'); } catch {}
        });

        visionToggleWrap.appendChild(visionCheck);
        visionToggleWrap.appendChild(toggleTrack);
        visionToggleWrap.appendChild(visionToggleLabel);

        visionRow.appendChild(visionLabelEl);
        visionRow.appendChild(visionToggleWrap);
        customRowsContainer.appendChild(visionRow);

        // Bridge mode note
        const bridgeNote = document.createElement('p');
        bridgeNote.className = 'provider-bridge-note';
        bridgeNote.id = 'custom-bridge-note';
        bridgeNote.innerHTML = '🔭 <strong>Bridge mode:</strong> SmolVLM will caption the screen locally, then send the description to your cloud LLM. Load the local model first.';
        bridgeNote.style.display = PROVIDERS.custom.hasVision ? 'none' : 'block';
        customRowsContainer.appendChild(bridgeNote);

        // Refresh models button — fetches /v1/models and shows count inline
        const refreshRow = document.createElement('div');
        refreshRow.className = 'provider-row provider-local-row';
        const refreshStatus = document.createElement('span');
        refreshStatus.className = 'provider-local-status';
        refreshStatus.id = 'custom-model-fetch-status';
        refreshStatus.textContent = PROVIDERS.custom.visionModels?.length
            ? `${PROVIDERS.custom.visionModels.length} models cached`
            : 'Models not yet fetched';
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'provider-load-local-btn';
        refreshBtn.textContent = '🔄 Fetch Models';
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.textContent = '⏳ Fetching…';
            refreshStatus.textContent = 'Connecting…';
            // Read current URL/key from inputs before saving
            const urlEl = document.getElementById('custom-base-url');
            const keyEl = document.getElementById('provider-key-input');
            if (urlEl) window._customApiBase = urlEl.value.trim();
            if (keyEl) providerKeys['custom'] = keyEl.value.trim();
            // Temporarily switch to custom so fetchCustomModels works
            const prevProvider = activeProvider;
            activeProvider = PROVIDERS.custom;
            await fetchCustomModels();
            activeProvider = prevProvider;
            const count = PROVIDERS.custom.visionModels?.length || 0;
            refreshStatus.textContent = count ? `✅ ${count} models fetched` : '⚠ No models returned';
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 Fetch Models';
        });
        refreshRow.appendChild(refreshStatus);
        refreshRow.appendChild(refreshBtn);
        customRowsContainer.appendChild(refreshRow);

        // Local model status + load button
        const localRow = document.createElement('div');
        localRow.className = 'provider-row provider-local-row';
        localRow.id = 'provider-local-row';
        const localStatus = document.createElement('span');
        localStatus.className = 'provider-local-status';
        localStatus.id = 'provider-local-status';
        const stateMap = { idle: '⬜ Not loaded', loading: '⏳ Loading…', ready: '✅ Loaded', error: '❌ Error' };
        localStatus.textContent = `SmolVLM-256M: ${stateMap[_localVLMState] || '⬜ Not loaded'}`;
        const loadLocalBtn = document.createElement('button');
        loadLocalBtn.className = 'provider-load-local-btn';
        loadLocalBtn.id = 'provider-load-local-btn';
        loadLocalBtn.textContent = _localVLMState === 'ready' ? '✅ Loaded' : '⬇ Load Local Model';
        loadLocalBtn.disabled = _localVLMState === 'ready' || _localVLMState === 'loading';
        loadLocalBtn.addEventListener('click', () => {
            showLocalModelModal();
        });
        localRow.appendChild(localStatus);
        localRow.appendChild(loadLocalBtn);
        customRowsContainer.appendChild(localRow);
    }

    buildCustomRows(activeProvider.id);

    // Save button
    const saveBtn = document.createElement('button');
    saveBtn.className = 'provider-save-btn';
    saveBtn.textContent = '✓ Save & Apply';
    saveBtn.addEventListener('click', () => {
        const newId = sel.value;
        activeProvider = PROVIDERS[newId];
        // Strip all whitespace including invisible unicode from key
        const newKey = keyInput.value.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
        if (newKey && !activeProvider.oauthOnly) {
            providerKeys[newId] = newKey;
            try { localStorage.setItem(`sm64_key_${newId}`, newKey); } catch {}
        }
        // Persist custom provider settings
        if (newId === 'custom') {
            const urlEl = document.getElementById('custom-base-url');
            if (urlEl) {
                window._customApiBase = urlEl.value.trim();
                try { localStorage.setItem('sm64_custom_base', window._customApiBase); } catch {}
            }
            const visionEl = document.getElementById('custom-vision-check');
            if (visionEl) {
                PROVIDERS.custom.hasVision = visionEl.checked;
                try { localStorage.setItem('sm64_custom_vision', visionEl.checked ? '1' : '0'); } catch {}
            }
        }
        try { localStorage.setItem(PROVIDER_STORAGE, newId); } catch {}
        populateModelDropdown();
        closeProviderPanel();
        tts.interrupt(`Switched to ${activeProvider.label}.`);
    });
    panel.appendChild(saveBtn);

    // Update key row + custom rows on provider change
    sel.addEventListener('change', () => {
        const p = PROVIDERS[sel.value];
        keyLabel.textContent    = p.keyLabel;
        keyInput.placeholder    = p.noKey ? 'No key needed — runs locally' : p.keyPlaceholder;
        keyInput.disabled       = !!(p.oauthOnly || p.noKey);
        keyInput.value          = providerKeys[p.id] || '';
        buildCustomRows(p.id);
    });
}

function openProviderPanel(preselect) {
    // If called from auth screen with no provider set, pre-select custom
    if (preselect) {
        const p = PROVIDERS[preselect];
        if (p) activeProvider = p;
    }
    buildProviderPanel();
    document.getElementById('provider-modal').classList.add('open');
    document.getElementById('provider-backdrop').classList.add('open');
}
// Expose globally so inline scripts (non-module) can call it
window.openProviderPanel = openProviderPanel;

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
            // Sanitize on restore too — strip invisible unicode/whitespace
            if (k) providerKeys[id] = k.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
        }
        // Restore custom provider settings
        const savedBase   = localStorage.getItem('sm64_custom_base');
        const savedVision = localStorage.getItem('sm64_custom_vision');
        if (savedBase)   window._customApiBase       = savedBase;
        if (savedVision !== null) PROVIDERS.custom.hasVision = savedVision === '1';
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
let _captureCanvas = null;
let _captureCtx = null;
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
        // Force a *freshly presented* frame so the model never reasons about a
        // stale image (the bug where it thinks it's still at the castle entrance).
        // requestVideoFrameCallback fires only when a new frame is composited.
        if (typeof _captureVideo.requestVideoFrameCallback === 'function') {
            await new Promise((resolve) => {
                let settled = false;
                const done = () => { if (!settled) { settled = true; resolve(); } };
                try { _captureVideo.requestVideoFrameCallback(done); } catch { done(); return; }
                setTimeout(done, 200); // safety: never hang if no new frame arrives
            });
        }

        const w = _captureVideo.videoWidth  || 640;
        const h = _captureVideo.videoHeight || 480;
        const targetW = Math.min(w, 1280);
        const targetH = Math.round(h * (targetW / w));

        // Reuse canvas to avoid GC pressure
        if (!_captureCanvas) {
            _captureCanvas = document.createElement('canvas');
            _captureCtx = _captureCanvas.getContext('2d', { alpha: false });
        }
        _captureCanvas.width  = targetW;
        _captureCanvas.height = targetH;
        _captureCtx.drawImage(_captureVideo, 0, 0, targetW, targetH);
        return _captureCanvas.toDataURL('image/jpeg', 0.72);
    } catch (err) {
        console.error('Screen capture error:', err);
        return null;
    }
}

// Load a data URL / URL into an Image element
function _loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

// Stitch the previous and current frame into ONE side-by-side image with a bold
// labelled divider, so the model gets temporal context in a single image and
// can't confuse the two frames. Returns a JPEG data URL.
let _composeCanvas = null, _composeCtx = null;
async function composeComparisonImage(prevUrl, curUrl) {
    const [imgA, imgB] = await Promise.all([_loadImage(prevUrl), _loadImage(curUrl)]);
    const h    = Math.max(imgA.height, imgB.height) || 480;
    const wA   = Math.round((imgA.width / (imgA.height || 1)) * h);
    const wB   = Math.round((imgB.width / (imgB.height || 1)) * h);
    const div  = 10;   // divider width
    const labelH = 28;
    const W = wA + div + wB;
    const H = h + labelH;

    if (!_composeCanvas) {
        _composeCanvas = document.createElement('canvas');
        _composeCtx    = _composeCanvas.getContext('2d', { alpha: false });
    }
    _composeCanvas.width  = W;
    _composeCanvas.height = H;
    const ctx = _composeCtx;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // Frames
    ctx.drawImage(imgA, 0,         labelH, wA, h);
    ctx.drawImage(imgB, wA + div,  labelH, wB, h);

    // Red divider bar between them
    ctx.fillStyle = '#ff3b30';
    ctx.fillRect(wA, 0, div, H);

    // Labels
    ctx.fillStyle    = '#fff';
    ctx.font         = 'bold 18px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'center';
    ctx.fillText('◀ PREVIOUS TURN', wA / 2, labelH / 2);
    ctx.fillText('CURRENT TURN ▶',  wA + div + wB / 2, labelH / 2);

    return _composeCanvas.toDataURL('image/jpeg', 0.72);
}

// ── Vision source: capture the game canvas directly (no screen-share popup) ──
// 'canvas' = MediaStream straight off the game <canvas> (default, zero prompts).
// 'screen' = legacy getDisplayMedia screen-share (fallback / multi-window setups).
let _visionSource = (() => { try { return localStorage.getItem('sm64_vision_source') || 'canvas'; } catch { return 'canvas'; } })();
let _canvasStream = null;

function setVisionSource(src) {
    _visionSource = src;
    try { localStorage.setItem('sm64_vision_source', src); } catch {}
}

function getCanvasStream(fps = 5) {
    if (_canvasStream && _canvasStream.active) return _canvasStream;
    try {
        if (typeof canvas.captureStream !== 'function') return null;
        _canvasStream = canvas.captureStream(fps);
        return _canvasStream;
    } catch (err) {
        console.warn('[Vision] canvas.captureStream failed:', err);
        return null;
    }
}

// Acquire a stream for the AI/buddy to "see". Prefers the direct canvas grab so
// the connected model can see the game with no screen-share prompt; falls back
// to screen-share only if canvas capture is unavailable or explicitly chosen.
async function acquireVisionStream(fps = 5) {
    if (_visionSource === 'canvas') {
        const s = getCanvasStream(fps);
        if (s) return s;
        console.warn('[Vision] canvas capture unavailable — falling back to screen share');
    }
    return await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: fps, max: fps * 2 } }, audio: false,
    });
}

// Quick perceptual hash of a data URL — sample every 1KB for robust change detection
function quickHash(dataUrl) {
    if (!dataUrl) return '';
    const step = Math.max(1, Math.floor(dataUrl.length / 16));
    let hash = '';
    for (let i = 0; i < 16; i++) {
        hash += dataUrl.charCodeAt(i * step).toString(36);
    }
    return hash;
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

// Same idea as isFrameIdentical, but keyed on RAM state — used by memory-only play
let _lastStateHash = null;
let _identicalStateCount = 0;
function isStateIdentical(stateHash) {
    if (stateHash === _lastStateHash) {
        _identicalStateCount++;
        return _identicalStateCount >= IDLE_FRAME_SKIP;
    }
    _lastStateHash = stateHash;
    _identicalStateCount = 0;
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

// Temporal context — lets the AI sense motion between decisions
let _prevScreenshot  = null;    // data URL from the previous think
let _prevGameState   = null;    // RAM state from the previous think
let _stuckCount      = 0;       // consecutive near-zero-movement decisions

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
        // How will the model perceive the game this turn?
        const visionOK   = providerHasVision();                       // model accepts images
        const bridgeOK   = !visionOK && _localVLMState === 'ready';    // SmolVLM captions for it
        const memoryOnly = !visionOK && !bridgeOK;                     // play from RAM alone

        // Live game state from WASM memory — our ground truth, always read
        const gameState = readGameState();

        let screenshot = null;
        if (!memoryOnly) {
            screenshot = await captureScreen(aiStream);
            if (!screenshot) { updateAIStatus('❌ Failed to capture game view'); _isThinking = false; return null; }
            // Skip if the frame is identical to recent ones (nothing changed)
            if (isFrameIdentical(screenshot)) {
                updateAIStatus('💤 Screen unchanged — skipping inference');
                _isThinking = false;
                return null;
            }
            if (bridgeOK) updateAIStatus('🔭 Vision bridge: captioning screen…');
        } else {
            // Memory-only: a non-vision model plays purely from RAM state + game knowledge.
            if (!gameState) {
                updateAIStatus('⏳ Waiting for game memory (no vision)…');
                _isThinking = false;
                return null;
            }
            const sHash = `${gameState.x},${gameState.y},${gameState.z},${gameState.actionId},${gameState.stars},${gameState.coins}`;
            if (isStateIdentical(sHash)) {
                updateAIStatus('💤 Game state unchanged — skipping inference');
                _isThinking = false;
                return null;
            }
            updateAIStatus('🧠 Memory-only play (no vision)…');
        }

        const { t1, t2 } = await loadTrainingData();

        const memStateCtx = gameState
            ? `\n\n${gameStateToText(gameState)}`
            : '';

        // Movement since the previous decision — gives the model a sense of motion,
        // and catches the "stuck repeating the same wrong move" failure mode.
        let motionCtx = '';
        if (_prevGameState && gameState) {
            const dx = gameState.x - _prevGameState.x;
            const dy = gameState.y - _prevGameState.y;
            const dz = gameState.z - _prevGameState.z;
            const dist = Math.round(Math.hypot(dx, dz));
            if (dist + Math.abs(dy) < 8) _stuckCount++; else _stuckCount = 0;
            motionCtx = `\n\nMOVEMENT SINCE LAST DECISION: Δx=${dx}, Δy=${dy}, Δz=${dz} (moved ${dist} units horizontally).`;
            if (_stuckCount >= 2) {
                motionCtx += `\n⚠ YOU APPEAR STUCK — your position has barely changed for ${_stuckCount} turns, so your last move is NOT working. Do something DIFFERENT: turn to face a new direction, back up, jump over the obstacle, or pick another path. Do not repeat the previous action.`;
            }
            if (_prevGameState.stars < gameState.stars) motionCtx += `\n🌟 You just collected a STAR — nice! Keep progressing.`;
            if (_prevGameState.levelId !== gameState.levelId) motionCtx += `\n📍 The level/area just changed to ${gameState.levelName}. Re-orient before acting.`;
        }

        const perceptionNote = memoryOnly
            ? 'IMPORTANT: You CANNOT see the screen. Play entirely from the LIVE GAME STATE (RAM) below plus your knowledge of Super Mario 64. Reason from Mario\'s position (x,y,z), action, speed and camera angle. Call the get_game_state tool whenever you need exact, fresh numbers.'
            : (bridgeOK
                ? 'A local vision model describes the screen for you (see the SCREEN DESCRIPTION). You may also call the get_game_state tool for exact RAM values.'
                : 'Analyze the screenshot together with the LIVE GAME STATE below. You may call the get_game_state tool any time for exact, fresh RAM values.');

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

        const systemPrompt = `You are an AI playing Super Mario 64. Decide what actions to take.
${perceptionNote}

GAME OBJECTIVE:
1. Start outside the castle — head to the entrance bridge and go inside
2. Skip dialog by pressing jump (X) or start (Enter) repeatedly
3. Once inside, do NOT run back out — proceed forward
4. Find the first door (no star requirement) and enter it
5. Jump into the painting to start the first level
6. Collect stars to progress

Controls: ArrowUp/Down/Left/Right = move, jump (X) = jump/skip dialog, start (Enter) = pause/skip dialog, crouch (Space) = duck, action (C) = dive/punch/grab
${movementCtx}${memStateCtx}${motionCtx}${memoryCtx}${notesCtx}${instrCtx}${trainingCtx}

Respond with ONLY valid JSON (no markdown fences):
{
  "actions": [["action1"], ["action2", "action3"]],
  "thought": "brief strategy",
  "speech": "short streamer commentary (max 15 words) — omit if rapid_fire is true",
  "mistake": "error noticed or null",
  "notes": ["optional NEW strategy insight worth remembering for later — omit or [] if nothing new"],
  "rapid_fire": false
}

Set "rapid_fire": true ONLY when you need to make many fast decisions (e.g. mid-jump sequence, navigating a tight corridor, chasing a star). Set it back to false when the situation stabilises.
Max 5 action groups. Valid names: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, jump, start, crouch, action`;

        let userMessage;
        if (memoryOnly) {
            setAIVisionFrame(null);   // streamer overlay shows "no vision" placeholder
            userMessage = {
                role: 'user',
                content: 'Based on the live game state, what should I do next? Call get_game_state first if you need exact numbers. Respond with ONLY the JSON.',
            };
        } else {
            // Vision: stitch PREVIOUS + CURRENT into one labelled side-by-side image
            // so the model can see whether its last move actually moved Mario (and
            // which way) without confusing the two frames or paying for two images.
            let visionImg = screenshot, promptText = 'What should I do?';
            if (_prevScreenshot) {
                try {
                    visionImg = await composeComparisonImage(_prevScreenshot, screenshot);
                    promptText = 'This image shows TWO frames side by side: the LEFT half is the PREVIOUS TURN (before my last action) and the RIGHT half is the CURRENT TURN (now), split by a red divider. Compare them to judge whether I moved the right way, then decide the next action.';
                } catch (e) {
                    // Compose failed — fall back to the single current frame
                    visionImg = screenshot;
                }
            }
            setAIVisionFrame(visionImg);   // mirror exactly what the AI sees into streamer mode
            userMessage = {
                role: 'user',
                content: [
                    { type: 'text', text: promptText },
                    { type: 'image_url', image_url: { url: visionImg } },
                ],
            };
        }

        const rawContent = await callChatWithTools([
            { role: 'system', content: systemPrompt },
            userMessage,
        ], { json: true, max_tokens: 400 });

        const clean    = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const response = JSON.parse(clean);

        updateAIStatus(`💭 ${response.thought}`);
        _consecutiveErrors = 0;
        recordUsage();   // sample pollen spend for the energy bar / usage log

        // Remember this turn so the next one can sense movement/direction.
        _prevScreenshot = screenshot;       // null in memory-only mode (fine)
        _prevGameState  = gameState;

        if (response.mistake && response.mistake !== 'null' && response.mistake !== null) {
            aiMemory.push(response.mistake);
            if (aiMemory.length > 20) aiMemory.shift();
        }

        // Live study notes the AI jots down mid-play (deduped, capped)
        if (Array.isArray(response.notes)) {
            for (const note of response.notes) {
                const n = (note || '').trim();
                if (n && n.length > 4 && !aiNotes.includes(n)) aiNotes.push(n);
            }
            while (aiNotes.length > 30) aiNotes.shift();
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
    // Perception modes:
    //  • vision model            → sees the canvas directly
    //  • SmolVLM bridge ready     → local model captions for a non-vision model
    //  • neither                  → memory-only play (reads RAM, no vision needed)
    const bridgeMode = !providerHasVision() && _localVLMState === 'ready';
    const memoryOnly = !providerHasVision() && !bridgeMode;
    if (memoryOnly && !aiPlayerActive) {
        // No longer a hard block — the AI can play blind from game memory.
        // Offer vision as an optional upgrade the first time only.
        if (!_memoryOnlyNoticeShown) {
            _memoryOnlyNoticeShown = true;
            tts.interrupt('This model can\'t see the screen, so I\'ll play from game memory. For sharper play, connect a vision model or load the local one.');
        }
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
            openProviderPanel(activeProvider.id);
        }
        return;
    }

    if (!aiPlayerActive) {
        try {
            aiStream = await acquireVisionStream(5);
            if (!aiStream) throw new Error('no stream');
        } catch {
            tts.interrupt(_visionSource === 'screen'
                ? 'Screen sharing was denied. Please try again and select the window showing the game.'
                : 'Could not capture the game canvas. Try switching the vision source to screen-share in API settings.');
            return;
        }

        aiPlayerActive = true;
        _consecutiveErrors = 0;
        _lastFrameHash = null;
        _identicalFrameCount = 0;
        _lastStateHash = null;
        _identicalStateCount = 0;
        _prevScreenshot = null;
        _prevGameState  = null;
        _stuckCount     = 0;
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
    if (!buddyActive)  stopBridgeCaptionLoop();
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

    const visionOK   = providerHasVision();
    const bridgeOK   = !visionOK && _localVLMState === 'ready';
    const memoryOnly = !visionOK && !bridgeOK;

    const gameState = readGameState();
    const stateCtx  = gameState ? `\n\n${gameStateToText(gameState)}` : '';

    try {
        const sysPrompt = `You are an AI Buddy Coach for Super Mario 64. Give helpful, friendly advice in 2 sentences max.${
            memoryOnly ? ' You cannot see the screen — coach using the LIVE GAME STATE below.' : ''}${stateCtx}
Respond with ONLY valid JSON (no markdown fences):
{"text": "advice", "speech": "conversational version (max 20 words)"}`;

        let userMessage;
        if (memoryOnly) {
            userMessage = { role: 'user', content: 'Based on the live game state, what advice do you have?' };
        } else {
            const streamToUse = aiStream || buddyStream;
            if (!streamToUse) { buddyText.textContent = '❌ No game view active!'; return; }
            const screenshot = await captureScreen(streamToUse);
            if (!screenshot) { buddyText.textContent = '❌ Could not capture game view'; return; }
            const base64Image = screenshot.replace(/^data:image\/(png|jpeg);base64,/, '');
            const mimeType    = screenshot.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
            userMessage = {
                role: 'user',
                content: [
                    { type: 'text', text: 'What advice do you have?' },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
                ],
            };
        }

        const rawContent = await callChatAPI([
            { role: 'system', content: sysPrompt },
            userMessage,
        ], { json: true, max_tokens: 200 });

        const clean  = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const advice = JSON.parse(clean);
        buddyText.textContent = `💬 ${advice.text}`;
        if (advice.speech) tts.speak(advice.speech);
        recordUsage();   // log buddy-coach pollen spend too

    } catch (err) {
        buddyText.textContent = `❌ ${err.message}`;
    }
}

async function toggleBuddy() {
    const key = getActiveKey();
    if (!key) {
        if (activeProvider.id === 'pollinations') document.getElementById('auth-overlay').classList.remove('hidden');
        else openProviderPanel(activeProvider.id);
        return;
    }

    if (!buddyActive) {
        if (!aiStream && !buddyStream) {
            try {
                buddyStream = await acquireVisionStream(3);
                if (!buddyStream) throw new Error('no stream');
                buddyStream.getVideoTracks()[0].addEventListener('ended', stopBuddy);
            } catch {
                tts.interrupt(_visionSource === 'screen'
                    ? 'Screen sharing was denied. Please try again.'
                    : 'Could not capture the game canvas.');
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
    if (!aiPlayerActive) stopBridgeCaptionLoop();
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
        else openProviderPanel(activeProvider.id);
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

    // Start memory reader polling (every 500ms — lightweight, just typed array reads)
    setTimeout(() => {
        // Give the game a moment to initialise Mario before first read
        setInterval(() => {
            try { readGameState(); } catch {}
        }, 500);
    }, 3000);
};

// ────────────────────────────────────────────────────────────
// 21b. STREAMER MODE + BROADCAST OVERLAY
// ────────────────────────────────────────────────────────────
//
// Streamer mode hides all the app chrome and shows only:
//   • a clean broadcast-style stats overlay fed from game RAM
//   • a live view of what the AI actually sees (the side-by-side frame)
//   • a single text watermark ("Made by Endoxidev/MetaMysteries8") that
//     doubles as the exit button.
//
let _streamerMode  = (() => { try { return localStorage.getItem('sm64_streamer_mode') === '1'; } catch { return false; } })();
let _aiVisionFrame = null;  // last image the AI was actually shown

function setStreamerMode(on) {
    _streamerMode = on;
    document.getElementById('app')?.classList.toggle('streamer-mode', on);
    try { localStorage.setItem('sm64_streamer_mode', on ? '1' : '0'); } catch {}
    if (on) {
        if (_gameState) updateStreamerOverlay(_gameState);
        updateStreamerVision(_aiVisionFrame);
        updateStreamerControls();
    }
    // Always refresh energy bar + terminal so they show/hide with the mode
    if (typeof updateEnergyUI === 'function') updateEnergyUI();
}
function toggleStreamerMode() { setStreamerMode(!_streamerMode); }

// Streamer-mode AI controls proxy the real HUD buttons so all logic/state is reused
function _proxyClick(targetId) {
    document.getElementById(targetId)?.click();
    setTimeout(updateStreamerControls, 60);  // reflect new state after the toggle settles
}
document.getElementById('so-ai-btn')?.addEventListener('click',     () => _proxyClick('ai-player-btn'));
document.getElementById('so-buddy-btn')?.addEventListener('click',  () => _proxyClick('ai-buddy-btn'));
document.getElementById('so-study-btn')?.addEventListener('click',  () => _proxyClick('pregame-notes-btn'));
document.getElementById('so-memory-btn')?.addEventListener('click', () => _proxyClick('view-memory-btn'));
document.getElementById('so-mute-btn')?.addEventListener('click',   () => _proxyClick('mute-btn'));

// Keep the streamer-mode control dock in sync with real AI/buddy/mute state
function updateStreamerControls() {
    const aiB = document.getElementById('so-ai-btn');
    if (aiB) { aiB.classList.toggle('active', aiPlayerActive); aiB.textContent = aiPlayerActive ? '⏹ Stop AI' : '🤖 AI Play'; }
    const buB = document.getElementById('so-buddy-btn');
    if (buB) { buB.classList.toggle('active', buddyActive); buB.textContent = buddyActive ? '⏹ Stop' : '🧡 Buddy'; }
    const mB = document.getElementById('so-mute-btn');
    if (mB) mB.textContent = isMuted ? '🔇' : '🔊';
}

function updateStreamerOverlay(state) {
    if (!_streamerMode) return;
    updateStreamerControls();
    if (!state) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('so-stars',  state.stars);
    set('so-coins',  state.coins);
    set('so-lives',  state.lives);
    set('so-level',  state.levelName);
    set('so-action', state.actionName);
    set('so-speed',  `${state.speed}`);
    set('so-pos',    `X ${state.x}   Y ${state.y}   Z ${state.z}`);
    const hp = document.getElementById('so-health');
    if (hp) {
        hp.innerHTML = Array.from({ length: 8 }, (_, i) =>
            `<span class="so-wedge${i < state.health ? ' on' : ''}"></span>`).join('');
    }
    // Reflect whether the AI is currently playing
    const badge = document.getElementById('so-ai-badge');
    if (badge) badge.textContent = aiPlayerActive ? '🤖 AI PLAYING' : (buddyActive ? '🧡 BUDDY COACH' : '🎮 MANUAL');
}

// Mirror exactly what the AI "sees" into the streamer overlay
function setAIVisionFrame(dataUrl) {
    _aiVisionFrame = dataUrl;
    updateStreamerVision(dataUrl);
}
function updateStreamerVision(dataUrl) {
    if (!_streamerMode) return;
    const img = document.getElementById('so-vision-img');
    const ph  = document.getElementById('so-vision-ph');
    if (!img) return;
    if (dataUrl) {
        img.src = dataUrl;
        img.style.display = 'block';
        if (ph) ph.style.display = 'none';
    } else {
        img.removeAttribute('src');
        img.style.display = 'none';
        if (ph) ph.style.display = 'flex';
    }
}

// The watermark IS the exit button
document.getElementById('streamer-watermark')?.addEventListener('click', () => setStreamerMode(false));
document.getElementById('streamer-toggle-btn')?.addEventListener('click', () => setStreamerMode(true));

// Hotkey: Shift+S toggles streamer mode (Shift avoids the game's movement keys)
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.shiftKey && e.code === 'KeyS') { e.preventDefault(); toggleStreamerMode(); }
});

// ────────────────────────────────────────────────────────────
// 21c. POLLEN BALANCE + AI ENERGY / USAGE TRACKING (Pollinations)
// ────────────────────────────────────────────────────────────
//
// Energy bar = how much "AI power" is left, based on pollen balance.
//   full  = balance at page load (auto) OR a user-set maximum
//   empty = 0 (auto) OR a user-set minimum
// Per-prompt cost is derived from the drop in balance between checks, and the
// last few costs are shown in a mini usage log on the streamer overlay.
//
let _pollenStart = null;   // balance when we first read it (auto "full")
let _pollenLast  = null;   // balance at the previous usage check
let _pollenNow   = null;   // most recent balance
let _usageLog    = [];     // recent per-prompt costs (pollen)
let _lastUsageCheck = 0;

// User-configurable energy bounds
let _energyCfg = (() => {
    try { return JSON.parse(localStorage.getItem('sm64_energy_cfg')) || {}; } catch { return {}; }
})();
if (typeof _energyCfg.auto === 'undefined') _energyCfg.auto = true;
if (typeof _energyCfg.min  === 'undefined') _energyCfg.min  = 0;
if (typeof _energyCfg.max  === 'undefined') _energyCfg.max  = null;
if (typeof _energyCfg.unit === 'undefined') _energyCfg.unit = 'usd'; // 'usd' | 'poll' | 'cu'

function saveEnergyCfg() {
    try { localStorage.setItem('sm64_energy_cfg', JSON.stringify(_energyCfg)); } catch {}
}

// Pollinations bills in pollen, and 1 pollen = $1.00 exactly, so we can show the
// same number as dollars. Compute Units are a friendlier label: 0.01 pollen =
// 1000 CU  →  1 pollen = 100,000 CU.
function fmtAmount(pollen) {
    const p = Math.max(0, pollen || 0);
    const unit = _energyCfg.unit || 'usd';
    if (unit === 'cu')   return `${Math.round(p * 100000).toLocaleString()} CU`;
    if (unit === 'poll') return `${p.toFixed(p < 0.01 ? 5 : 4)} 🌸`;
    return `$${p.toFixed(p < 0.01 ? 5 : 4)}`;   // usd (default)
}

async function fetchBalanceValue() {
    if (activeProvider.id !== 'pollinations' || !pollinationsKey) return null;
    try {
        const res = await fetch(`${POLLINATIONS_API_BASE}/account/balance`, {
            headers: { 'Authorization': `Bearer ${pollinationsKey}` },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const bal  = data.balance ?? data.pollen ?? data.budget;
        const num  = typeof bal === 'number' ? bal : (bal != null ? parseFloat(bal) : null);
        return Number.isFinite(num) ? num : null;
    } catch { return null; }
}

async function refreshPollenBalance() {
    const chip = document.getElementById('pollen-chip');
    const bal  = await fetchBalanceValue();
    if (bal == null) { if (chip) chip.style.display = 'none'; return; }
    if (_pollenStart == null) { _pollenStart = bal; _pollenLast = bal; }
    _pollenNow = bal;
    if (chip) {
        chip.textContent = fmtAmount(bal);
        chip.style.display = '';
    }
    updateEnergyUI();
}

// Sample balance after an AI call and log the cost (debounced)
async function recordUsage(force = false) {
    if (activeProvider.id !== 'pollinations' || !pollinationsKey) return;
    const now = Date.now();
    if (!force && now - _lastUsageCheck < 2000) return;
    _lastUsageCheck = now;
    const bal = await fetchBalanceValue();
    if (bal == null) return;
    if (_pollenStart == null) { _pollenStart = bal; _pollenLast = bal; }
    if (_pollenLast != null) {
        const cost = _pollenLast - bal;
        if (cost > 1e-7) {
            _usageLog.push(cost);
            if (_usageLog.length > 50) _usageLog.shift();   // keep total accurate, display only last 4
        }
    }
    _pollenLast = bal;
    _pollenNow  = bal;
    updateEnergyUI();
}

function energyBounds() {
    const max = (_energyCfg.auto || _energyCfg.max == null)
        ? (_pollenStart ?? _pollenNow ?? 0)
        : _energyCfg.max;
    const min = _energyCfg.min ?? 0;
    return { max, min };
}

function updateEnergyUI() {
    const wrap = document.getElementById('so-energy');
    if (!wrap) return;
    const isPoll = activeProvider.id === 'pollinations' && pollinationsKey;
    wrap.style.display = (_streamerMode && isPoll && _pollenNow != null) ? 'block' : 'none';
    if (!(_streamerMode && isPoll && _pollenNow != null)) return;

    const { max, min } = energyBounds();
    const span = Math.max(1e-9, max - min);
    const pct  = Math.max(0, Math.min(100, ((_pollenNow - min) / span) * 100));

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('so-energy-model', getSelectedModel());
    set('so-energy-total', fmtAmount(Math.max(0, (_pollenStart ?? _pollenNow) - _pollenNow)));
    set('so-energy-left',  fmtAmount(Math.max(0, _pollenNow - min)));

    const bar = document.getElementById('so-energy-bar');
    if (bar) {
        bar.style.width = pct + '%';
        // green → amber → red as it drains
        bar.style.background = pct > 50 ? 'linear-gradient(90deg,#43a047,#7cb342)'
                              : pct > 20 ? 'linear-gradient(90deg,#fb8c00,#fdd835)'
                                         : 'linear-gradient(90deg,#e53935,#ff7043)';
    }

    const log = document.getElementById('so-energy-log');
    if (log) {
        const last5 = _usageLog.slice(-5);   // never show more than the last 5 calls
        log.innerHTML = last5.length
            ? last5.map(c => `<div class="so-uselog-row">AI Used: ${fmtAmount(c)}</div>`).join('')
            : '<div class="so-uselog-row dim">No AI usage yet…</div>';
    }
}

// ── Energy config box (openable via HUD button, works outside streamer mode) ──
function openEnergyConfig() {
    const modal = document.getElementById('energy-modal');
    const back  = document.getElementById('energy-backdrop');
    document.getElementById('energy-auto').checked = !!_energyCfg.auto;
    document.getElementById('energy-max').value    = _energyCfg.max ?? (_pollenStart ?? '');
    document.getElementById('energy-min').value    = _energyCfg.min ?? 0;
    document.getElementById('energy-max').disabled = !!_energyCfg.auto;
    const unitSel = document.getElementById('energy-unit');
    if (unitSel) unitSel.value = _energyCfg.unit || 'usd';
    modal?.classList.add('open');
    back?.classList.add('open');
}
function closeEnergyConfig() {
    document.getElementById('energy-modal')?.classList.remove('open');
    document.getElementById('energy-backdrop')?.classList.remove('open');
}
document.getElementById('energy-config-btn')?.addEventListener('click', openEnergyConfig);
document.getElementById('so-energy-cfg-btn')?.addEventListener('click', openEnergyConfig); // reachable in streamer mode
document.getElementById('energy-backdrop')?.addEventListener('click', closeEnergyConfig);
document.getElementById('energy-close-btn')?.addEventListener('click', closeEnergyConfig);
document.getElementById('energy-auto')?.addEventListener('change', (e) => {
    document.getElementById('energy-max').disabled = e.target.checked;
});
document.getElementById('energy-save-btn')?.addEventListener('click', () => {
    _energyCfg.auto = document.getElementById('energy-auto').checked;
    _energyCfg.min  = parseFloat(document.getElementById('energy-min').value) || 0;
    const maxV      = parseFloat(document.getElementById('energy-max').value);
    _energyCfg.max  = Number.isFinite(maxV) ? maxV : null;
    _energyCfg.unit = document.getElementById('energy-unit')?.value || 'usd';
    saveEnergyCfg();
    refreshPollenBalance();   // re-render chip + energy in the new unit
    updateEnergyUI();
    closeEnergyConfig();
});
document.getElementById('energy-reset-btn')?.addEventListener('click', () => {
    // Re-baseline "full" to the current balance
    _pollenStart = _pollenNow;
    _pollenLast  = _pollenNow;
    _usageLog    = [];
    updateEnergyUI();
});

// ────────────────────────────────────────────────────────────
// 22. BOOT
// ────────────────────────────────────────────────────────────
restoreProviderState();
// After restoring provider state, fetch the right model list
if (activeProvider.id === 'custom') {
    // Only auto-fetch if base URL is already configured
    if (window._customApiBase || localStorage.getItem('sm64_custom_base')) {
        fetchCustomModels();
    } else {
        populateModelDropdown(); // shows "Set Base URL" prompt
    }
} else if (activeProvider.id === 'pollinations') {
    fetchVisionModels();
} else {
    populateModelDropdown(); // static list for openai/anthropic/gemini/local
}
initAuth();
renderControlsGuide(null);   // show static controls immediately
// Voices may not be loaded yet — wait for them then re-render tutorial if open
window.speechSynthesis?.addEventListener('voiceschanged', () => {});

// Restore streamer mode if it was on last session
if (_streamerMode) setStreamerMode(true);

// Pollen balance chip — refresh now and every 60s
refreshPollenBalance();
setInterval(refreshPollenBalance, 60000);

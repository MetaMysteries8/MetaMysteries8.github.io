// ─────────────────────────────────────────────────────────────────────────
// voice.js — Realtime VOICE ASSISTANT for the SM64-AI app (separate from RT Play).
// Talk to gpt-realtime-2; it answers in its own voice and CONTROLS THE APP by
// calling tools (start/stop, set mode, cheater, deep-train, hyper, status).
// Speech-to-speech; browser SpeechSynthesis is the free text-mode fallback.
// Push-to-talk, hands-free (server VAD), wake word. Chrome + mic. (RT Play — the
// model actually playing Mario — lives in rtplay.js, a separate system.)
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';
    const RT_URL = 'wss://gen.pollinations.ai/v1/realtime?model=gpt-realtime-2';
    const SR = 24000;
    const $ = id => document.getElementById(id);
    const B = () => window.sm64Voice || {};

    let ws = null, connected = false;
    let micStream = null, micCtx = null, micNode = null, micSrc = null, micZero = null, micReady = false;
    let playCtx = null, playHead = 0, liveSources = [], audioMuted = false;
    let talking = false, mode = 'ptt', speakBack = true, curText = '', sentSamples = 0;
    const handledCalls = new Set();
    let recog = null, wakePhrase = 'hey mario';

    const SYS_PROMPT =
        "You are the friendly voice assistant inside an SM64 AI-player web app. The user " +
        "speaks to you and you CONTROL the app by calling tools: start_playing / stop_playing, " +
        "set_mode (ai, rl, player-teach, ai-teach, rtplay), set_cheater, deep_train, set_hyper_speed, " +
        "and get_status. Call the right tool, then confirm in one short spoken sentence. Never read raw JSON.";

    const TOOLS = [
        { type: 'function', name: 'set_mode', description: 'Set the play mode.', parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['ai', 'rl', 'player-teach', 'ai-teach', 'rtplay'] } }, required: ['mode'] } },
        { type: 'function', name: 'start_playing', description: 'Start the AI playing; optionally pass a mode.', parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['ai', 'rl', 'player-teach', 'ai-teach', 'rtplay'] } } } },
        { type: 'function', name: 'stop_playing', description: 'Stop the AI player.', parameters: { type: 'object', properties: {} } },
        { type: 'function', name: 'set_cheater', description: "Turn the Cheater (LRL) model on/off.", parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } },
        { type: 'function', name: 'deep_train', description: 'Start or stop the Deep Trainer grinding.', parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } },
        { type: 'function', name: 'set_hyper_speed', description: 'Toggle hyper-speed (risky, can crash the game).', parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } },
        { type: 'function', name: 'get_status', description: 'Get current game + training status.', parameters: { type: 'object', properties: {} } },
    ];

    function runTool(name, a) {
        const b = B(); a = a || {};
        try {
            switch (name) {
                case 'set_mode': b.mode && b.mode(a.mode); return { ok: true, mode: a.mode };
                case 'start_playing': b.start && b.start(a.mode); return { ok: true, mode: a.mode || (b.status && b.status().mode) };
                case 'stop_playing': b.stop && b.stop(); return { ok: true };
                case 'set_cheater': b.cheater && b.cheater(!!a.on); return { ok: true, on: !!a.on };
                case 'deep_train': b.deepTrain && b.deepTrain(!!a.on); return { ok: true, on: !!a.on };
                case 'set_hyper_speed': b.hyper && b.hyper(!!a.on); return { ok: true, on: !!a.on };
                case 'get_status': return (b.status && b.status()) || {};
                default: return { error: 'unknown tool ' + name };
            }
        } catch (e) { return { error: String(e) }; }
    }

    function setStatus(s) { const el = $('voice-status'); if (el) el.textContent = s; }
    function log(role, msg) {
        const el = $('voice-log'); if (!el) return;
        const d = document.createElement('div'); d.className = 'vl-' + role;
        d.textContent = (role === 'you' ? '🗣 ' : role === 'ai' ? '🤖 ' : role === 'tool' ? '⚙ ' : '• ') + msg;
        el.appendChild(d); el.scrollTop = el.scrollHeight;
        while (el.childNodes.length > 60) el.removeChild(el.firstChild);
    }
    function setAssistant(t) {
        const el = $('voice-log'); if (!el) return;
        let last = el.lastChild;
        if (!last || !last.classList || !last.classList.contains('vl-ai') || last._partial !== true) {
            last = document.createElement('div'); last.className = 'vl-ai'; last._partial = true; el.appendChild(last);
        }
        last.textContent = '🤖 ' + t; el.scrollTop = el.scrollHeight;
    }
    function finalizeAssistant() { const el = $('voice-log'); const last = el && el.lastChild; if (last && last._partial) last._partial = false; }

    async function connect() {
        if (connected) return;
        const key = (B().key && B().key()) || '';
        if (!key) setStatus('no API key — connect your account first');
        try { ws = new WebSocket(RT_URL + (key ? '&key=' + encodeURIComponent(key) : '')); }
        catch (e) { setStatus('connect failed'); console.warn('[voice]', e); return; }
        ws.onopen = () => { connected = true; setStatus('connected'); sendSession(); log('sys', 'connected to gpt-realtime-2'); updateButtons(); };
        ws.onclose = () => { connected = false; setStatus('disconnected'); updateButtons(); };
        ws.onerror = () => setStatus('socket error');
        ws.onmessage = onMessage;
    }
    function disconnect() { try { ws && ws.close(); } catch {} connected = false; stopMic(); updateButtons(); }
    function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
    function sendSession() {
        const s = { type: 'realtime', instructions: SYS_PROMPT, output_modalities: speakBack ? ['audio'] : ['text'], tools: TOOLS, tool_choice: 'auto' };
        const audio = {};
        if (speakBack) audio.output = { voice: 'alloy' };
        if (mode === 'vad') audio.input = { turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 } };
        if (Object.keys(audio).length) s.audio = audio;
        send({ type: 'session.update', session: s });
    }
    function sendText(t) {
        if (!t) return;
        if (!connected) { connect().then(() => setTimeout(() => sendText(t), 400)); return; }
        interrupt();
        send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } });
        send({ type: 'response.create' });
        log('you', t); setStatus('thinking…');
    }

    function onMessage(ev) {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        console.log('[voice] ◀', m.type, m.error ? JSON.stringify(m.error) : '');
        if (m.type && /\.error$|^error$/.test(m.type)) { const msg = (m.error && (m.error.message || m.error.code)) || JSON.stringify(m.error || m); log('sys', 'ERROR: ' + msg); setStatus('err: ' + msg); return; }
        switch (m.type) {
            case 'session.created': log('sys', 'session ready'); break;
            case 'response.created': audioMuted = false; setStatus('responding…'); break;
            case 'response.audio.delta':
            case 'response.output_audio.delta': if (speakBack && !audioMuted) playPCM(m.delta); break;
            case 'response.audio_transcript.delta':
            case 'response.output_audio_transcript.delta':
            case 'response.text.delta':
            case 'response.output_text.delta': curText += (m.delta || ''); setAssistant(curText); break;
            case 'response.function_call_arguments.done':
                execToolItem({ name: m.name, call_id: m.call_id, arguments: m.arguments }); break;
            case 'response.done': {
                const out = (m.response && m.response.output) || [];
                for (const it of out) if (it.type === 'function_call') execToolItem(it);
                if (curText) { if (!speakBack) speakText(curText); finalizeAssistant(); }
                curText = '';
                if (mode !== 'vad' && !talking) setStatus('ready');
                break;
            }
            case 'input_audio_buffer.speech_started': stopAudio(); setStatus('listening…'); break;
            case 'input_audio_buffer.speech_stopped': setStatus('thinking…'); break;
        }
    }
    function execToolItem(it) {
        if (!it || !it.name || (it.call_id && handledCalls.has(it.call_id))) return;
        if (it.call_id) handledCalls.add(it.call_id);
        let args = {}; try { args = JSON.parse(it.arguments || '{}'); } catch {}
        const result = runTool(it.name, args);
        log('tool', it.name + '(' + JSON.stringify(args) + ') → ' + JSON.stringify(result));
        if (it.call_id) send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: it.call_id, output: JSON.stringify(result) } });
        send({ type: 'response.create' });
    }

    function playPCM(b64) {
        if (!b64) return;
        if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)();
        const bin = atob(b64), n = bin.length >> 1, i16 = new Int16Array(n);
        for (let i = 0; i < n; i++) { let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); i16[i] = v >= 32768 ? v - 65536 : v; }
        const buf = playCtx.createBuffer(1, n, SR), ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) ch[i] = i16[i] / 32768;
        const src = playCtx.createBufferSource(); src.buffer = buf; src.connect(playCtx.destination);
        const now = playCtx.currentTime; if (playHead < now) playHead = now;
        src.start(playHead); playHead += buf.duration;
        liveSources.push(src);
        src.onended = () => { const i = liveSources.indexOf(src); if (i >= 0) liveSources.splice(i, 1); };
    }
    // Cut whatever it's saying RIGHT NOW and cancel the in-flight response (barge-in).
    function stopAudio() {
        audioMuted = true;
        for (const s of liveSources) { try { s.stop(); } catch {} }
        liveSources = [];
        if (playCtx) playHead = playCtx.currentTime;
        try { speechSynthesis.cancel(); } catch {}
    }
    function interrupt() { stopAudio(); try { send({ type: 'response.cancel' }); } catch {} curText = ''; }
    function speakText(t) { try { const u = new SpeechSynthesisUtterance(t); speechSynthesis.speak(u); } catch {} }

    async function startMic() {
        if (micReady) return true;
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
            micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
            micSrc = micCtx.createMediaStreamSource(micStream);
            micNode = micCtx.createScriptProcessor(2048, 1, 1);
            micZero = micCtx.createGain(); micZero.gain.value = 0;
            micNode.onaudioprocess = (e) => {
                if (!talking || !connected) return;
                const f = e.inputBuffer.getChannelData(0), i16 = new Int16Array(f.length);
                for (let i = 0; i < f.length; i++) { let s = f[i] < -1 ? -1 : f[i] > 1 ? 1 : f[i]; i16[i] = s < 0 ? s * 32768 : s * 32767; }
                send({ type: 'input_audio_buffer.append', audio: i16ToB64(i16) });
                sentSamples += i16.length;
            };
            micSrc.connect(micNode); micNode.connect(micZero); micZero.connect(micCtx.destination);
            micReady = true; return true;
        } catch (e) { setStatus('mic denied'); console.warn('[voice] mic', e); return false; }
    }
    function stopMic() {
        talking = false; micReady = false;
        try { micNode && (micNode.onaudioprocess = null); } catch {}
        try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch {}
        try { micCtx && micCtx.close(); } catch {}
        micStream = micCtx = micNode = micSrc = micZero = null;
    }
    function i16ToB64(i16) { const b = new Uint8Array(i16.buffer); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }

    async function beginTalk() {
        if (!connected) await connect();
        interrupt();                       // barge-in: cut its current speech the moment you talk
        if (!(await startMic())) return;
        sentSamples = 0; talking = true; setStatus('listening…');
    }
    function endTalk() {
        if (!talking) return;
        talking = false;
        if (mode === 'vad') return;
        if (sentSamples < 2400) { setStatus('no audio captured — check mic'); log('sys', 'no audio captured (' + sentSamples + ' samples). Try the text box.'); return; }
        setStatus('thinking…'); log('you', '(' + Math.round(sentSamples / SR * 100) / 100 + 's audio)');
        send({ type: 'input_audio_buffer.commit' }); send({ type: 'response.create' });
    }
    async function setHandsFree(on) {
        if (on) { mode = 'vad'; if (!connected) await connect(); sendSession(); if (await startMic()) { talking = true; setStatus('hands-free — listening'); } }
        else { mode = 'ptt'; talking = false; sendSession(); setStatus('push-to-talk'); }
    }

    function startWake() {
        const SRc = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SRc) { setStatus('wake word needs Chrome speech recognition'); return; }
        mode = 'wake'; stopWakeRecog();
        recog = new SRc(); recog.continuous = true; recog.interimResults = false; recog.lang = 'en-US';
        recog.onresult = (e) => { const txt = e.results[e.results.length - 1][0].transcript.toLowerCase(); if (txt.includes(wakePhrase)) { log('sys', 'wake: "' + wakePhrase + '"'); wakeTurn(); } };
        recog.onend = () => { if (mode === 'wake') { try { recog.start(); } catch {} } };
        try { recog.start(); setStatus('wake word: say "' + wakePhrase + '"'); } catch (e) { console.warn('[voice] recog', e); }
    }
    function stopWakeRecog() { try { recog && (recog.onend = null, recog.stop()); } catch {} recog = null; }
    async function wakeTurn() {
        if (!connected) await connect();
        mode = 'vad'; sendSession();
        if (await startMic()) { talking = true; setStatus('listening (wake)…'); }
        setTimeout(() => { if (mode === 'vad') { talking = false; mode = 'wake'; } }, 9000);
    }

    function updateButtons() {
        const c = $('voice-connect'); if (c) { c.textContent = connected ? '🔌 Disconnect' : '🔗 Connect'; c.classList.toggle('green', !connected); }
        const b = $('voice-btn'); if (b) b.classList.toggle('active', connected);
    }
    function openPanel() { $('voice-modal') && $('voice-modal').classList.add('open'); $('voice-backdrop') && $('voice-backdrop').classList.add('open'); }
    function closePanel() { $('voice-modal') && $('voice-modal').classList.remove('open'); $('voice-backdrop') && $('voice-backdrop').classList.remove('open'); }

    function wire() {
        const btn = $('voice-btn'); if (btn) btn.addEventListener('click', openPanel);
        $('voice-close') && $('voice-close').addEventListener('click', closePanel);
        $('voice-backdrop') && $('voice-backdrop').addEventListener('click', closePanel);
        $('voice-connect') && $('voice-connect').addEventListener('click', () => connected ? disconnect() : connect());
        const speak = $('voice-speak'); if (speak) { speak.checked = speakBack; speak.addEventListener('change', e => { speakBack = e.target.checked; if (connected) sendSession(); }); }
        const ph = $('voice-wakephrase'); if (ph) { ph.value = wakePhrase; ph.addEventListener('change', e => { wakePhrase = (e.target.value || 'hey mario').toLowerCase(); }); }
        const modeSel = $('voice-mode');
        if (modeSel) modeSel.addEventListener('change', e => {
            stopWakeRecog(); const v = e.target.value;
            if (v === 'vad') setHandsFree(true);
            else if (v === 'wake') { setHandsFree(false); startWake(); }
            else setHandsFree(false);
        });
        const ptt = $('voice-ptt-btn');
        if (ptt) {
            const down = (ev) => { ev.preventDefault(); if (mode === 'ptt') beginTalk(); };
            const up = (ev) => { ev.preventDefault(); if (mode === 'ptt') endTalk(); };
            ptt.addEventListener('pointerdown', down); ptt.addEventListener('pointerup', up);
            ptt.addEventListener('pointerleave', up); ptt.addEventListener('pointercancel', up);
        }
        const txt = $('voice-text'), sendBtn = $('voice-send');
        const doSend = () => { if (txt && txt.value.trim()) { sendText(txt.value.trim()); txt.value = ''; } };
        if (sendBtn) sendBtn.addEventListener('click', doSend);
        if (txt) txt.addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });
        updateButtons();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
    window.sm64VoiceAgent = { connect, disconnect, open: openPanel };
})();

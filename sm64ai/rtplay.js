// ─────────────────────────────────────────────────────────────────────────
// rtplay.js — RT PLAY: gpt-realtime-2 SEES the screen and PLAYS Mario itself.
// A SEPARATE system from the voice assistant (voice.js): its own realtime
// connection, its own control overlay, and ONLY a move tool (no app-control tools).
// Each turn it gets the current frame as an image and calls move(); it narrates via
// native TTS. Guide it live by voice (hold the Talk key) or text. Started by the
// "rtplay" play mode (main.js) via window.sm64RtPlay.start()/stop(). Chrome + mic.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';
    const RT_URL = 'wss://gen.pollinations.ai/v1/realtime?model=gpt-realtime-2';
    const SR = 24000;
    const B = () => window.sm64Voice || {};   // reuse the app bridge (key + rt frame/act)

    let ws = null, connected = false, playing = false, busy = false, auto = true;
    let task = 'Beat the game — make progress, collect stars, explore, and avoid dying.';
    let timer = null, curText = '';
    let micStream = null, micCtx = null, micNode = null, micSrc = null, micZero = null, micReady = false, talking = false, sentSamples = 0;
    let playCtx = null, playHead = 0;
    let speakBack = true;
    let pttKey = 'Backquote', textKey = 'KeyT', capturing = null;
    try { pttKey = localStorage.getItem('sm64_rt_ptt') || 'Backquote'; textKey = localStorage.getItem('sm64_rt_textkey') || 'KeyT'; } catch {}

    const MOVE_ENUM = ['forward', 'backward', 'turn', 'forward-left', 'forward-right', 'jump', 'jump-forward', 'long_jump', 'dive', 'ground_pound', 'crouch', 'wait'];
    const MOVE_TOOL = { type: 'function', name: 'move', description: 'Control Mario RIGHT NOW. The movement is HELD until your next move() call, so call it every turn.', parameters: { type: 'object', properties: { action: { type: 'string', enum: MOVE_ENUM }, say: { type: 'string', description: 'optional brief commentary' } }, required: ['action'] } };

    // ── overlay UI (built once, lives in its own corner panel) ──
    let el = {};
    function buildUI() {
        if (el.root) return;
        const d = document.createElement('div'); d.id = 'rtp-panel';
        d.innerHTML =
            '<div class="rtp-head"><b>🎮 RT Play</b> <span id="rtp-status">idle</span><button id="rtp-min" title="hide">▭</button></div>' +
            '<label class="rtp-row"><span>Task</span><input id="rtp-task" type="text"></label>' +
            '<label class="rtp-row" style="flex-direction:row;gap:6px;align-items:center"><input id="rtp-auto" type="checkbox" checked> Auto-play (off = only when you ask)</label>' +
            '<div class="rtp-keys"><button id="rtp-ptt" title="Hold to talk to it">🎤 Hold to talk</button>' +
            '<button id="rtp-bind-ptt" title="rebind talk key">Talk: `</button><button id="rtp-bind-text" title="rebind type key">Type: T</button></div>' +
            '<div class="rtp-row" style="flex-direction:row;gap:6px"><input id="rtp-text" type="text" placeholder="…or type a command" style="flex:1"><button id="rtp-send">Send</button></div>' +
            '<div id="rtp-log"></div>';
        document.body.appendChild(d); el.root = d;
        el.status = d.querySelector('#rtp-status'); el.log = d.querySelector('#rtp-log');
        el.task = d.querySelector('#rtp-task'); el.task.value = task; el.task.addEventListener('change', e => setTask(e.target.value));
        el.auto = d.querySelector('#rtp-auto'); el.auto.checked = auto; el.auto.addEventListener('change', e => setAuto(e.target.checked));
        d.querySelector('#rtp-min').addEventListener('click', () => d.classList.toggle('rtp-hidden'));
        const ptt = d.querySelector('#rtp-ptt');
        const down = ev => { ev.preventDefault(); beginTalk(); }, up = ev => { ev.preventDefault(); endTalk(); };
        ptt.addEventListener('pointerdown', down); ptt.addEventListener('pointerup', up); ptt.addEventListener('pointerleave', up); ptt.addEventListener('pointercancel', up);
        el.bindP = d.querySelector('#rtp-bind-ptt'); el.bindT = d.querySelector('#rtp-bind-text');
        el.bindP.addEventListener('click', () => { capturing = 'ptt'; el.bindP.textContent = 'press…'; });
        el.bindT.addEventListener('click', () => { capturing = 'text'; el.bindT.textContent = 'press…'; });
        const ti = d.querySelector('#rtp-text'), sb = d.querySelector('#rtp-send');
        const doSend = () => { if (ti.value.trim()) { guide(ti.value.trim()); ti.value = ''; } };
        sb.addEventListener('click', doSend); ti.addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });
        el.textInput = ti;
        updateKeyLabels();
    }
    function show(on) { buildUI(); el.root.style.display = on ? 'block' : 'none'; }
    function setStatus(s) { if (el.status) el.status.textContent = s; }
    function log(role, msg) {
        if (!el.log) return;
        const d = document.createElement('div'); d.className = 'rtp-' + role;
        d.textContent = (role === 'you' ? '🗣 ' : role === 'ai' ? '🤖 ' : role === 'move' ? '🎮 ' : '• ') + msg;
        el.log.appendChild(d); el.log.scrollTop = el.log.scrollHeight;
        while (el.log.childNodes.length > 40) el.log.removeChild(el.log.firstChild);
    }
    function keyLabel(code) { if (code === 'Backquote') return '`'; if (code === 'Space') return 'Space'; const m = /^Key([A-Z])$/.exec(code) || /^Digit(\d)$/.exec(code); return m ? m[1] : (code || '—'); }
    function updateKeyLabels() { if (el.bindP) el.bindP.textContent = 'Talk: ' + keyLabel(pttKey); if (el.bindT) el.bindT.textContent = 'Type: ' + keyLabel(textKey); }
    function setBinding(which, code) {
        if (which === 'ptt') { if (code === textKey) return; pttKey = code; try { localStorage.setItem('sm64_rt_ptt', code); } catch {} }
        else { if (code === pttKey) return; textKey = code; try { localStorage.setItem('sm64_rt_textkey', code); } catch {} }
        updateKeyLabels();
    }

    // ── realtime connection (its own) ──
    async function connect() {
        if (connected) return;
        const key = (B().key && B().key()) || '';
        try { ws = new WebSocket(RT_URL + (key ? '&key=' + encodeURIComponent(key) : '')); }
        catch (e) { setStatus('connect failed'); console.warn('[rtplay]', e); return; }
        await new Promise(res => {
            ws.onopen = () => { connected = true; setStatus('connected'); session(); log('sys', 'RT Play connected'); res(); };
            ws.onclose = () => { connected = false; setStatus('disconnected'); };
            ws.onerror = () => setStatus('socket error');
            ws.onmessage = onMessage;
            setTimeout(res, 4000);
        });
    }
    function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
    function prompt() {
        return "You ARE playing Super Mario 64 in REAL TIME. Each turn you get the current screen as an image. " +
            "Decide Mario's next movement and CALL the move tool — it is HELD until your next call, so call it every turn. " +
            "YOUR TASK: " + task + ". Keep Mario progressing; if stuck, try jumping, turning, or a long jump. Brief, occasional " +
            "commentary only. The user may interrupt by voice or text to change the task or guide you — always obey them.";
    }
    function session() {
        const s = { type: 'realtime', instructions: prompt(), output_modalities: speakBack ? ['audio'] : ['text'], tools: [MOVE_TOOL], tool_choice: 'auto' };
        if (speakBack) s.audio = { output: { voice: 'alloy' } };
        send({ type: 'session.update', session: s });
    }

    function onMessage(ev) {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        console.log('[rtplay] ◀', m.type, m.error ? JSON.stringify(m.error) : '');
        if (m.type && /\.error$|^error$/.test(m.type)) { const msg = (m.error && (m.error.message || m.error.code)) || JSON.stringify(m.error || m); log('sys', 'ERROR: ' + msg); setStatus('err'); return; }
        switch (m.type) {
            case 'response.audio.delta':
            case 'response.output_audio.delta': if (speakBack) playPCM(m.delta); break;
            case 'response.audio_transcript.delta':
            case 'response.output_audio_transcript.delta':
            case 'response.text.delta':
            case 'response.output_text.delta': curText += (m.delta || ''); break;
            case 'response.function_call_arguments.done':
                execMove({ name: m.name, call_id: m.call_id, arguments: m.arguments }); break;
            case 'response.done': {
                const out = (m.response && m.response.output) || [];
                for (const it of out) if (it.type === 'function_call') execMove(it);
                if (curText) { log('ai', curText); if (!speakBack) speakText(curText); }
                curText = '';
                if (playing) { busy = false; if (auto) { clearTimeout(timer); timer = setTimeout(tick, 500); } setStatus('RT Play'); }
                break;
            }
        }
    }
    const handled = new Set();
    function execMove(it) {
        if (!it || it.name !== 'move' || (it.call_id && handled.has(it.call_id))) return;
        if (it.call_id) handled.add(it.call_id);
        let a = {}; try { a = JSON.parse(it.arguments || '{}'); } catch {}
        try { B().rt && B().rt.act && B().rt.act(a.action); } catch {}
        log('move', a.action + (a.say ? ' — ' + a.say : ''));
        if (it.call_id) send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: it.call_id, output: JSON.stringify({ ok: true }) } });
        // No follow-up response.create — the tick loop drives the next frame.
    }

    // ── play loop ──
    async function tick() {
        if (!playing || !connected) return;
        if (busy || talking) { timer = setTimeout(tick, 300); return; }
        if (!auto) return;
        await turn(null);
    }
    async function turn(extra) {
        if (!playing || !connected || busy) return;
        let frame = null; try { frame = (B().rt && B().rt.frame) ? await B().rt.frame() : null; } catch {}
        const content = [{ type: 'input_text', text: (extra ? ('User says: ' + extra + '\n') : '') + 'Screen now. Call move() for the next action. Task: ' + task }];
        if (frame) content.push({ type: 'input_image', image_url: frame });
        send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content } });
        send({ type: 'response.create' });
        busy = true; setStatus('RT Play — thinking');
    }
    function guide(text) {
        if (!playing) return;
        if (text) log('you', text);
        try { send({ type: 'response.cancel' }); } catch {}
        busy = false; turn(text || null);
    }
    function setTask(t) { if (t && t.trim()) { task = t.trim(); if (playing) { session(); log('sys', 'task → ' + task); } } }
    function setAuto(on) { auto = !!on; if (playing && auto && !busy) tick(); }

    // ── audio playback + mic (own) ──
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
    }
    function speakText(t) { try { speechSynthesis.speak(new SpeechSynthesisUtterance(t)); } catch {} }
    function i16ToB64(i16) { const b = new Uint8Array(i16.buffer); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
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
                send({ type: 'input_audio_buffer.append', audio: i16ToB64(i16) }); sentSamples += i16.length;
            };
            micSrc.connect(micNode); micNode.connect(micZero); micZero.connect(micCtx.destination);
            micReady = true; return true;
        } catch (e) { setStatus('mic denied'); console.warn('[rtplay] mic', e); return false; }
    }
    function stopMic() {
        talking = false; micReady = false;
        try { micNode && (micNode.onaudioprocess = null); } catch {}
        try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch {}
        try { micCtx && micCtx.close(); } catch {}
        micStream = micCtx = micNode = micSrc = micZero = null;
    }
    async function beginTalk() {
        if (!playing) return;
        if (!(await startMic())) return;
        sentSamples = 0; talking = true; setStatus('listening…');
    }
    function endTalk() {
        if (!talking) return; talking = false;
        if (sentSamples < 2400) { setStatus('no audio — check mic'); return; }
        log('you', '(' + Math.round(sentSamples / SR * 100) / 100 + 's audio)');
        try { send({ type: 'response.cancel' }); } catch {}
        send({ type: 'input_audio_buffer.commit' });
        busy = true; setStatus('RT Play — guiding');
        (B().rt && B().rt.frame ? B().rt.frame() : Promise.resolve(null)).then(f => {
            if (f) send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: f }] } });
            send({ type: 'response.create' });
        });
    }

    // ── global hotkeys ──
    document.addEventListener('keydown', e => {
        if (capturing) { e.preventDefault(); if (e.code !== 'Escape') setBinding(capturing, e.code); capturing = null; updateKeyLabels(); return; }
        const tag = e.target && e.target.tagName; if (tag && /INPUT|TEXTAREA|SELECT/.test(tag)) return;
        if (!playing) return;
        if (e.code === pttKey) { e.preventDefault(); if (!talking) beginTalk(); }
        else if (e.code === textKey) { e.preventDefault(); el.textInput && el.textInput.focus(); }
    });
    document.addEventListener('keyup', e => { if (e.code === pttKey && talking) { e.preventDefault(); endTalk(); } });

    // ── lifecycle (called by main.js when the rtplay mode starts/stops) ──
    async function start() {
        if (playing) return;
        buildUI(); show(true);
        await connect();
        playing = true; busy = false;
        session(); log('sys', '🎮 task: ' + task); setStatus('RT Play');
        setTimeout(tick, 700);
    }
    function stop() {
        playing = false; if (timer) { clearTimeout(timer); timer = null; }
        try { B().rt && B().rt.release && B().rt.release(); } catch {}
        stopMic();
        try { ws && ws.close(); } catch {} connected = false;
        setStatus('stopped'); show(false);
    }
    window.sm64RtPlay = { start, stop, guide };
})();

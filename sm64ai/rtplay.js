// ─────────────────────────────────────────────────────────────────────────
// rtplay.js — RT PLAY (guided): gpt-realtime-2 WATCHES the screen and COACHES
// YOU in real time. It does NOT control Mario — the human plays; the AI guides.
// A SEPARATE system from the voice assistant (voice.js): its own realtime
// connection and its own corner overlay. No move tool (the model was terrible at
// mapping perception → controls). Each look it gets the current frame and gives
// SHORT spoken guidance. Ask it anything by voice (hold the Talk key) or text;
// talking BARGES IN and cuts its audio instantly. Started by the "rtplay" play
// mode (main.js) via window.sm64RtPlay.start()/stop(). Chrome + mic.
// ─────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';
    const RT_URL = 'wss://gen.pollinations.ai/v1/realtime?model=gpt-realtime-2';
    const SR = 24000;
    const B = () => window.sm64Voice || {};   // reuse the app bridge (key + rt frame)

    let ws = null, connected = false, playing = false, busy = false, auto = true;
    let task = 'Beat the game — make progress, collect stars, explore, and avoid dying.';
    let timer = null, curText = '';
    let micStream = null, micCtx = null, micNode = null, micSrc = null, micZero = null, micReady = false, talking = false, sentSamples = 0;
    let playCtx = null, playHead = 0, liveSources = [], audioMuted = false;
    let speakBack = true;
    let pttKey = 'Backquote', textKey = 'KeyT', capturing = null;
    try { pttKey = localStorage.getItem('sm64_rt_ptt') || 'Backquote'; textKey = localStorage.getItem('sm64_rt_textkey') || 'KeyT'; } catch {}

    // ── overlay UI (built once, lives in its own corner panel) ──
    let el = {};
    function buildUI() {
        if (el.root) return;
        const d = document.createElement('div'); d.id = 'rtp-panel';
        d.innerHTML =
            '<div class="rtp-head"><b>🎓 RT Coach</b> <span id="rtp-status">idle</span><button id="rtp-min" title="hide">▭</button></div>' +
            '<label class="rtp-row"><span>Goal it coaches toward</span><input id="rtp-task" type="text"></label>' +
            '<label class="rtp-row" style="flex-direction:row;gap:6px;align-items:center"><input id="rtp-auto" type="checkbox" checked> Auto-coach (off = only when you ask)</label>' +
            '<div class="rtp-keys"><button id="rtp-ptt" title="Hold to talk — interrupts it">🎤 Hold to talk</button>' +
            '<button id="rtp-bind-ptt" title="rebind talk key">Talk: `</button><button id="rtp-bind-text" title="rebind type key">Type: T</button></div>' +
            '<div class="rtp-row" style="flex-direction:row;gap:6px"><input id="rtp-text" type="text" placeholder="…or ask a question / change the goal" style="flex:1"><button id="rtp-send">Ask</button></div>' +
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
        d.textContent = (role === 'you' ? '🗣 ' : role === 'ai' ? '🤖 ' : role === 'tip' ? '💡 ' : '• ') + msg;
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
            ws.onopen = () => { connected = true; setStatus('connected'); session(); log('sys', 'RT Coach connected'); res(); };
            ws.onclose = () => { connected = false; setStatus('disconnected'); };
            ws.onerror = () => setStatus('socket error');
            ws.onmessage = onMessage;
            setTimeout(res, 4000);
        });
    }
    function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
    function prompt() {
        return "You are a friendly, expert Super Mario 64 COACH watching the player's screen in REAL TIME. " +
            "You do NOT control the game — the HUMAN plays; you only GUIDE them. Each look you get the current frame. " +
            "Give SHORT, timely spoken guidance: where to go next, when to jump, hazards to avoid, how to reach the next star. " +
            "One or two sentences MAX, and only when it actually helps — silence is fine if nothing changed. Never read out button " +
            "names or pretend to press anything. GOAL you're coaching toward: " + task + ". " +
            "The player may talk or type any time to ask a question or change the goal — answer them directly and briefly.";
    }
    function session() {
        // No tools: the model coaches with speech/text only. It never controls Mario.
        const s = { type: 'realtime', instructions: prompt(), output_modalities: speakBack ? ['audio'] : ['text'], tool_choice: 'none' };
        if (speakBack) s.audio = { output: { voice: 'alloy' } };
        send({ type: 'session.update', session: s });
    }

    function onMessage(ev) {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        console.log('[rtplay] ◀', m.type, m.error ? JSON.stringify(m.error) : '');
        if (m.type && /\.error$|^error$/.test(m.type)) { const msg = (m.error && (m.error.message || m.error.code)) || JSON.stringify(m.error || m); log('sys', 'ERROR: ' + msg); setStatus('err'); return; }
        switch (m.type) {
            case 'response.created': audioMuted = false; break;  // a new answer starts → let its audio through
            case 'response.audio.delta':
            case 'response.output_audio.delta': if (speakBack && !audioMuted) playPCM(m.delta); break;
            case 'response.audio_transcript.delta':
            case 'response.output_audio_transcript.delta':
            case 'response.text.delta':
            case 'response.output_text.delta': curText += (m.delta || ''); break;
            case 'response.done': {
                if (curText) { log('tip', curText.trim()); if (!speakBack) speakText(curText); }
                curText = '';
                if (playing) { busy = false; if (auto) { clearTimeout(timer); timer = setTimeout(look, 2600); } setStatus('RT Coach'); }
                break;
            }
        }
    }

    // ── coaching loop (auto = periodic glance; otherwise only when you ask) ──
    async function look() {
        if (!playing || !connected) return;
        if (busy || talking) { timer = setTimeout(look, 400); return; }
        if (!auto) return;
        await observe(null);
    }
    async function observe(extra) {
        if (!playing || !connected || busy) return;
        let frame = null; try { frame = (B().rt && B().rt.frame) ? await B().rt.frame() : null; } catch {}
        const ask = extra
            ? ('The player says: "' + extra + '". Answer them, using the current screen.')
            : 'Glance at the screen. If a short tip would help me reach the goal right now, give it — otherwise stay brief or quiet.';
        const content = [{ type: 'input_text', text: ask }];
        if (frame) content.push({ type: 'input_image', image_url: frame });
        send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content } });
        send({ type: 'response.create' });
        busy = true; setStatus(extra ? 'RT Coach — answering' : 'RT Coach — looking');
    }
    function guide(text) {
        if (!playing) return;
        if (text) log('you', text);
        interrupt();
        observe(text || null);
    }
    function setTask(t) { if (t && t.trim()) { task = t.trim(); if (playing) { session(); log('sys', 'goal → ' + task); } } }
    function setAuto(on) { auto = !!on; if (playing && auto && !busy) look(); }

    // ── audio playback + clean barge-in interrupt ──
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
    // Cut whatever it's saying RIGHT NOW and cancel the in-flight response.
    function stopAudio() {
        audioMuted = true;
        for (const s of liveSources) { try { s.stop(); } catch {} }
        liveSources = [];
        if (playCtx) playHead = playCtx.currentTime;
        try { speechSynthesis.cancel(); } catch {}
    }
    function interrupt() {
        stopAudio();
        try { send({ type: 'response.cancel' }); } catch {}
        busy = false; curText = '';
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
        interrupt();                       // barge-in: cut its current speech the instant you start talking
        if (!(await startMic())) return;
        sentSamples = 0; talking = true; setStatus('listening…');
    }
    function endTalk() {
        if (!talking) return; talking = false;
        if (sentSamples < 2400) { setStatus('no audio — check mic'); return; }
        log('you', '(' + Math.round(sentSamples / SR * 100) / 100 + 's audio)');
        send({ type: 'input_audio_buffer.commit' });
        busy = true; setStatus('RT Coach — answering');
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
        session(); log('sys', '🎓 coaching goal: ' + task); setStatus('RT Coach');
        setTimeout(look, 900);
    }
    function stop() {
        playing = false; if (timer) { clearTimeout(timer); timer = null; }
        stopAudio();
        stopMic();
        try { ws && ws.close(); } catch {} connected = false;
        setStatus('stopped'); show(false);
    }
    window.sm64RtPlay = { start, stop, guide };
})();

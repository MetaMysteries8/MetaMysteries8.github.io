// Local Laya runtime for SM64 AI.
// Loads the Q4 typed-decisions ONNX export directly in the browser.
// Model: m1rhan/laya-typed-decisions-ONNX (Apache-2.0; independent conversion).
(() => {
    'use strict';

    // Split assets deliberately:
    // - Q4 ONNX graph comes from m1rhan's browser export.
    // - tokenizer + calibrated decision config come from the upstream typed-decisions checkpoint.
    const MODEL_ID = 'm1rhan/laya-typed-decisions-ONNX';
    const TOKENIZER_MODEL_ID = 'm1rhan/laya-typed-decisions-ONNX';
    const MODEL_URL = 'https://huggingface.co/m1rhan/laya-typed-decisions-ONNX/resolve/main/onnx/model_q4.onnx?download=true';
    const CONFIG_URL = 'https://huggingface.co/convaiinnovations/laya-typed-decisions/resolve/main/rl_agent_config.json?download=true';

    // Known-good upstream calibration. Network/config failure should degrade to
    // these values, never prevent the 428 MB graph from loading.
    const FALLBACK_CONFIG = Object.freeze({
        max_len: 1024,
        head_max_len: 256,
        temperature: [1.0148024559020996, 1.0374259948730469, 1.0575125217437744],
        temperature_by_options: {
            'choice:2': 1.9063563346862793,
            'choice:3-5': 1.7601518630981445,
            'choice:6-10': 1.0000158548355103,
            'choice:11+': 0.10058280825614929,
            'score:3-5': 1.2514300346374512,
            'noul:2': 1.983399510383606,
        },
    });
    const ORT_VERSION = '1.23.2';
    const ORT_WEBGPU_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.min.mjs`;
    const HFJS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2';

    let ort = null;
    let tokenizer = null;
    let session = null;
    let config = null;
    let backend = null;
    let initPromise = null;
    let statusSink = null;
    let special = null;
    let lastDecision = null;

    const emit = (message, progress = null) => {
        const detail = { message, progress, backend };
        try { statusSink?.(detail); } catch {}
        try { window.dispatchEvent(new CustomEvent('sm64-laya-status', { detail })); } catch {}
    };

    function flattenIds(v) {
        if (v == null) return [];
        if (Array.isArray(v)) {
            if (v.length === 1 && Array.isArray(v[0])) return v[0].map(Number);
            return v.map(Number);
        }
        if (v.data != null) return Array.from(v.data, Number);
        return Array.from(v, Number);
    }

    async function tokenize(text) {
        const out = await tokenizer(String(text), {
            add_special_tokens: false,
            padding: false,
            truncation: false,
        });
        return flattenIds(out.input_ids);
    }

    async function specialId(prop, token) {
        const direct = Number(tokenizer?.[prop]);
        if (Number.isInteger(direct) && direct >= 0) return direct;
        const ids = await tokenize(token);
        if (ids.length !== 1) throw new Error(`Could not resolve Laya special token ${token}`);
        return ids[0];
    }

    async function resolveSpecialTokens() {
        if (special) return special;
        special = {
            cls: await specialId('cls_token_id', '[CLS]'),
            sep: await specialId('sep_token_id', '[SEP]'),
            mask: await specialId('mask_token_id', '[MASK]'),
            maskText: tokenizer?.mask_token || '[MASK]',
        };
        return special;
    }

    function optionText(opt) {
        if (typeof opt === 'string') return opt;
        const label = String(opt.label ?? opt.value ?? '');
        const desc = String(opt.description ?? '').trim();
        return desc ? `${label}: ${desc}` : label;
    }

    async function buildSequence(state, question, options, maxLen = 384) {
        const sp = await resolveSpecialTokens();
        const headMaxLen = Math.max(32, Math.min(Number(config?.head_max_len || 256), 256));
        const trueMaxLen = Math.max(96, Math.min(Number(config?.max_len || 1024), maxLen));

        let headIds = await tokenize(`choice question: ${String(question).replaceAll(sp.maskText, ' ')}`);
        let optIds = [];
        for (const opt of options) {
            const ids = (await tokenize(' ' + optionText(opt).replaceAll(sp.maskText, ' '))).slice(0, 48);
            optIds.push([sp.mask, ...ids]);
        }

        let optBudget = headMaxLen - optIds.reduce((n, ids) => n + ids.length, 0);
        if (optBudget < 16) {
            const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
            optIds = optIds.map(ids => ids.slice(0, per));
            optBudget = headMaxLen - optIds.reduce((n, ids) => n + ids.length, 0);
        }
        headIds = headIds.slice(0, Math.max(8, optBudget));

        const ids = [sp.cls, ...headIds, sp.sep];
        const markers = [];
        for (const optionIds of optIds) {
            markers.push(ids.length);
            ids.push(...optionIds);
        }
        ids.push(sp.sep);

        const room = Math.max(0, trueMaxLen - ids.length - 1);
        const stateIds = (await tokenize(String(state).replaceAll(sp.maskText, ' '))).slice(0, room);
        ids.push(...stateIds, sp.sep);

        return {
            ids: ids.slice(0, trueMaxLen),
            markers: markers.filter(m => m < trueMaxLen),
        };
    }

    function temperatureFor(k) {
        const size = k <= 2 ? '2' : k <= 5 ? '3-5' : k <= 10 ? '6-10' : '11+';
        const bucket = `choice:${size}`;
        let t = config?.temperature_by_options?.[bucket];
        if (t == null) {
            const base = config?.temperature;
            t = Array.isArray(base) ? base[0] : (base?.[0] ?? base?.choice ?? 1);
        }
        t = Number(t);
        if (!Number.isFinite(t)) t = 1;
        return Math.min(5, Math.max(0.5, t));
    }

    function softmax(values, temperature) {
        const z = values.map(v => Number(v) / temperature);
        const m = Math.max(...z);
        const e = z.map(v => Math.exp(v - m));
        const sum = e.reduce((a, b) => a + b, 0) || 1;
        return e.map(v => v / sum);
    }

    function int64(values) {
        return BigInt64Array.from(values, v => BigInt(Math.trunc(Number(v))));
    }

    async function loadAgentConfig() {
        try {
            const r = await fetch(CONFIG_URL, { cache: 'force-cache' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (err) {
            console.warn('[Laya] upstream rl_agent_config unavailable; using embedded calibration:', err);
            emit('Laya config unavailable — using embedded calibration');
            return { ...FALLBACK_CONFIG, temperature_by_options: { ...FALLBACK_CONFIG.temperature_by_options } };
        }
    }

    async function createSession() {
        const opts = { graphOptimizationLevel: 'all' };
        if (typeof navigator !== 'undefined' && navigator.gpu) {
            emit('Loading Laya ONNX on WebGPU…');
            try {
                session = await ort.InferenceSession.create(MODEL_URL, {
                    ...opts,
                    executionProviders: ['webgpu'],
                });
                backend = 'webgpu';
                emit('Laya ready on WebGPU');
                return;
            } catch (err) {
                console.warn('[Laya] WebGPU failed; falling back to WASM:', err);
                emit('WebGPU failed; falling back to WASM…');
            }
        }

        session = await ort.InferenceSession.create(MODEL_URL, {
            ...opts,
            executionProviders: ['wasm'],
        });
        backend = 'wasm';
        emit('Laya ready on WASM');
    }

    async function init({ onStatus } = {}) {
        if (onStatus) statusSink = onStatus;
        if (session && tokenizer && config) return api;
        if (initPromise) return initPromise;

        initPromise = (async () => {
            emit('Loading Local Laya runtime…');
            const [hf, ortMod, cfg] = await Promise.all([
                import(HFJS_URL),
                import(ORT_WEBGPU_URL),
                loadAgentConfig(),
            ]);

            ort = ortMod;
            config = cfg;

            if (hf.env) {
                hf.env.allowLocalModels = false;
                hf.env.useBrowserCache = true;
            }

            if (ort.env?.wasm) {
                ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
                ort.env.wasm.numThreads = (self.crossOriginIsolated && navigator.hardwareConcurrency)
                    ? Math.max(1, Math.min(8, navigator.hardwareConcurrency - 1))
                    : 1;
            }

            emit('Loading Laya tokenizer…');
            tokenizer = await hf.AutoTokenizer.from_pretrained(TOKENIZER_MODEL_ID, {
                progress_callback: p => {
                    const pct = Number.isFinite(p?.progress) ? Math.round(p.progress) : null;
                    emit(pct == null ? 'Loading Laya tokenizer…' : `Loading tokenizer… ${pct}%`, pct);
                },
            });
            await resolveSpecialTokens();

            emit('Loading 428 MB Laya Q4 model…');
            await createSession();
            return api;
        })().catch(err => {
            initPromise = null;
            session = null;
            backend = null;
            emit(`Laya failed: ${err.message}`);
            throw err;
        });

        return initPromise;
    }

    async function decide({ state, question, options, maxLen = 384, onStatus } = {}) {
        if (onStatus) statusSink = onStatus;
        if (!Array.isArray(options) || options.length < 2) throw new Error('Laya needs at least two choices');
        if (options.length > 20) throw new Error('Keep Laya choice sets at 20 options or fewer');

        await init({ onStatus: statusSink });
        const started = performance.now();
        const seq = await buildSequence(state, question, options, maxLen);
        if (seq.markers.length !== options.length) {
            throw new Error(`Laya option markers truncated (${seq.markers.length}/${options.length})`);
        }

        const k = options.length;
        const feeds = {
            input_ids: new ort.Tensor('int64', int64(seq.ids), [1, seq.ids.length]),
            attention_mask: new ort.Tensor('int64', int64(new Array(seq.ids.length).fill(1)), [1, seq.ids.length]),
            marker_pos: new ort.Tensor('int64', int64(seq.markers), [1, k]),
            marker_mask: new ort.Tensor('bool', new Uint8Array(k).fill(1), [1, k]),
            qtype: new ort.Tensor('int64', int64([0]), [1]),
        };

        emit('Laya deciding…');
        const out = await session.run(feeds);
        const logitsTensor = out.logits || out[session.outputNames?.[0]];
        if (!logitsTensor?.data) throw new Error('Laya ONNX returned no logits');

        const logits = Array.from(logitsTensor.data, Number).slice(0, k);
        const temperature = temperatureFor(k);
        const probabilities = softmax(logits, temperature);

        let best = 0;
        for (let i = 1; i < probabilities.length; i++) {
            if (probabilities[i] > probabilities[best]) best = i;
        }

        const chosen = options[best];
        const result = {
            choice: typeof chosen === 'string' ? chosen : (chosen.value ?? chosen.label),
            label: typeof chosen === 'string' ? chosen : (chosen.label ?? chosen.value),
            index: best,
            probabilities,
            logits,
            temperature,
            backend,
            latencyMs: performance.now() - started,
            sequenceLength: seq.ids.length,
        };
        lastDecision = result;
        emit(`Laya chose ${result.label} (${Math.round(probabilities[best] * 100)}%) in ${Math.round(result.latencyMs)}ms`);
        return result;
    }

    const api = {
        init,
        preload: init,
        decide,
        get ready() { return !!session; },
        get backend() { return backend; },
        get lastDecision() { return lastDecision; },
        setStatusSink(fn) { statusSink = typeof fn === 'function' ? fn : null; },
        modelId: MODEL_ID,
        tokenizerModelId: TOKENIZER_MODEL_ID,
    };

    window.LocalLayaSM64 = api;
})();

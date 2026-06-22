// ─────────────────────────────────────────────────────────────────────────
// pretrainer.js — standalone in-browser trainer for the SM64 "Cheater's Model".
// Trains a from-scratch MLP (move → next move) on all 103 TAS runs, lets the user
// tune the architecture, export a drop-in cheater-model.json, and submit it.
// ─────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const SUBMIT_EMAIL = 'redoxidev@endoxi.dev';

let SEQ = null;          // { tokens:[...], seqs:["encoded",...] }
let training = false;
let lastModel = null;    // the trained model object (exportable)
let lastStats = null;

async function loadSeqs() {
    try {
        const r = await fetch('tas/tas-sequences.json', { cache: 'force-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        SEQ = await r.json();
        const moves = SEQ.seqs.reduce((a, s) => a + s.length, 0);
        $('status').textContent = `Ready — ${SEQ.seqs.length} TAS runs, ${moves.toLocaleString()} moves, ${SEQ.tokens.length} move types. Configure and hit Train.`;
        $('train').disabled = false;
    } catch (e) {
        $('status').textContent = '⚠ Could not load tas/tas-sequences.json — open this page via the deployed site (not a file://).';
    }
}

// Build (sparse move-context → next-move) examples for a given K.
function buildExamples(K, V) {
    const ex = [];
    for (const enc of SEQ.seqs) {
        const ids = []; for (let i = 0; i < enc.length; i++) ids.push(enc.charCodeAt(i) - 48);
        for (let i = 0; i < ids.length; i++) {
            const active = []; for (let k = 0; k < K; k++) { const j = i - K + k; if (j >= 0) active.push(k * V + ids[j]); }
            ex.push({ a: active, y: ids[i] });
        }
    }
    return ex;
}

// n-gram fallback (so the exported model is a complete drop-in).
function buildNGram() {
    const unigram = {}, bigram = {};
    for (const enc of SEQ.seqs) {
        for (let i = 0; i < enc.length; i++) {
            const t = SEQ.tokens[enc.charCodeAt(i) - 48];
            unigram[t] = (unigram[t] || 0) + 1;
            if (i + 1 < enc.length) { const n = SEQ.tokens[enc.charCodeAt(i + 1) - 48]; (bigram[t] || (bigram[t] = {}))[n] = (bigram[t][n] || 0) + 1; }
        }
    }
    return { unigram, bigram };
}

const randM = (n, m, s) => Array.from({ length: n }, () => Array.from({ length: m }, () => (Math.random() * 2 - 1) * s));

async function train() {
    if (training || !SEQ) return;
    const K = Math.max(1, Math.min(6, +$('K').value | 0));
    const hidden = Math.max(4, Math.min(128, +$('hidden').value | 0));
    const epochs = Math.max(1, Math.min(80, +$('epochs').value | 0));
    const lr = Math.max(0.001, Math.min(1, +$('lr').value || 0.08));
    const V = SEQ.tokens.length, IN = K * V;

    training = true; $('train').disabled = true; $('stop').disabled = false; $('resultCard').style.display = 'none';
    $('status').textContent = 'Building training set…'; await frame();

    const ex = buildExamples(K, V), N = ex.length;
    let W1 = randM(IN, hidden, Math.sqrt(2 / IN)), b1 = new Array(hidden).fill(0);
    let W2 = randM(hidden, V, Math.sqrt(2 / hidden)), b2 = new Array(V).fill(0);

    const t0 = performance.now(); let lastAcc = 0, stall = 0, totalEx = 0, done = 0;
    for (let e = 0; e < epochs && training; e++) {
        for (let a = N - 1; a > 0; a--) { const b = (Math.random() * (a + 1)) | 0;[ex[a], ex[b]] = [ex[b], ex[a]]; }
        let loss = 0, correct = 0;
        const chunk = 3000;
        for (let i = 0; i < N && training; i += chunk) {
            const end = Math.min(N, i + chunk);
            for (let n = i; n < end; n++) {
                const act = ex[n].a, y = ex[n].y;
                const h = new Array(hidden);
                for (let j = 0; j < hidden; j++) { let s = b1[j]; for (const ii of act) s += W1[ii][j]; h[j] = s > 0 ? s : 0; }
                const o = new Array(V);
                for (let c = 0; c < V; c++) { let s = b2[c]; for (let j = 0; j < hidden; j++) s += h[j] * W2[j][c]; o[c] = s; }
                const mx = Math.max(...o); let sum = 0; const p = o.map(v => { const ee = Math.exp(v - mx); sum += ee; return ee; }); for (let c = 0; c < V; c++) p[c] /= sum;
                let arg = 0; for (let c = 1; c < V; c++) if (p[c] > p[arg]) arg = c;
                loss += -Math.log(p[y] + 1e-9); if (arg === y) correct++;
                const dO = p; dO[y] -= 1;
                const dh = new Array(hidden).fill(0);
                for (let j = 0; j < hidden; j++) for (let c = 0; c < V; c++) dh[j] += dO[c] * W2[j][c];
                for (let j = 0; j < hidden; j++) for (let c = 0; c < V; c++) W2[j][c] -= lr * dO[c] * h[j];
                for (let c = 0; c < V; c++) b2[c] -= lr * dO[c];
                for (let j = 0; j < hidden; j++) { if (h[j] <= 0) continue; const g = dh[j]; for (const ii of act) W1[ii][j] -= lr * g; b1[j] -= lr * g; }
            }
            totalEx += end - i;
            const pct = ((e + end / N) / epochs * 100);
            $('barfill').style.width = pct.toFixed(1) + '%';
            $('status').innerHTML = `Pass ${e + 1}/${epochs} · ${Math.round(end / N * 100)}% · confidence ~<b>${Math.round(correct / end * 100)}%</b>`;
            const eps = Math.round(totalEx / ((performance.now() - t0) / 1000));
            $('stats').textContent = `examples/sec: ${eps.toLocaleString()}\narchitecture: K=${K}, hidden=${hidden}, inputs=${IN}, params=${(IN * hidden + hidden + hidden * V + V).toLocaleString()}`;
            await frame();
        }
        done = e + 1;
        const acc = correct / N;
        if (acc - lastAcc < 0.003) stall++; else stall = 0;
        lastAcc = acc;
        if (stall >= 2) break;   // plateaued → as confident as it gets
    }
    const ms = performance.now() - t0, eps = Math.round(totalEx / (ms / 1000));
    const round = a => a.map(r => Array.isArray(r) ? r.map(x => +x.toFixed(4)) : +r.toFixed(4));
    const ng = buildNGram();
    const moves = SEQ.seqs.reduce((a, s) => a + s.length, 0);
    lastModel = {
        v: 2, trainedOn: { files: SEQ.seqs.length, moves },
        tokens: SEQ.tokens, unigram: ng.unigram, bigram: ng.bigram,
        mlp: { K, hidden, in: IN, W1: round(W1), b1: round(b1), W2: round(W2), b2: round(b2) },
        note: "Community-pretrained Cheater's Model (standalone pretrainer).",
        meta: { confidence: +(lastAcc * 100).toFixed(2), passes: done, examplesPerSec: eps, seconds: +(ms / 1000).toFixed(1), K, hidden },
    };
    lastStats = lastModel.meta;
    training = false; $('train').disabled = false; $('stop').disabled = true; $('barfill').style.width = '100%';

    const webFit = ms < 25000;
    $('status').innerHTML = `Done — confidence <b>${(lastAcc * 100).toFixed(1)}%</b>`;
    $('result').innerHTML =
        `<div class="big">${(lastAcc * 100).toFixed(1)}% confidence</div>` +
        `<div>${done} passes · ${eps.toLocaleString()} examples/sec · ${(ms / 1000).toFixed(1)}s · K=${K}, hidden=${hidden}</div>` +
        `<div style="margin-top:8px">Web-fit: <b class="${webFit ? 'verdict-ok' : 'verdict-no'}">${webFit ? '✅ YES — runs great in a browser' : '😬 heavy — lower epochs/hidden and retry'}</b></div>`;
    $('resultCard').style.display = 'block';
}

function frame() { return new Promise(r => setTimeout(r, 0)); }

function download(model) {
    const blob = new Blob([JSON.stringify(model)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'sm64-cheater-model.json';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function submit() {
    if (!lastModel) return;
    download(lastModel);   // get the file into their Downloads first
    const m = lastStats;
    const subject = encodeURIComponent('SM64 AI — Cheater Model submission');
    const body = encodeURIComponent(
        `Here's my pretrained Cheater's Model for SM64 AI.\n\n` +
        `Confidence (top-1 next-move accuracy): ${m.confidence}%\n` +
        `Architecture: K=${m.K}, hidden=${m.hidden}\n` +
        `Training: ${m.passes} passes, ${m.examplesPerSec} examples/sec, ${m.seconds}s\n\n` +
        `I've attached sm64-cheater-model.json (it just downloaded to my device). ` +
        `Please consider it to become the app's main Cheater's Model!\n`);
    setTimeout(() => { window.location.href = `mailto:${SUBMIT_EMAIL}?subject=${subject}&body=${body}`; }, 700);
}

$('train').disabled = true;
$('train').addEventListener('click', train);
$('stop').addEventListener('click', () => { training = false; });
$('export').addEventListener('click', () => lastModel && download(lastModel));
$('submit').addEventListener('click', submit);
loadSeqs();

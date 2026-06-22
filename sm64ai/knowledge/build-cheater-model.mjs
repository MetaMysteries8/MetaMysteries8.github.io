// ─────────────────────────────────────────────────────────────────────────
// build-cheater-model.mjs — trains the "Cheater's Model".
//
// Unlike m64-parser.js (which reads ONLY the header), this build step DOES read
// the per-frame controller inputs of every .m64 in tas/, converts each frame to
// one of our RL action tokens, collapses runs into decision-level "moves", and
// learns an n-gram (Markov) model of how SM64 is actually played across 103
// expert/TAS runs. It is NOT a replay and NOT a neural net — it's the STATISTICS
// of play (which move tends to follow which). Output: tas/cheater-model.json (tiny).
//
// Run:  node knowledge/build-cheater-model.mjs
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAS_DIR = join(__dirname, '..', 'tas');
const OUT = join(TAS_DIR, 'cheater-model.json');

const M64_SIG = 0x1a34364d;
const HDR = 0x400;

// N64 button bits (low byte of the 16-bit Value, little-endian)
const A = 0x80, B = 0x40, Z = 0x20;   // A=jump, B=dive/punch, Z=crouch/ground-pound

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const s = statSync(p);
        if (s.isDirectory()) out.push(...walk(p));
        else if (name.toLowerCase().endsWith('.m64')) out.push(p);
    }
    return out;
}

// One frame's 4 bytes [b0(buttons low), b1(buttons high), x, y] → an action token
// from our RL vocabulary. Stick: +Y = forward (up), X = left/right.
function frameToToken(b0, x, y) {
    const A_on = !!(b0 & A), B_on = !!(b0 & B), Z_on = !!(b0 & Z);
    const mag = Math.hypot(x, y);
    const moving = mag > 24;
    const fwd = moving && y > 0 && Math.abs(y) >= Math.abs(x);
    const back = moving && y < 0 && Math.abs(y) >= Math.abs(x);
    const sideways = moving && Math.abs(x) > Math.abs(y);
    const diagL = fwd && x < -28, diagR = fwd && x > 28;

    if (A_on && Z_on && (fwd || moving)) return 'long_jump';
    if (A_on && (fwd || diagL || diagR)) return 'jump-forward';
    if (A_on)            return 'jump';
    if (B_on && moving)  return 'dive';
    if (B_on)            return 'action';
    if (Z_on)            return 'crouch';
    if (diagL)           return 'forward-left';
    if (diagR)           return 'forward-right';
    if (fwd)             return 'forward';
    if (back)            return 'backward';
    if (sideways)        return 'turn';
    return 'wait';
}

function tokensFromFile(buf) {
    if (buf.length < HDR + 4) return [];
    if (buf.readUInt32LE(0) !== M64_SIG) return [];
    let numCon = buf.readUInt8(0x15); if (!numCon || numCon > 4) numCon = 1;
    const stride = 4 * numCon;
    const raw = [];
    for (let off = HDR; off + 4 <= buf.length; off += stride) {
        const b0 = buf.readUInt8(off);          // buttons low byte (A/B/Z/Start/DPAD)
        const x = buf.readInt8(off + 2);        // analog X
        const y = buf.readInt8(off + 3);        // analog Y
        raw.push(frameToToken(b0, x, y));
    }
    // Collapse consecutive identical frames into decision-level moves, and require
    // a move to persist a few frames (TAS frames are 1/60s; ignore 1-frame blips).
    const moves = [];
    let cur = null, run = 0;
    for (const t of raw) {
        if (t === cur) { run++; continue; }
        if (cur && run >= 2) moves.push(cur);
        cur = t; run = 1;
    }
    if (cur && run >= 2) moves.push(cur);
    return moves;
}

const files = walk(TAS_DIR);
const unigram = {};            // token -> count
const bigram = {};             // token -> { nextToken: count }
const allSeqs = [];            // per-file move sequences (for the neural net)
let totalMoves = 0, used = 0, totalFrames = 0;

for (const f of files) {
    let moves;
    try { const buf = readFileSync(f); totalFrames += Math.max(0, (buf.length - HDR) / 4 | 0); moves = tokensFromFile(buf); }
    catch { continue; }
    if (moves.length < 8) continue;
    used++;
    allSeqs.push(moves);
    for (let i = 0; i < moves.length; i++) {
        const t = moves[i];
        unigram[t] = (unigram[t] || 0) + 1;
        totalMoves++;
        if (i + 1 < moves.length) {
            const n = moves[i + 1];
            (bigram[t] || (bigram[t] = {}))[n] = (bigram[t][n] || 0) + 1;
        }
    }
}

const tokens = Object.keys(unigram).sort();

// ── REAL NEURAL NET (from-scratch MLP, behavioral cloning) ──────────────────
// Predicts the NEXT move from a window of the last K moves (one-hot). This is a
// genuine neural network trained by SGD + backprop — not a lookup table. Tiny
// enough to ship as JSON and run forward in the browser.
function trainMLP(sequences, vocab, { K = 3, hidden = 24, epochs = 6, lr = 0.1 } = {}) {
    const V = vocab.length, IN = K * V;
    const idx = Object.fromEntries(vocab.map((t, i) => [t, i]));
    const randM = (n, m, s) => Array.from({ length: n }, () => Array.from({ length: m }, () => (Math.random() * 2 - 1) * s));
    let W1 = randM(IN, hidden, Math.sqrt(2 / IN)), b1 = new Array(hidden).fill(0);
    let W2 = randM(hidden, V, Math.sqrt(2 / hidden)), b2 = new Array(V).fill(0);

    // Build (sparse one-hot feature, target) examples.
    const X = [], Y = [];
    for (const seq of sequences) for (let i = 0; i < seq.length; i++) {
        const active = [];
        for (let k = 0; k < K; k++) { const j = i - K + k; if (j >= 0) active.push(k * V + idx[seq[j]]); }
        X.push(active); Y.push(idx[seq[i]]);
    }
    const order = X.map((_, i) => i);
    for (let e = 0; e < epochs; e++) {
        for (let a = order.length - 1; a > 0; a--) { const b = (Math.random() * (a + 1)) | 0;[order[a], order[b]] = [order[b], order[a]]; }
        let loss = 0;
        for (const n of order) {
            const act = X[n], y = Y[n];
            const h = new Array(hidden);
            for (let j = 0; j < hidden; j++) { let s = b1[j]; for (const i of act) s += W1[i][j]; h[j] = s > 0 ? s : 0; }
            const o = new Array(V);
            for (let c = 0; c < V; c++) { let s = b2[c]; for (let j = 0; j < hidden; j++) s += h[j] * W2[j][c]; o[c] = s; }
            const mx = Math.max(...o); let sum = 0; const p = o.map(v => { const ex = Math.exp(v - mx); sum += ex; return ex; });
            for (let c = 0; c < V; c++) p[c] /= sum;
            loss += -Math.log(p[y] + 1e-9);
            const dO = p; dO[y] -= 1;
            const dh = new Array(hidden).fill(0);
            for (let j = 0; j < hidden; j++) for (let c = 0; c < V; c++) { dh[j] += dO[c] * W2[j][c]; W2[j][c] -= lr * dO[c] * h[j]; }
            for (let c = 0; c < V; c++) b2[c] -= lr * dO[c];
            for (let j = 0; j < hidden; j++) { if (h[j] <= 0) continue; const g = dh[j]; for (const i of act) W1[i][j] -= lr * g; b1[j] -= lr * g; }
        }
        console.log(`  MLP epoch ${e + 1}/${epochs} — loss ${(loss / X.length).toFixed(3)}`);
    }
    const round = a => a.map(r => Array.isArray(r) ? r.map(x => +x.toFixed(4)) : +r.toFixed(4));
    return { K, hidden, in: IN, W1: round(W1), b1: round(b1), W2: round(W2), b2: round(b2), examples: X.length };
}

console.log('Training neural net (behavioral cloning on TAS moves)…');
const mlp = trainMLP(allSeqs, tokens);

const model = {
    v: 2,
    trainedOn: { files: used, frames: totalFrames, moves: totalMoves },
    tokens,
    unigram, bigram,           // Markov fallback
    mlp,                       // the real neural net (preferred)
    note: 'Cheater\'s Model: a from-scratch MLP (+ n-gram fallback) of SM64 play, trained from .m64 controller inputs. Imitation, not a replay.',
};
writeFileSync(OUT, JSON.stringify(model));
console.log(`Cheater's Model trained on ${used}/${files.length} runs, ${totalMoves} moves (~${(totalFrames / 60 / 60).toFixed(1)} min of TAS).`);
console.log('Top moves:', Object.entries(unigram).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join('  '));
console.log('Wrote', OUT, `(${(JSON.stringify(model).length / 1024).toFixed(1)} KB)`);

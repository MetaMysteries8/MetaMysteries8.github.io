# SM64-AI Local Trainer (heavyweight)

This is the **local, GPU-powered** trainer that produces a model which actually
**plays the game from the screen** — the thing the in-browser stuff can't, because
TAS files have inputs but no pixels. The browser's lightweight Q-table / from-scratch
MLP is now **LRL (Legacy RL)**; this pipeline is the real screen→action policy.

The idea (this is how OpenAI's VPT and Sony's GT Sophy were built):

```
.m64 TAS movies ──► replay in an emulator, dump screenshots ──► (frame, input) pairs
        │                                                              │
        └────────── parse inputs (parse_m64.py) ───────────► behavioral cloning (CNN)
                                                                       │
                                                              ONNX model that plays
```

## Why an emulator (and the ROM caveat)
The `.m64` files are **Mupen64 movie files** — a real emulator already knows how to
replay them. We use **BizHawk** (EmuHawk) because it's scriptable. BizHawk needs the
**SUPER MARIO 64 (U) ROM**, which we can **not** ship — supply your own legally-dumped
copy. (This is the same constraint as the Wii-RL project, which uses Dolphin.)

## Setup
```bash
pip install -r requirements.txt          # for GPU, install the CUDA torch wheel instead
```
- Download BizHawk (EmuHawk) and your SM64 (U) ROM.

## Pipeline

**1. Dump aligned screenshots** (per movie)
- In EmuHawk: `File > Movie > Play Movie...` → pick a `.m64` from `../tas/`
  (start with a short Individual-Level run to validate).
- `Tools > Lua Console` → open `bizhawk/dump_frames.lua`, set `NAME` unique per movie,
  then **Run**. It fast-forwards and drops PNGs (named by frame index) into `frames/`.

**2. Build a dataset** (pairs pixels with the parsed input per frame)
```bash
python build_dataset.py --frames frames --movie "../tas/.../run.m64" \
    --name run --out data/run.npz --gray
```
Repeat for each movie → `data/*.npz`.

**3. Train (behavioral cloning) + export ONNX**
```bash
python train_bc.py --data "data/*.npz" --epochs 20 --out model/sm64_bc
```
Produces `model/sm64_bc.pt`, `.onnx`, and `.json` (token list). The `.onnx` is what
the browser will load to play.

**4. (Future) RL fine-tune** — drop the BC policy into the game with a reward
(distance/stars) and improve it with PPO or Rainbow-DQN (the
[Wii-RL](https://github.com/VIPTankz/Wii-RL) / Beyond-the-Rainbow inspiration). Heavy
compute; BC alone already plays.

**5. (Future) Run it in the web app** — load `sm64_bc.onnx` via onnxruntime-web (we
already pull the runtime for the WebGPU vision encoder) and let it drive RL Play.

## Honest status / caveats
- **Untested end-to-end here** — written carefully but you'll likely need small tweaks
  for your BizHawk version (screenshot path, `client.screenshot` signature) and to
  calibrate **frame alignment** (N64 lag frames / a power-on offset can shift image
  frame N vs input N by a few frames — `build_dataset.py` skips overflow; if accuracy
  is poor, add a small `--offset` and I'll wire it in).
- Full-res screenshots are disk-heavy; raise `SUB` in the Lua or sample fewer movies
  first. Individual-level runs are the fastest way to a first working model.
- BC imitates; it won't recover from states the TAS never visited until you do step 4.

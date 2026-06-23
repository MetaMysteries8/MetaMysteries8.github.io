"""
build_dataset.py — pair the screenshots BizHawk dumped (named by frame number) with
the per-frame action token parsed from the matching .m64, and pack everything into a
compact .npz the trainer can stream.

  python build_dataset.py --frames frames --movie "path/to/run.m64" \
      --name run --out data/run.npz [--res 84] [--gray]

Run it once per movie; train_bc.py globs all data/*.npz together.

Output .npz:
  X   uint8 [N, res, res] (grayscale) or [N, res, res, 3]
  y   int16 [N]            action-token id (see parse_m64.TOKENS)
  tokens  list[str]
"""
import argparse
import re
from pathlib import Path

import numpy as np
from PIL import Image

from parse_m64 import actions_for_movie, TOKENS

FRAME_RE = re.compile(r'_(\d+)\.png$')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', required=True, help='dir of BizHawk PNG dumps')
    ap.add_argument('--movie', required=True, help='the matching .m64')
    ap.add_argument('--name', required=True, help='filename prefix used by the Lua dumper')
    ap.add_argument('--out', required=True, help='output .npz path')
    ap.add_argument('--res', type=int, default=84)
    ap.add_argument('--gray', action='store_true', help='store grayscale (smaller, plenty for BC)')
    args = ap.parse_args()

    actions = actions_for_movie(args.movie)
    print(f'{len(actions)} input frames parsed from {Path(args.movie).name}')

    frame_dir = Path(args.frames)
    pngs = []
    for p in frame_dir.glob(f'{args.name}_*.png'):
        m = FRAME_RE.search(p.name)
        if m:
            pngs.append((int(m.group(1)), p))
    pngs.sort()
    if not pngs:
        raise SystemExit(f'No frames matching {args.name}_*.png in {frame_dir}')
    print(f'{len(pngs)} screenshots found')

    X, y = [], []
    skipped = 0
    for fidx, path in pngs:
        if fidx >= len(actions):     # screenshot past the input stream (lag/offset) — skip
            skipped += 1
            continue
        img = Image.open(path)
        img = img.convert('L' if args.gray else 'RGB').resize((args.res, args.res), Image.BILINEAR)
        X.append(np.asarray(img, dtype=np.uint8))
        y.append(actions[fidx])

    if not X:
        raise SystemExit('No (image, action) pairs produced — check frame/movie alignment.')
    X = np.stack(X)
    y = np.asarray(y, dtype=np.int16)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(args.out, X=X, y=y, tokens=np.array(TOKENS))
    print(f'wrote {args.out}: X{X.shape} {X.dtype}, y{y.shape} (skipped {skipped})')
    # quick class balance readout
    uniq, cnt = np.unique(y, return_counts=True)
    for i, c in sorted(zip(uniq, cnt), key=lambda t: -t[1]):
        print(f'  {TOKENS[i]:14s} {c}')


if __name__ == '__main__':
    main()

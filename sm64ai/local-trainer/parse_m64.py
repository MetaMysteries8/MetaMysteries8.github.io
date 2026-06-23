"""
parse_m64.py — read per-frame controller inputs from a Mupen64 .m64 movie and map
each frame to one of the SM64-AI action tokens. This is a faithful Python port of the
JS logic in knowledge/build-cheater-model.mjs, so models stay interoperable with the
browser app (same 12-token vocabulary, same order).

A .m64 movie:
  - 0x400-byte header. Signature 0x1a34364d ("M64\\x1a") at offset 0.
  - Controller count byte at 0x15.
  - Then 4 bytes PER CONTROLLER PER FRAME:
        byte0 = buttons high (A=0x80, B=0x40, Z=0x20, Start=0x10, D-pad...)
        byte1 = buttons low  (C-buttons, L, R)
        byte2 = analog X (signed)
        byte3 = analog Y (signed)
"""
import struct
from pathlib import Path

# Same sorted vocabulary the browser model uses (Object.keys(unigram).sort()).
TOKENS = ['action', 'backward', 'crouch', 'dive', 'forward', 'forward-left',
          'forward-right', 'jump', 'jump-forward', 'long_jump', 'turn', 'wait']
TOK2ID = {t: i for i, t in enumerate(TOKENS)}

M64_SIG = 0x1a34364d
HDR = 0x400
A, B, Z = 0x80, 0x40, 0x20


def frame_to_token(b0: int, x: int, y: int) -> str:
    """One frame's buttons + stick -> an action token (identical rules to the JS)."""
    a_on, b_on, z_on = bool(b0 & A), bool(b0 & B), bool(b0 & Z)
    mag = (x * x + y * y) ** 0.5
    moving = mag > 24
    fwd = moving and y > 0 and abs(y) >= abs(x)
    back = moving and y < 0 and abs(y) >= abs(x)
    sideways = moving and abs(x) > abs(y)
    diag_l = fwd and x < -28
    diag_r = fwd and x > 28

    if a_on and z_on and (fwd or moving): return 'long_jump'
    if a_on and (fwd or diag_l or diag_r): return 'jump-forward'
    if a_on: return 'jump'
    if b_on and moving: return 'dive'
    if b_on: return 'action'
    if z_on: return 'crouch'
    if diag_l: return 'forward-left'
    if diag_r: return 'forward-right'
    if fwd: return 'forward'
    if back: return 'backward'
    if sideways: return 'turn'
    return 'wait'


def read_frames(path):
    """Yield (frame_index, b0, x, y, token) for controller 1 of an .m64."""
    buf = Path(path).read_bytes()
    if len(buf) < HDR + 4:
        return
    if struct.unpack_from('<I', buf, 0)[0] != M64_SIG:
        raise ValueError(f'{path}: not a Mupen64 .m64 (bad signature)')
    num_con = buf[0x15]
    if not num_con or num_con > 4:
        num_con = 1
    stride = 4 * num_con
    idx = 0
    off = HDR
    while off + 4 <= len(buf):
        b0 = buf[off]
        x = struct.unpack_from('<b', buf, off + 2)[0]   # signed
        y = struct.unpack_from('<b', buf, off + 3)[0]
        yield idx, b0, x, y, frame_to_token(b0, x, y)
        idx += 1
        off += stride


def actions_for_movie(path):
    """Return a list of token-ids, one per input frame (controller 1)."""
    return [TOK2ID[t] for (_, _, _, _, t) in read_frames(path)]


if __name__ == '__main__':
    import sys
    from collections import Counter
    if len(sys.argv) < 2:
        print('usage: python parse_m64.py <file.m64>')
        raise SystemExit(1)
    toks = [t for (*_, t) in read_frames(sys.argv[1])]
    print(f'{len(toks)} frames')
    for tok, n in Counter(toks).most_common():
        print(f'  {tok:14s} {n}')

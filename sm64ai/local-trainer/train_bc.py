"""
train_bc.py — behavioral cloning: train a CNN to predict the expert's next action
from the screen, on the .npz datasets built by build_dataset.py. Exports ONNX so the
browser can run it.

  python train_bc.py --data "data/*.npz" --epochs 20 --out model/sm64_bc

Needs a GPU for real throughput (this is the "best training power" path). Falls back
to CPU (slow). This produces the HEAVYWEIGHT model — the in-browser Q-table/MLP stuff
is now "LRL" (Legacy RL); this is the real screen->action policy.
"""
import argparse
import glob
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader, random_split

from parse_m64 import TOKENS

N_ACT = len(TOKENS)


class FramesDS(Dataset):
    def __init__(self, paths):
        Xs, ys = [], []
        for p in paths:
            d = np.load(p, allow_pickle=True)
            Xs.append(d['X'])
            ys.append(d['y'])
        self.X = np.concatenate(Xs)            # [N,H,W] or [N,H,W,3]
        self.y = np.concatenate(ys).astype(np.int64)
        if self.X.ndim == 3:                    # grayscale -> add channel
            self.X = self.X[:, None, :, :]
        else:
            self.X = self.X.transpose(0, 3, 1, 2)
        self.C = self.X.shape[1]
        print(f'dataset: {self.X.shape}, {N_ACT} actions')

    def __len__(self): return len(self.y)

    def __getitem__(self, i):
        x = torch.from_numpy(self.X[i]).float() / 255.0
        return x, int(self.y[i])


class NatureCNN(nn.Module):
    """The classic Atari-DQN encoder + a small policy head."""
    def __init__(self, c, n_act):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(c, 32, 8, 4), nn.ReLU(),
            nn.Conv2d(32, 64, 4, 2), nn.ReLU(),
            nn.Conv2d(64, 64, 3, 1), nn.ReLU(),
            nn.Flatten(),
        )
        with torch.no_grad():
            n = self.conv(torch.zeros(1, c, 84, 84)).shape[1]
        self.head = nn.Sequential(nn.Linear(n, 512), nn.ReLU(), nn.Linear(512, n_act))

    def forward(self, x):
        return self.head(self.conv(x))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True, help='glob of .npz (quote it), e.g. "data/*.npz"')
    ap.add_argument('--epochs', type=int, default=20)
    ap.add_argument('--bs', type=int, default=256)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--out', default='model/sm64_bc')
    args = ap.parse_args()

    paths = sorted(glob.glob(args.data))
    if not paths:
        raise SystemExit(f'no datasets match {args.data}')
    ds = FramesDS(paths)
    n_val = max(1, int(len(ds) * 0.05))
    tr, va = random_split(ds, [len(ds) - n_val, n_val])
    dl_tr = DataLoader(tr, batch_size=args.bs, shuffle=True, num_workers=2, drop_last=True)
    dl_va = DataLoader(va, batch_size=args.bs)

    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('device:', dev)
    net = NatureCNN(ds.C, N_ACT).to(dev)

    # class weights — TAS play is dominated by a few moves; weight the rare ones up.
    counts = np.bincount(ds.y, minlength=N_ACT).astype(np.float64) + 1
    w = torch.tensor((counts.sum() / (N_ACT * counts)), dtype=torch.float32, device=dev)
    crit = nn.CrossEntropyLoss(weight=w)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)

    for ep in range(args.epochs):
        net.train()
        tot = correct = 0
        loss_sum = 0.0
        for x, yb in dl_tr:
            x, yb = x.to(dev), yb.to(dev)
            opt.zero_grad()
            out = net(x)
            loss = crit(out, yb)
            loss.backward()
            opt.step()
            loss_sum += loss.item() * len(yb)
            correct += (out.argmax(1) == yb).sum().item()
            tot += len(yb)
        # val
        net.eval()
        vc = vt = 0
        with torch.no_grad():
            for x, yb in dl_va:
                x, yb = x.to(dev), yb.to(dev)
                vc += (net(x).argmax(1) == yb).sum().item()
                vt += len(yb)
        print(f'epoch {ep+1:2d}/{args.epochs}  loss {loss_sum/max(1,tot):.3f}  '
              f'train {correct/max(1,tot)*100:.1f}%  val {vc/max(1,vt)*100:.1f}%')

    import os
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    torch.save(net.state_dict(), args.out + '.pt')

    # ONNX export (opset 17 runs in onnxruntime-web) for the browser to load.
    net.eval()
    dummy = torch.zeros(1, ds.C, 84, 84, device=dev)
    torch.onnx.export(net, dummy, args.out + '.onnx',
                      input_names=['frame'], output_names=['logits'],
                      dynamic_axes={'frame': {0: 'batch'}}, opset_version=17)
    import json
    with open(args.out + '.json', 'w') as f:
        json.dump({'tokens': TOKENS, 'channels': ds.C, 'res': 84,
                   'kind': 'sm64-bc-cnn', 'note': 'behavioral-cloning policy (heavyweight, replaces LRL)'}, f)
    print(f'saved {args.out}.pt / .onnx / .json')


if __name__ == '__main__':
    main()

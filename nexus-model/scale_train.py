"""
Inspect hardware and recommend the biggest from-scratch model size this machine
can train without crashing, then (optionally) run it.

This is deliberately conservative: pure-NumPy CPU training is slow, so it picks a
size that finishes in a sane time and fits in free RAM. On a GPU box you'd scale
much higher — but this project trains from scratch on whatever hardware it's on.

Usage:
  python scale_train.py                 # inspect + recommend
  python scale_train.py --run           # also launch the recommended training
"""

import argparse
import os
import subprocess
import sys

from train import SIZES


def hardware():
    cores = os.cpu_count() or 1
    free_gb = None
    try:
        import psutil
        free_gb = psutil.virtual_memory().available / 1e9
    except Exception:
        pass
    gpu = False
    try:
        subprocess.run(["nvidia-smi"], capture_output=True, check=True)
        gpu = True
    except Exception:
        pass
    return cores, free_gb, gpu


def recommend(cores, free_gb, gpu):
    # NumPy CPU training: pick by free RAM (each size's peak grows with width/ctx).
    if gpu:
        return "large"
    if free_gb is None:
        return "small"
    if free_gb >= 6:
        return "medium"
    if free_gb >= 1.0:
        return "small"
    return "tiny"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true", help="launch the recommended training")
    ap.add_argument("--steps", type=int, default=4000)
    ap.add_argument("--corpus", default="data/corpus_narrow.txt")
    args = ap.parse_args()

    cores, free_gb, gpu = hardware()
    rec = recommend(cores, free_gb, gpu)
    print(f"Hardware: {cores} CPU cores, "
          f"{'%.1f GB free RAM' % free_gb if free_gb else 'RAM unknown'}, "
          f"GPU={'yes' if gpu else 'no'}")
    print(f"Model sizes: " + ", ".join(f"{k}({v['n_embd']}d/{v['n_layer']}L)" for k, v in SIZES.items()))
    print(f"Recommended size for this machine: {rec}  ({SIZES[rec]})")
    if not gpu:
        print("Note: CPU/NumPy training is slow and tops out at ~small/medium. "
              "A coherent chat model needs a GPU + a much larger model.")

    if args.run:
        cmd = [sys.executable, "-u", "train.py", "--size", rec,
               "--batch", "8", "--corpus", args.corpus, "--steps", str(args.steps)]
        print("Launching:", " ".join(cmd))
        subprocess.run(cmd)


if __name__ == "__main__":
    main()

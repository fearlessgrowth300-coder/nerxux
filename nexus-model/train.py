"""
Train your own model from scratch.

Pipeline this runs:
  1. read the cleaned corpus (data/corpus.txt -- produced by the data pipeline)
  2. train a BPE tokenizer on it
  3. encode the whole corpus to token ids
  4. run gradient descent: predict next token, measure loss, backprop, update
  5. save the trained weights + tokenizer + config into out/

Usage:
  python train.py --steps 2000 --n_layer 4 --n_embd 128 --block 64

This is REAL training -- the loss should fall and samples should get more
coherent the longer (and the more data) you run it. It will not be GPT-4; it is
your model, trained by you, on your data, on your machine.
"""

import argparse
import gc
import json
import os
import time

import numpy as np

from engine.tokenizer import BPETokenizer
from engine.model import GPT, Config
from engine.optimizer import Adam, clip_grads
from engine.generate import generate

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data", "corpus.txt")
OUT = os.path.join(HERE, "out")


def get_batch(data_ids, block, batch_size):
    ix = np.random.randint(0, len(data_ids) - block - 1, size=batch_size)
    x = np.stack([data_ids[i:i + block] for i in ix])
    y = np.stack([data_ids[i + 1:i + 1 + block] for i in ix])
    return x.astype(np.int64), y.astype(np.int64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=2000)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--block", type=int, default=64)
    ap.add_argument("--n_layer", type=int, default=4)
    ap.add_argument("--n_head", type=int, default=4)
    ap.add_argument("--n_embd", type=int, default=128)
    ap.add_argument("--vocab", type=int, default=2048)
    ap.add_argument("--tok_chars", type=int, default=8_000_000,
                    help="chars sampled to LEARN the tokenizer (encoding uses all)")
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--corpus", default=DATA)
    ap.add_argument("--out", default=OUT, help="where to save the checkpoint")
    ap.add_argument("--eval_every", type=int, default=200)
    args = ap.parse_args()

    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)
    if not os.path.exists(args.corpus):
        # Don't crash on a fresh setup: write a tiny built-in corpus so training
        # can still run for verification. (Add real text via the Train page.)
        print(f"No corpus at {args.corpus} — creating a tiny fallback corpus for "
              "verification. Upload text and Build corpus for a real model.", flush=True)
        os.makedirs(os.path.dirname(args.corpus), exist_ok=True)
        sample_text = (
            "The quick brown fox jumps over the lazy dog. "
            "To be or not to be, that is the question. "
            "All that glitters is not gold. Knowledge is power. "
            "A journey of a thousand miles begins with a single step. "
        ) * 200
        with open(args.corpus, "w", encoding="utf-8") as f:
            f.write(sample_text)

    with open(args.corpus, "r", encoding="utf-8", errors="ignore") as f:
        text = f.read()
    print(f"Corpus: {len(text):,} characters", flush=True)

    # Learn merges from a representative sample, not the whole corpus -- BPE merge
    # learning scales with the text size, and a few million chars already capture
    # the common subwords. Encoding still runs over the FULL corpus afterwards.
    sample = text if len(text) <= args.tok_chars else text[:args.tok_chars]
    print(f"Training tokenizer (BPE) on {len(sample):,}-char sample...", flush=True)
    tok = BPETokenizer().train(sample, vocab_size=args.vocab)
    tok.save(os.path.join(out_dir, "tokenizer.json"))
    print(f"  vocab size: {tok.vocab_size}", flush=True)

    print("Encoding full corpus to tokens...", flush=True)
    ids = np.array(tok.encode(text), dtype=np.int64)
    print(f"  {len(ids):,} tokens", flush=True)
    if len(ids) < args.block + 2:
        raise SystemExit("Corpus too small to train on. Add more text.")

    cfg = Config(
        vocab_size=tok.vocab_size,
        block_size=args.block,
        n_layer=args.n_layer,
        n_head=args.n_head,
        n_embd=args.n_embd,
    )
    model = GPT(cfg)
    print(f"Model: {model.num_params():,} parameters")

    opt = Adam(model.parameters(), lr=args.lr, weight_decay=0.01)

    t0 = time.time()
    for step in range(1, args.steps + 1):
        x, y = get_batch(ids, args.block, args.batch)
        _, loss = model.forward(x, y)
        opt.zero_grad()
        loss.backward()
        clip_grads(model.parameters(), 1.0)
        opt.step()
        loss_val = float(loss.data)  # capture before freeing the graph
        # The autograd graph is held together by reference cycles; free it each
        # step so memory stays flat (otherwise it grows until the process OOMs).
        del loss
        gc.collect()

        if step % 20 == 0 or step == 1:
            dt = time.time() - t0
            print(f"step {step:5d}/{args.steps}  loss {loss_val:.4f}  "
                  f"({step / dt:.1f} it/s)")

        if step % args.eval_every == 0:
            sample = generate(model, tok, "The ", max_new_tokens=60, temperature=0.8)
            print("  sample:", repr(sample[:160]))
            save(model, tok, cfg, out_dir)

    save(model, tok, cfg, out_dir)
    print(f"\nDone in {time.time() - t0:.0f}s. Saved to {out_dir}/", flush=True)
    print("Try it:  python chat.py")


def save(model, tok, cfg, out_dir=OUT):
    np.savez(os.path.join(out_dir, "weights.npz"), **model.state())
    tok.save(os.path.join(out_dir, "tokenizer.json"))
    with open(os.path.join(out_dir, "config.json"), "w") as f:
        json.dump(cfg.to_dict(), f, indent=2)


if __name__ == "__main__":
    main()

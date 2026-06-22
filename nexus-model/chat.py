"""Chat with your trained model from the terminal."""

import json
import os

import numpy as np

from engine.tokenizer import BPETokenizer
from engine.model import GPT, Config
from engine.generate import generate

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")


def load_model():
    with open(os.path.join(OUT, "config.json")) as f:
        cfg = Config.from_dict(json.load(f))
    model = GPT(cfg)
    state = np.load(os.path.join(OUT, "weights.npz"))
    model.load_state({k: state[k] for k in state.files})
    tok = BPETokenizer.load(os.path.join(OUT, "tokenizer.json"))
    return model, tok


def main():
    if not os.path.exists(os.path.join(OUT, "weights.npz")):
        raise SystemExit("No trained model yet. Run:  python train.py")
    model, tok = load_model()
    print("Your model is loaded. Type a prompt (Ctrl+C to quit).\n")
    while True:
        try:
            prompt = input("you > ")
        except (EOFError, KeyboardInterrupt):
            print()
            break
        out = generate(model, tok, prompt, max_new_tokens=120, temperature=0.8)
        print("nexus >", out[len(prompt):].strip(), "\n")


if __name__ == "__main__":
    main()

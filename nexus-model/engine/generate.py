"""Text generation: feed a prompt, sample the next token, repeat."""

import numpy as np

from .model import GPT


def sample_logits(logits, temperature=0.9, top_k=40):
    logits = logits.astype(np.float64)
    if temperature <= 0:
        return int(logits.argmax())
    logits = logits / temperature
    if top_k:
        k = min(top_k, logits.shape[-1])
        idx = np.argpartition(logits, -k)[-k:]
        mask = np.full_like(logits, -np.inf)
        mask[idx] = logits[idx]
        logits = mask
    logits -= logits.max()
    probs = np.exp(logits)
    probs /= probs.sum()
    return int(np.random.choice(len(probs), p=probs))


def generate(model: GPT, tokenizer, prompt, max_new_tokens=120, temperature=0.9, top_k=40):
    ids = tokenizer.encode(prompt)
    if not ids:
        ids = [0]
    block = model.config.block_size
    for _ in range(max_new_tokens):
        context = ids[-block:]
        x = np.array([context], dtype=np.int64)
        logits, _ = model.forward(x)
        next_id = sample_logits(logits.data[0, -1], temperature, top_k)
        ids.append(next_id)
    return tokenizer.decode(ids)

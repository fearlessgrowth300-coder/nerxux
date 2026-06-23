"""Text generation: feed a prompt, sample the next token, repeat.

Sampling controls that fight word-salad on small models:
  - temperature: lower = safer/more repetitive, higher = more varied
  - top_k / top_p: keep only the most likely next tokens (cuts random junk)
  - repetition_penalty: down-weight tokens already used recently (kills loops
    like "the the the")
"""

import numpy as np


def sample_logits(logits, recent_ids=None, temperature=0.8, top_k=40, top_p=0.9,
                  repetition_penalty=1.3):
    logits = logits.astype(np.float64).copy()

    # Repetition penalty: divide the score of recently produced tokens.
    if repetition_penalty and repetition_penalty != 1.0 and recent_ids:
        for tid in set(recent_ids):
            if 0 <= tid < logits.shape[-1]:
                logits[tid] /= repetition_penalty if logits[tid] > 0 else 1.0
                if logits[tid] < 0:
                    logits[tid] *= repetition_penalty

    if temperature <= 0:
        return int(logits.argmax())
    logits = logits / temperature

    # top-k: keep only the k highest-scoring tokens.
    if top_k:
        k = min(top_k, logits.shape[-1])
        kth = np.partition(logits, -k)[-k]
        logits[logits < kth] = -np.inf

    # Convert to probabilities.
    logits -= logits.max()
    probs = np.exp(logits)
    probs /= probs.sum()

    # top-p (nucleus): keep the smallest set of tokens whose cumulative prob >= p.
    if top_p and top_p < 1.0:
        order = np.argsort(probs)[::-1]
        cum = np.cumsum(probs[order])
        cutoff = np.searchsorted(cum, top_p) + 1
        keep = order[:cutoff]
        mask = np.zeros_like(probs)
        mask[keep] = probs[keep]
        s = mask.sum()
        if s > 0:
            probs = mask / s

    return int(np.random.choice(len(probs), p=probs))


def generate(model, tokenizer, prompt, max_new_tokens=120, temperature=0.8,
             top_k=40, top_p=0.9, repetition_penalty=1.3, repeat_window=48):
    ids = tokenizer.encode(prompt)
    if not ids:
        ids = [0]
    block = model.config.block_size
    start = len(ids)
    for _ in range(max_new_tokens):
        context = ids[-block:]
        x = np.array([context], dtype=np.int64)
        logits, _ = model.forward(x)
        recent = ids[-repeat_window:]
        next_id = sample_logits(
            logits.data[0, -1], recent_ids=recent, temperature=temperature,
            top_k=top_k, top_p=top_p, repetition_penalty=repetition_penalty,
        )
        ids.append(next_id)
    return tokenizer.decode(ids)

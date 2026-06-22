"""
Deduplication so the model doesn't memorize the same passage twice.

Two passes, both cheap:
  1. EXACT dedupe -- hash the normalized chunk; drop identical repeats (license
     headers, boilerplate, repeated code files).
  2. NEAR-dupe via MinHash + LSH banding -- estimate Jaccard similarity over
     word-shingles, but only compare chunks that share an LSH bucket, so it
     scales near-linearly instead of O(N^2). crc32 (fast) instead of md5.

Pure Python, no AI.
"""

import re
import zlib

_WORD = re.compile(r"\w+")


def _norm(text):
    return " ".join(_WORD.findall(text.lower()))


def _shingles(text, k=5):
    words = _WORD.findall(text.lower())
    return {" ".join(words[i:i + k]) for i in range(max(0, len(words) - k + 1))}


def _minhash(shingles, num_hashes=32):
    if not shingles:
        return tuple()
    sig = []
    for seed in range(num_hashes):
        best = 0xFFFFFFFF
        sp = str(seed).encode()
        for sh in shingles:
            h = zlib.crc32(sh.encode(), seed)  # fast, seeded
            if h < best:
                best = h
        sig.append(best)
    return tuple(sig)


def _similar(a, b):
    if not a or not b:
        return 0.0
    return sum(1 for x, y in zip(a, b) if x == y) / len(a)


def dedupe(documents, threshold=0.8, num_hashes=32, bands=8):
    """documents: list[str] -> subset with exact + near duplicates removed."""
    # Pass 1: exact dedupe (O(n)).
    seen_exact, unique = set(), []
    for doc in documents:
        key = hash(_norm(doc))
        if key in seen_exact:
            continue
        seen_exact.add(key)
        unique.append(doc)

    # Pass 2: near-dupe via LSH. Only compare docs sharing a band bucket.
    rows = max(1, num_hashes // bands)
    buckets = {}          # band-signature -> list of kept indices
    sigs, kept = [], []
    for doc in unique:
        sig = _minhash(_shingles(doc), num_hashes)
        cand = set()
        if sig:
            for b in range(bands):
                band = (b,) + sig[b * rows:(b + 1) * rows]
                cand.update(buckets.get(band, ()))
        is_dupe = any(_similar(sig, sigs[i]) >= threshold for i in cand)
        if is_dupe:
            continue
        idx = len(kept)
        kept.append(doc)
        sigs.append(sig)
        if sig:
            for b in range(bands):
                band = (b,) + sig[b * rows:(b + 1) * rows]
                buckets.setdefault(band, []).append(idx)
    return kept

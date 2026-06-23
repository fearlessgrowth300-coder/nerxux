"""
Build a NARROW, CLEAN English-prose corpus for the from-scratch model.

A tiny model cannot learn fiction + code + Stack Overflow + multiple languages at
once — that mixture is the main reason the current model is word-salad. This
builder keeps ONLY clean English prose (the public-domain books), drops code /
Q&A / non-English, and writes data/corpus_clean.txt.

Usage:  python -m pipeline.build_clean_corpus
"""

import os
import re

from .extract import extract_file
from .clean import clean_text, looks_like_garbage

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(HERE, "data", "raw")
OUT = os.path.join(HERE, "data", "corpus_clean.txt")
CHUNK = 2000

# Common English words used to detect (and keep) English-language books.
_EN = re.compile(r"\b(the|and|of|to|in|that|was|he|she|with|for|his|her)\b", re.I)


def is_english(text, sample=4000):
    s = text[:sample]
    words = re.findall(r"[A-Za-z']+", s)
    if len(words) < 50:
        return False
    hits = len(_EN.findall(s))
    return hits / max(1, len(words)) > 0.08   # ~8%+ common English words


def main():
    if not os.path.isdir(RAW):
        print(f"No raw data at {RAW}.")
        return
    # Only prose books — skip code_, prog_, stackoverflow_.
    files = [f for f in os.listdir(RAW)
             if f.endswith(".txt") and not f.startswith(("code_", "prog_", "stackoverflow"))]
    print(f"Candidate prose files: {len(files)}")

    chunks, kept_files, skipped = [], 0, 0
    for name in sorted(files):
        path = os.path.join(RAW, name)
        try:
            raw = extract_file(path)
        except Exception:
            continue
        cleaned = clean_text(raw)
        if not is_english(cleaned):
            skipped += 1
            print(f"  skip (not English): {name}")
            continue
        kept_files += 1
        for i in range(0, len(cleaned), CHUNK):
            ch = cleaned[i:i + CHUNK]
            if not looks_like_garbage(ch, min_alpha_ratio=0.7):
                chunks.append(ch)

    text = "\n\n".join(chunks)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"\nKept {kept_files} English books ({skipped} skipped).")
    print(f"Wrote {OUT}  ({len(text):,} characters)")
    print("Train on it:  python train.py --corpus data/corpus_clean.txt --size small")


if __name__ == "__main__":
    main()

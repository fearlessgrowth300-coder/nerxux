"""
Build the training corpus.

Walks data/raw/ and data/uploads/ (PDFs uploaded from the Nexus app land here),
extracts text, cleans it, splits into chunks, removes near-duplicates, and writes
a single data/corpus.txt that train.py consumes.

Usage:
  python -m pipeline.build_corpus
"""

import os

from .extract import extract_file
from .clean import clean_text, looks_like_garbage
from .dedupe import dedupe

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
SOURCES = [os.path.join(DATA, "raw"), os.path.join(DATA, "uploads")]
OUT = os.path.join(DATA, "corpus.txt")

CHUNK_CHARS = 2000


def iter_files():
    for src in SOURCES:
        if not os.path.isdir(src):
            continue
        for root, _, files in os.walk(src):
            for name in files:
                if name.startswith("."):
                    continue
                yield os.path.join(root, name)


def chunk(text, size=CHUNK_CHARS):
    paras = text.split("\n\n")
    buf, out = "", []
    for p in paras:
        if len(buf) + len(p) > size and buf:
            out.append(buf.strip())
            buf = ""
        buf += p + "\n\n"
    if buf.strip():
        out.append(buf.strip())
    return out


def main():
    os.makedirs(DATA, exist_ok=True)
    files = list(iter_files())
    if not files:
        print(f"No source files found in {SOURCES}.")
        print("Add .txt/.pdf/.html files, or run:  python -m pipeline.collect_gutenberg")
        return

    chunks = []
    for path in files:
        name = os.path.basename(path)
        try:
            raw = extract_file(path)
        except Exception as e:
            print(f"  skip {name}: {e}")
            continue
        cleaned = clean_text(raw)
        # Code / Q&A / docs are legitimately symbol-heavy (braces, operators), so
        # the "mostly letters" garbage filter must be relaxed for them or we'd
        # throw the code away. Books keep the stricter filter (drops OCR sludge).
        is_codeish = name.startswith(("code_", "stackoverflow", "prog_"))
        min_alpha = 0.30 if is_codeish else 0.6
        for ch in chunk(cleaned):
            if not looks_like_garbage(ch, min_alpha_ratio=min_alpha):
                chunks.append(ch)
        print(f"  {name}: {len(cleaned):,} chars")

    print(f"Chunks before dedupe: {len(chunks):,}")
    chunks = dedupe(chunks, threshold=0.7)
    print(f"Chunks after dedupe:  {len(chunks):,}")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n\n".join(chunks))
    total = sum(len(c) for c in chunks)
    print(f"\nWrote {OUT}  ({total:,} characters)")
    print("Next:  python train.py --steps 2000")


if __name__ == "__main__":
    main()

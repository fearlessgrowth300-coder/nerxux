"""
Turn collected data into an instruction-tuning dataset (chat format).

Fine-tuning a chat/code model works best on (prompt -> response) examples. Your
Stack Overflow Q&A is already exactly that shape: a question and its top answer.
This script converts nexus-model/data/raw/stackoverflow_qa.txt into a JSONL of
chat examples that the Colab fine-tuner (finetune.py) consumes.

Output: finetune/data/train.jsonl  (one JSON object per line)
  {"messages": [{"role":"user","content": ...}, {"role":"assistant","content": ...}]}

Run locally (no GPU needed):  python finetune/prepare_data.py
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SO_FILE = os.path.join(HERE, "..", "nexus-model", "data", "raw", "stackoverflow_qa.txt")
OUT_DIR = os.path.join(HERE, "data")
OUT = os.path.join(OUT_DIR, "train.jsonl")

MAX_Q = 1500   # chars; keep examples a reasonable length
MAX_A = 2500

# Blocks look like:
#   ### [tag] Title
#
#   Question:
#   <body>
#
#   Answer:
#   <body>
BLOCK_RE = re.compile(
    r"###\s*\[(?P<tag>[^\]]*)\]\s*(?P<title>.*?)\n+Question:\n(?P<q>.*?)\n+Answer:\n(?P<a>.*?)(?=\n###\s*\[|\Z)",
    re.S,
)


def clip(s, n):
    s = s.strip()
    return s if len(s) <= n else s[:n].rsplit(" ", 1)[0] + " ..."


def main():
    if not os.path.exists(SO_FILE):
        raise SystemExit(f"Not found: {SO_FILE}\nRun the Stack Overflow collector first.")
    os.makedirs(OUT_DIR, exist_ok=True)
    text = open(SO_FILE, encoding="utf-8", errors="ignore").read()

    n = 0
    with open(OUT, "w", encoding="utf-8") as f:
        for m in BLOCK_RE.finditer(text):
            title = m.group("title").strip()
            q = clip(m.group("q"), MAX_Q)
            a = clip(m.group("a"), MAX_A)
            if len(a) < 40 or len(q) < 5:
                continue
            user = f"{title}\n\n{q}".strip()
            example = {
                "messages": [
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": a},
                ]
            }
            f.write(json.dumps(example, ensure_ascii=False) + "\n")
            n += 1

    print(f"Wrote {n} instruction examples -> {OUT}")
    if n:
        print("Preview of example 1:")
        first = json.loads(open(OUT, encoding="utf-8").readline())
        print("  user:", first["messages"][0]["content"][:120].replace("\n", " "), "...")
        print("  assistant:", first["messages"][1]["content"][:120].replace("\n", " "), "...")


if __name__ == "__main__":
    main()

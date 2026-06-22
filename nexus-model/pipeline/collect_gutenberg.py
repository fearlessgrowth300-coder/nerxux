"""
Collect public-domain books from Project Gutenberg (legal, copyright-free).

Downloads plain-text books by id into data/raw/. Uses only the stdlib so it
runs anywhere. Be polite: small delay between requests.

Usage:
  python -m pipeline.collect_gutenberg --ids 1342 84 11 1661 2701
  python -m pipeline.collect_gutenberg --count 20    # a curated starter set
"""

import argparse
import os
import time
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(HERE, "data", "raw")

# A few well-known public-domain works to get started.
STARTER_IDS = [1342, 84, 11, 1661, 2701, 98, 1232, 1080, 2542, 5200,
               174, 345, 1260, 76, 120, 158, 43, 215, 1400, 768]

MIRRORS = [
    "https://www.gutenberg.org/files/{id}/{id}-0.txt",
    "https://www.gutenberg.org/files/{id}/{id}.txt",
    "https://www.gutenberg.org/cache/epub/{id}/pg{id}.txt",
]


def download_one(book_id):
    os.makedirs(RAW, exist_ok=True)
    dest = os.path.join(RAW, f"gutenberg_{book_id}.txt")
    if os.path.exists(dest):
        return dest
    for url in MIRRORS:
        try:
            req = urllib.request.Request(url.format(id=book_id),
                                         headers={"User-Agent": "nexus-model/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read().decode("utf-8", "ignore")
            if len(data) > 1000:
                with open(dest, "w", encoding="utf-8") as f:
                    f.write(data)
                return dest
        except Exception:
            continue
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", nargs="*", type=int)
    ap.add_argument("--count", type=int, default=len(STARTER_IDS))
    args = ap.parse_args()

    ids = args.ids if args.ids else STARTER_IDS[:args.count]
    ok = 0
    for i, bid in enumerate(ids, 1):
        path = download_one(bid)
        if path:
            ok += 1
            print(f"[{i}/{len(ids)}] downloaded #{bid}")
        else:
            print(f"[{i}/{len(ids)}] FAILED #{bid}")
        time.sleep(0.8)
    print(f"\nDone. {ok}/{len(ids)} books in {RAW}")
    print("Next:  python -m pipeline.build_corpus")


if __name__ == "__main__":
    main()

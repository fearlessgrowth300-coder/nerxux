"""
Collect public-domain books by TOPIC from the Project Gutenberg catalog
(via the gutendex API). Legal, copyright-free.

Used to pull the sales / business / success / self-improvement canon -- there is
a deep bench of early-1900s salesmanship and persuasion classics in the public
domain.

Usage:
  python -m pipeline.collect_topics --preset sales
  python -m pipeline.collect_topics --search "salesmanship" "persuasion" --max 40
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

# Book titles can contain non-cp1252 characters; on Windows the default console
# encoding can't print them and crashes. Force UTF-8 (files are already UTF-8).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(HERE, "data", "raw")
API = "https://gutendex.com/books/"

# Curated search terms per preset (all return public-domain works).
PRESETS = {
    "sales": [
        "salesmanship", "selling", "salesman", "business success",
        "advertising", "persuasion", "influence", "negotiation",
        "money getting", "wealth", "prosperity", "self-help",
        "success", "personal magnetism", "public speaking", "psychology",
    ],
    "business": [
        "business", "commerce", "economics", "management",
        "finance", "marketing", "entrepreneur", "industry",
    ],
    # Author-name searches reliably return that author's novels/stories -> a
    # clean way to top up FICTION (creativity, dialogue, narrative, emotion).
    "fiction": [
        "Dickens", "Austen", "Twain", "Dostoyevsky", "Tolstoy",
        "Wells", "Verne", "Doyle", "Wilde", "Stevenson",
        "Hugo", "Poe", "Hawthorne", "Conrad", "Kipling",
        "Dumas", "Bronte", "Hardy", "Chekhov", "Melville",
    ],
}

PLAIN_KEYS = (
    "text/plain; charset=utf-8",
    "text/plain; charset=us-ascii",
    "text/plain",
)


def _fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "nexus-model/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def _plain_url(formats):
    for k in PLAIN_KEYS:
        if k in formats and not formats[k].endswith(".zip"):
            return formats[k]
    # fall back to any text/plain* entry
    for k, v in formats.items():
        if k.startswith("text/plain") and not v.endswith(".zip"):
            return v
    return None


def download_book(book_id, url):
    os.makedirs(RAW, exist_ok=True)
    dest = os.path.join(RAW, f"gutenberg_{book_id}.txt")
    if os.path.exists(dest):
        return "exists"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "nexus-model/1.0"})
        with urllib.request.urlopen(req, timeout=40) as r:
            data = r.read().decode("utf-8", "ignore")
        if len(data) > 1000:
            with open(dest, "w", encoding="utf-8") as f:
                f.write(data)
            return "ok"
    except Exception:
        return "fail"
    return "fail"


def search_topic(term, max_books):
    """Yield (id, plain_text_url) for a search term, across paginated results."""
    url = API + "?" + urllib.parse.urlencode({"search": term})
    got = 0
    while url and got < max_books:
        try:
            page = _fetch_json(url)
        except Exception as e:
            print(f"    (search '{term}' failed: {e})")
            return
        for book in page.get("results", []):
            if got >= max_books:
                break
            purl = _plain_url(book.get("formats", {}))
            if purl:
                yield book["id"], book["title"], purl
                got += 1
        url = page.get("next")
        time.sleep(0.4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", choices=list(PRESETS.keys()))
    ap.add_argument("--search", nargs="*", default=[])
    ap.add_argument("--max", type=int, default=8, help="max books PER search term")
    args = ap.parse_args()

    terms = list(args.search)
    if args.preset:
        terms += PRESETS[args.preset]
    if not terms:
        terms = PRESETS["sales"]

    seen, ok = set(), 0
    for term in terms:
        print(f"Searching: {term!r}")
        for bid, title, url in search_topic(term, args.max):
            if bid in seen:
                continue
            seen.add(bid)
            status = download_book(bid, url)
            mark = {"ok": "+", "exists": "=", "fail": "x"}[status]
            print(f"  [{mark}] #{bid}  {title[:60]}")
            if status == "ok":
                ok += 1
            time.sleep(0.5)
    print(f"\nDone. {ok} new books downloaded to {RAW} ({len(seen)} unique matched).")
    print("Next:  python -m pipeline.build_corpus")


if __name__ == "__main__":
    main()

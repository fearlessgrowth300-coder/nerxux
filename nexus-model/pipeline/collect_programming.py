"""
Collect OPENLY-LICENSED programming / developer books from GitHub.

Modern programming books are mostly copyrighted -- there is no legal way to mass
-download them. But several excellent books are published under open licenses
(MIT / Apache / CC-BY-SA) with their full text in public GitHub repos. We pull
those legally here. Add your own (owned) PDFs via the app's Train page for more.

Usage:
  python -m pipeline.collect_programming
"""

import base64
import json
import os
import time
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(HERE, "data", "raw")

# (repo, subpath, license) -- all open-licensed, full book text in the repo.
SOURCES = [
    ("rust-lang/book", "src", "MIT/Apache-2.0"),                 # The Rust Programming Language
    ("rust-lang/rust-by-example", "src", "MIT/Apache-2.0"),      # Rust by Example
    ("progit/progit2", "book", "CC BY-SA 3.0"),                  # Pro Git (asciidoc)
]
TEXT_EXT = (".md", ".markdown", ".asc", ".adoc", ".txt", ".rst")
GH_API = "https://api.github.com/repos/{repo}/contents/{path}"


def _api(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "nexus-model/1.0",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def walk(repo, path, depth=0):
    """Recursively yield (file_path, download_url) for text files in a repo path."""
    if depth > 4:
        return
    try:
        items = _api(GH_API.format(repo=repo, path=path))
    except Exception as e:
        print(f"    (list {repo}/{path} failed: {e})")
        return
    if isinstance(items, dict):  # single file
        items = [items]
    for it in items:
        if it["type"] == "dir":
            yield from walk(repo, it["path"], depth + 1)
            time.sleep(0.2)
        elif it["type"] == "file" and it["name"].lower().endswith(TEXT_EXT):
            yield it["path"], it.get("download_url"), it.get("url")


def fetch_text(download_url, api_url):
    try:
        if download_url:
            req = urllib.request.Request(download_url, headers={"User-Agent": "nexus-model/1.0"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode("utf-8", "ignore")
        # fall back to the API blob (base64) if no raw url
        blob = _api(api_url)
        if blob.get("encoding") == "base64":
            return base64.b64decode(blob["content"]).decode("utf-8", "ignore")
    except Exception:
        return None
    return None


def main():
    os.makedirs(RAW, exist_ok=True)
    total = 0
    for repo, path, lic in SOURCES:
        slug = repo.replace("/", "_")
        print(f"Repo: {repo}  ({lic})")
        parts, count = [], 0
        for fpath, durl, aurl in walk(repo, path):
            txt = fetch_text(durl, aurl)
            if txt and len(txt) > 200:
                parts.append(f"\n\n# FILE: {fpath}\n\n{txt}")
                count += 1
                if count % 25 == 0:
                    print(f"    {count} files...")
            time.sleep(0.05)
        if parts:
            dest = os.path.join(RAW, f"prog_{slug}.txt")
            with open(dest, "w", encoding="utf-8") as f:
                f.write("".join(parts))
            size = os.path.getsize(dest)
            print(f"  saved {count} files -> {os.path.basename(dest)} ({size:,} bytes)")
            total += count
        else:
            print("  (no files collected)")
    print(f"\nDone. {total} programming files collected to {RAW}.")
    print("Next:  python -m pipeline.build_corpus")


if __name__ == "__main__":
    main()

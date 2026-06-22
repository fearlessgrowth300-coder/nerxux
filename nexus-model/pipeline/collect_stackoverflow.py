"""
Collect Stack Overflow Question/Answer pairs via the official Stack Exchange API.

Raw code teaches syntax; Stack Overflow teaches *reasoning* -- humans explaining
why code works, how to fix bugs, and the logic behind a solution. Content is
CC BY-SA (attribution/share-alike). We fetch top-voted questions per tag and
their highest-voted answer, strip the HTML, and store them as Q/A text.

Usage:
  python -m pipeline.collect_stackoverflow --tags python javascript git sql --per-tag 100
"""

import argparse
import gzip
import html
import json
import os
import re
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(HERE, "data", "raw")
API = "https://api.stackexchange.com/2.3"

DEFAULT_TAGS = ["python", "javascript", "java", "c++", "git", "sql", "html", "reactjs"]
_TAG_RE = re.compile(r"(?s)<[^>]+>")
_PRE_RE = re.compile(r"(?s)<pre>.*?</pre>")


def _get(path, params):
    qs = urllib.parse.urlencode(params)
    url = f"{API}/{path}?{qs}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "nexus-model/1.0",
        "Accept-Encoding": "gzip",
    })
    with urllib.request.urlopen(req, timeout=40) as r:
        data = r.read()
    if data[:2] == b"\x1f\x8b":           # gzip magic -> decompress
        data = gzip.decompress(data)
    return json.loads(data.decode("utf-8", "ignore"))


def strip_html(s):
    if not s:
        return ""
    s = s.replace("</p>", "\n").replace("<li>", "\n- ")
    s = _TAG_RE.sub("", s)
    s = html.unescape(s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def fetch_tag(tag, per_tag):
    """Return list of (title, q_body, a_body) for top questions in a tag."""
    out = []
    page, got = 1, 0
    q_by_id = {}
    while got < per_tag and page <= 5:
        resp = _get("questions", {
            "order": "desc", "sort": "votes", "tagged": tag,
            "site": "stackoverflow", "pagesize": min(100, per_tag),
            "page": page, "filter": "withbody",
        })
        items = resp.get("items", [])
        for it in items:
            if it.get("answer_count", 0) > 0:
                q_by_id[it["question_id"]] = (it.get("title", ""), it.get("body", ""))
                got += 1
        if not resp.get("has_more") or not items:
            break
        page += 1
        time.sleep(float(resp.get("backoff", 0)) + 0.3)

    # Fetch answers for these questions (batched, top-voted first).
    ids = list(q_by_id.keys())
    answers = {}
    for i in range(0, len(ids), 90):
        batch = ids[i:i + 90]
        resp = _get(f"questions/{';'.join(map(str, batch))}/answers", {
            "order": "desc", "sort": "votes", "site": "stackoverflow",
            "filter": "withbody", "pagesize": 100,
        })
        for a in resp.get("items", []):
            qid = a["question_id"]
            if qid not in answers:        # first = highest voted
                answers[qid] = a.get("body", "")
        time.sleep(float(resp.get("backoff", 0)) + 0.3)

    for qid, (title, qbody) in q_by_id.items():
        if qid in answers:
            out.append((title, strip_html(qbody), strip_html(answers[qid])))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tags", nargs="*", default=DEFAULT_TAGS)
    ap.add_argument("--per-tag", type=int, default=100)
    args = ap.parse_args()

    os.makedirs(RAW, exist_ok=True)
    blocks, total = [], 0
    for tag in args.tags:
        print(f"Tag: {tag}")
        try:
            qa = fetch_tag(tag, args.per_tag)
        except Exception as e:
            print(f"  (failed: {e})")
            continue
        for title, q, a in qa:
            if len(a) < 40:
                continue
            blocks.append(
                f"### [{tag}] {title}\n\nQuestion:\n{q}\n\nAnswer:\n{a}\n"
            )
        print(f"  collected {len(qa)} Q/A pairs")
        total += len(qa)

    if blocks:
        dest = os.path.join(RAW, "stackoverflow_qa.txt")
        with open(dest, "w", encoding="utf-8") as f:
            f.write("\n\n".join(blocks))
        print(f"\nWrote {os.path.basename(dest)} ({os.path.getsize(dest):,} bytes, {total} pairs)")
    else:
        print("\nNo Q/A collected (API quota or network?).")
    print("Next:  python -m pipeline.build_corpus")


if __name__ == "__main__":
    main()

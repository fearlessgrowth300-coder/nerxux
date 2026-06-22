"""
Collect real source CODE from permissively-licensed (MIT) GitHub repos.

Big models learn code from public repositories (e.g. "The Stack"). The full Stack
is terabytes -- not downloadable here -- but we can pull clean, documented,
teaching-oriented code legally from MIT-licensed repos. That gives the model
syntax, library usage, and real project structure across several languages.

Uses the Git Trees API (one request returns a repo's whole file list) + raw file
downloads (not rate-limited), so it's friendly to GitHub's anonymous limits.

Usage:
  python -m pipeline.collect_code
"""

import json
import os
import time
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(HERE, "data", "raw")

# (repo, license) -- all MIT, documented, multi-language teaching code.
REPOS = [
    ("TheAlgorithms/Python", "MIT"),
    ("TheAlgorithms/JavaScript", "MIT"),
    ("trekhleb/javascript-algorithms", "MIT"),
]
CODE_EXT = (".py", ".js", ".ts", ".java", ".go", ".rs", ".c", ".cpp", ".rb",
            ".cs", ".sh", ".sql", ".md")
MAX_FILES_PER_REPO = 500
MAX_FILE_BYTES = 60_000
RAW_URL = "https://raw.githubusercontent.com/{repo}/{branch}/{path}"


def _api(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "nexus-model/1.0",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def default_branch(repo):
    try:
        return _api(f"https://api.github.com/repos/{repo}").get("default_branch", "master")
    except Exception:
        return "master"


def list_tree(repo, branch):
    url = f"https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1"
    try:
        tree = _api(url)
    except Exception as e:
        print(f"    (tree {repo}@{branch} failed: {e})")
        return []
    return [t for t in tree.get("tree", [])
            if t.get("type") == "blob"
            and t["path"].lower().endswith(CODE_EXT)
            and t.get("size", 0) <= MAX_FILE_BYTES]


def fetch_raw(repo, branch, path):
    try:
        req = urllib.request.Request(RAW_URL.format(repo=repo, branch=branch, path=path),
                                     headers={"User-Agent": "nexus-model/1.0"})
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.read().decode("utf-8", "ignore")
    except Exception:
        return None


def main():
    os.makedirs(RAW, exist_ok=True)
    total = 0
    for repo, lic in REPOS:
        branch = default_branch(repo)
        print(f"Repo: {repo}@{branch}  ({lic})")
        blobs = list_tree(repo, branch)[:MAX_FILES_PER_REPO]
        print(f"  {len(blobs)} code files")
        parts, count = [], 0
        for b in blobs:
            txt = fetch_raw(repo, branch, b["path"])
            if txt and len(txt) > 60:
                parts.append(f"\n\n# FILE: {repo}/{b['path']}\n\n{txt}")
                count += 1
                if count % 100 == 0:
                    print(f"    {count}/{len(blobs)} files...")
            time.sleep(0.03)
        if parts:
            slug = repo.replace("/", "_")
            dest = os.path.join(RAW, f"code_{slug}.txt")
            with open(dest, "w", encoding="utf-8") as f:
                f.write("".join(parts))
            print(f"  saved {count} files -> {os.path.basename(dest)} ({os.path.getsize(dest):,} bytes)")
            total += count
    print(f"\nDone. {total} code files collected to {RAW}.")
    print("Next:  python -m pipeline.build_corpus")


if __name__ == "__main__":
    main()

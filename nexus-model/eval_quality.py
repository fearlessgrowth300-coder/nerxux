"""
Honest quality evaluation for the from-scratch Nexus model.

Runs fixed prompts against the model server (/chat) and scores each reply with
rule-based checks. This is the anti-faking gate: random text / repetition /
symbol soup FAILS. Prints PASS/FAIL per check and exits non-zero on failure.

Usage:  python eval_quality.py            (uses http://127.0.0.1:4500)
"""

import json
import os
import re
import sys
import urllib.request

URL = os.environ.get("NEXUS_MODEL_URL", "http://127.0.0.1:4500")

PROMPTS = [
    {"q": "What are you?", "keywords": ["i", "model", "nexus", "ai", "assistant", "help"]},
    {"q": "Explain how to train Nexus AI.", "keywords": ["train", "data", "model", "text", "upload"]},
    {"q": "If I have 3 apples and buy 2 more, how many apples do I have?",
     "keywords": ["5", "five", "apple"], "arithmetic": "5"},
    {"q": "Give me a simple helpful answer about learning digital marketing.",
     "keywords": ["marketing", "learn", "online", "content", "audience", "social"]},
]


def post_chat(question):
    body = json.dumps({"messages": [{"role": "user", "content": question}]}).encode()
    req = urllib.request.Request(URL + "/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read().decode("utf-8", "ignore"))
    return d.get("reply") or d.get("content") or ""


def words(s):
    return re.findall(r"[A-Za-z']+", s.lower())


def repetition_ratio(s):
    """1.0 = all unique words, low = repetitive. Also catch single-token loops."""
    w = words(s)
    if not w:
        return 0.0
    return len(set(w)) / len(w)


def symbol_ratio(s):
    if not s:
        return 1.0
    letters = sum(c.isalpha() or c.isspace() for c in s)
    return 1.0 - letters / len(s)


def score_reply(reply, spec):
    checks = {}
    checks["non_empty"] = len(reply.strip()) >= 10
    checks["not_repetitive"] = repetition_ratio(reply) >= 0.45
    checks["not_symbol_soup"] = symbol_ratio(reply) <= 0.30
    w = set(words(reply))
    checks["on_topic"] = any(k in w or k in reply.lower() for k in spec["keywords"])
    if "arithmetic" in spec:
        checks["arithmetic_correct"] = spec["arithmetic"] in reply
    return checks


def main():
    print(f"== Nexus quality eval against {URL} ==\n")
    try:
        health = json.loads(urllib.request.urlopen(URL + "/health", timeout=10).read())
        print(f"model: {health.get('parameter_count', health.get('params'))} params, "
              f"checkpoint_step={health.get('checkpoint_step')}, loss={health.get('loss')}, "
              f"status={health.get('quality_status')}\n")
    except Exception as e:
        print(f"FAIL: model server not reachable at {URL} ({e})")
        sys.exit(2)

    total, passed = 0, 0
    all_ok = True
    for spec in PROMPTS:
        try:
            reply = post_chat(spec["q"])
        except Exception as e:
            print(f"PROMPT: {spec['q']}\n  FAIL: request error {e}\n")
            all_ok = False
            continue
        checks = score_reply(reply, spec)
        print(f"PROMPT: {spec['q']}")
        print(f"  reply: {reply[:160]!r}")
        for name, ok in checks.items():
            total += 1
            passed += int(ok)
            print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
            if not ok:
                all_ok = False
        print()

    print(f"== SCORE: {passed}/{total} checks passed ==")
    if all_ok:
        print("RESULT: PASS — output is coherent enough.")
        sys.exit(0)
    else:
        print("RESULT: FAIL — model output does not meet the coherence bar yet.")
        sys.exit(1)


if __name__ == "__main__":
    main()

"""
Cleaning: rules + filters (Regex / heuristics), not AI.

Removes page numbers, headers/footers, Gutenberg license boilerplate, control
characters, and collapses excess whitespace. Drops chunks that are mostly junk.
"""

import re

# Project Gutenberg license markers -- strip everything outside the real book.
_GUT_START = re.compile(r"\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG.*?\*\*\*", re.I | re.S)
_GUT_END = re.compile(r"\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG.*", re.I | re.S)


def strip_gutenberg(text):
    m = _GUT_START.search(text)
    if m:
        text = text[m.end():]
    m = _GUT_END.search(text)
    if m:
        text = text[:m.start()]
    return text


def clean_text(text):
    text = strip_gutenberg(text)
    # normalize newlines / unicode quotes
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = (text.replace("‘", "'").replace("’", "'")
                .replace("“", '"').replace("”", '"')
                .replace("—", "--").replace("–", "-"))
    # drop control chars
    text = re.sub(r"[^\S\n]+", " ", text)               # collapse runs of spaces
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    # lone page numbers on their own line
    text = re.sub(r"\n\s*\d{1,4}\s*\n", "\n", text)
    # 3+ blank lines -> 2
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def looks_like_garbage(chunk, min_len=200, min_alpha_ratio=0.6):
    """Heuristic filter: reject OCR sludge / tables / mostly-symbols."""
    if len(chunk) < min_len:
        return True
    letters = sum(c.isalpha() or c.isspace() for c in chunk)
    if letters / max(1, len(chunk)) < min_alpha_ratio:
        return True
    return False

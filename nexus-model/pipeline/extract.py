"""
Extraction: turn raw files (PDF / HTML / EPUB / TXT) into plain text.

These are deterministic, rule-based tools -- NOT AI. A PDF already has a hidden
text layer; we just read it. HTML is stripped of tags. This is the same idea as
pdftotext / Apache Tika, done with small Python libraries.
"""

import os
import re
import zipfile

# pypdf is optional; we degrade gracefully if it isn't installed.
try:
    from pypdf import PdfReader
    _HAVE_PDF = True
except Exception:
    _HAVE_PDF = False


def extract_pdf(path):
    if not _HAVE_PDF:
        raise RuntimeError("pypdf not installed -- run: pip install pypdf")
    reader = PdfReader(path)
    parts = []
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            continue
    return "\n".join(parts)


def extract_html(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        html = f.read()
    html = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)         # strip tags
    text = re.sub(r"&[a-z]+;", " ", text)            # crude entity strip
    return text


def extract_epub(path):
    """EPUB is a zip of XHTML files."""
    out = []
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.lower().endswith((".xhtml", ".html", ".htm")):
                raw = z.read(name).decode("utf-8", "ignore")
                raw = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
                out.append(re.sub(r"(?s)<[^>]+>", " ", raw))
    return "\n".join(out)


def extract_txt(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        return f.read()


def extract_file(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        return extract_pdf(path)
    if ext in (".html", ".htm"):
        return extract_html(path)
    if ext == ".epub":
        return extract_epub(path)
    if ext in (".txt", ".md"):
        return extract_txt(path)
    # Unknown -> try as plain text.
    return extract_txt(path)

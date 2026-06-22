"""
Byte-Pair Encoding (BPE) tokenizer -- trained from scratch, no libraries.

Text can't go into a neural net directly; it has to become numbers. BPE starts
from raw bytes and repeatedly merges the most frequent adjacent pair into a new
token, building a vocabulary that covers common words/subwords efficiently. This
is the same algorithm GPT-2 and friends use (just a readable version).
"""

import json
import re
from collections import Counter

# Split on whitespace/punctuation boundaries so merges stay inside "words".
_SPLIT = re.compile(r"\s+|[^\sA-Za-z0-9]+|[A-Za-z]+|[0-9]+")


def _word_tokens(text):
    return _SPLIT.findall(text)


class BPETokenizer:
    def __init__(self):
        # vocab: token string -> id.  byte fallback covers anything unseen.
        self.merges = []          # list of (a, b) merge rules in order
        self.vocab = {}           # token -> id
        self.inv_vocab = {}       # id -> token
        self._enc_cache = {}      # word -> [ids]; most words repeat a lot

    # --- training --------------------------------------------------------
    def train(self, text, vocab_size=2048, verbose=True, min_freq=2):
        # Seed vocabulary with every single byte (0-255) so nothing is OOV.
        tokens = set(chr(b) for b in range(256))
        # Represent corpus as list of words, each a tuple of 1-char symbols.
        words = Counter(_word_tokens(text))
        # Drop one-off words (mostly unique code identifiers / hex literals) from
        # the MERGE-learning set: they bloat every merge pass without improving
        # the vocabulary, and anything unseen is still covered by byte fallback.
        # Guard against tiny corpora where everything is rare.
        filtered = {w: c for w, c in words.items() if c >= min_freq}
        if len(filtered) >= 200:
            words = filtered
        corpus = {tuple(w): c for w, c in words.items()}

        for t in sorted(tokens):
            pass  # bytes added to vocab at the end

        target_merges = max(0, vocab_size - 256)
        for step in range(target_merges):
            pairs = Counter()
            for word, freq in corpus.items():
                for i in range(len(word) - 1):
                    pairs[(word[i], word[i + 1])] += freq
            if not pairs:
                break
            (a, b), _ = pairs.most_common(1)[0]
            self.merges.append((a, b))
            merged = a + b
            tokens.add(merged)
            new_corpus = {}
            for word, freq in corpus.items():
                new_word, i = [], 0
                while i < len(word):
                    if i < len(word) - 1 and word[i] == a and word[i + 1] == b:
                        new_word.append(merged)
                        i += 2
                    else:
                        new_word.append(word[i])
                        i += 1
                new_corpus[tuple(new_word)] = freq
            corpus = new_corpus
            if verbose and (step + 1) % 200 == 0:
                print(f"  merge {step + 1}/{target_merges}  vocab~{len(tokens)}")

        for i, tok in enumerate(sorted(tokens)):
            self.vocab[tok] = i
            self.inv_vocab[i] = tok
        return self

    # --- encode / decode -------------------------------------------------
    def _apply_merges(self, word):
        symbols = list(word)
        for a, b in self.merges:
            i = 0
            while i < len(symbols) - 1:
                if symbols[i] == a and symbols[i + 1] == b:
                    symbols[i:i + 2] = [a + b]
                else:
                    i += 1
        return symbols

    def _encode_word(self, word):
        cached = self._enc_cache.get(word)
        if cached is not None:
            return cached
        ids = []
        for sym in self._apply_merges(word):
            if sym in self.vocab:
                ids.append(self.vocab[sym])
            else:
                for ch in sym:  # byte-level fallback
                    ids.append(self.vocab.get(ch, 0))
        self._enc_cache[word] = ids
        return ids

    def encode(self, text):
        ids = []
        for word in _word_tokens(text):
            ids.extend(self._encode_word(word))
        return ids

    def decode(self, ids):
        return "".join(self.inv_vocab.get(int(i), "") for i in ids)

    @property
    def vocab_size(self):
        return len(self.vocab)

    # --- persistence -----------------------------------------------------
    def save(self, path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"merges": self.merges, "vocab": self.vocab}, f)

    @staticmethod
    def load(path):
        t = BPETokenizer()
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        t.merges = [tuple(m) for m in d["merges"]]
        t.vocab = d["vocab"]
        t.inv_vocab = {v: k for k, v in t.vocab.items()}
        return t

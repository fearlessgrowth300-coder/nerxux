"""
A small GPT (decoder-only transformer) built on the from-scratch autograd engine.

This is the same architecture family as GPT-2/GPT-3/Claude -- token embeddings,
positional embeddings, a stack of transformer blocks (causal self-attention +
MLP), and a final projection that predicts the NEXT token. It is small because
it trains on one machine; the math is identical to the big ones, just fewer
layers/parameters and less data.
"""

import numpy as np

from .autograd import Tensor, embedding, layernorm, cross_entropy


class Config:
    def __init__(self, vocab_size, block_size=64, n_layer=4, n_head=4, n_embd=128):
        self.vocab_size = vocab_size
        self.block_size = block_size      # context window (how many tokens it sees)
        self.n_layer = n_layer            # number of transformer blocks
        self.n_head = n_head              # attention heads
        self.n_embd = n_embd              # embedding / hidden width

    def to_dict(self):
        return {
            "vocab_size": self.vocab_size,
            "block_size": self.block_size,
            "n_layer": self.n_layer,
            "n_head": self.n_head,
            "n_embd": self.n_embd,
        }

    @staticmethod
    def from_dict(d):
        return Config(**d)


def _param(shape, scale):
    return Tensor(np.random.randn(*shape).astype(np.float32) * scale)


class GPT:
    def __init__(self, config: Config):
        self.config = config
        C, V, B = config.n_embd, config.vocab_size, config.block_size
        s = 0.02
        self.params = {}
        p = self.params

        p["wte"] = _param((V, C), s)              # token embeddings
        p["wpe"] = _param((B, C), s)              # positional embeddings

        for i in range(config.n_layer):
            p[f"ln1_g{i}"] = Tensor(np.ones(C, dtype=np.float32))
            p[f"ln1_b{i}"] = Tensor(np.zeros(C, dtype=np.float32))
            p[f"attn_w{i}"] = _param((C, 3 * C), s)   # q,k,v packed
            p[f"attn_b{i}"] = Tensor(np.zeros(3 * C, dtype=np.float32))
            p[f"proj_w{i}"] = _param((C, C), s)
            p[f"proj_b{i}"] = Tensor(np.zeros(C, dtype=np.float32))
            p[f"ln2_g{i}"] = Tensor(np.ones(C, dtype=np.float32))
            p[f"ln2_b{i}"] = Tensor(np.zeros(C, dtype=np.float32))
            p[f"fc_w{i}"] = _param((C, 4 * C), s)
            p[f"fc_b{i}"] = Tensor(np.zeros(4 * C, dtype=np.float32))
            p[f"fcproj_w{i}"] = _param((4 * C, C), s)
            p[f"fcproj_b{i}"] = Tensor(np.zeros(C, dtype=np.float32))

        p["lnf_g"] = Tensor(np.ones(C, dtype=np.float32))
        p["lnf_b"] = Tensor(np.zeros(C, dtype=np.float32))
        # lm_head weights are tied to the token embeddings (standard trick).

        # Causal mask: position t may only attend to positions <= t.
        mask = np.triu(np.full((B, B), -1e9, dtype=np.float32), k=1)
        self._mask = mask

    def parameters(self):
        return list(self.params.values())

    def num_params(self):
        return int(sum(p.data.size for p in self.parameters()))

    def _block(self, x, i, T):
        p = self.params
        C = self.config.n_embd
        nh = self.config.n_head
        hs = C // nh

        # --- attention (pre-norm) ---
        a = layernorm(x, p[f"ln1_g{i}"], p[f"ln1_b{i}"])
        qkv = a @ p[f"attn_w{i}"] + p[f"attn_b{i}"]          # (B,T,3C)
        B = qkv.shape[0]
        # Split the packed projection into query / key / value (each B,T,C).
        q = _slice_last(qkv, 0, C)
        k = _slice_last(qkv, C, 2 * C)
        v = _slice_last(qkv, 2 * C, 3 * C)

        # reshape to heads: (B, nh, T, hs)
        q = q.reshape(B, T, nh, hs).swapaxes(1, 2)
        k = k.reshape(B, T, nh, hs).swapaxes(1, 2)
        v = v.reshape(B, T, nh, hs).swapaxes(1, 2)

        att = (q @ k.swapaxes(-2, -1)) * (1.0 / np.sqrt(hs))  # (B,nh,T,T)
        att = att + Tensor(self._mask[:T, :T])
        att = att.softmax(axis=-1)
        y = att @ v                                            # (B,nh,T,hs)
        y = y.swapaxes(1, 2).reshape(B, T, C)
        y = y @ p[f"proj_w{i}"] + p[f"proj_b{i}"]
        x = x + y

        # --- MLP (pre-norm) ---
        m = layernorm(x, p[f"ln2_g{i}"], p[f"ln2_b{i}"])
        m = (m @ p[f"fc_w{i}"] + p[f"fc_b{i}"]).gelu()
        m = m @ p[f"fcproj_w{i}"] + p[f"fcproj_b{i}"]
        x = x + m
        return x

    def forward(self, idx, targets=None):
        """idx: int array (B, T). Returns (logits Tensor, loss Tensor|None)."""
        p = self.params
        B, T = idx.shape
        pos = np.arange(T)
        tok = embedding(p["wte"], idx)            # (B,T,C)
        pe = embedding(p["wpe"], pos)             # (T,C)
        x = tok + pe                              # broadcast over batch

        for i in range(self.config.n_layer):
            x = self._block(x, i, T)

        x = layernorm(x, p["lnf_g"], p["lnf_b"])
        logits = x @ p["wte"].swapaxes(0, 1)       # tied weights -> (B,T,V)

        loss = None
        if targets is not None:
            V = self.config.vocab_size
            loss = cross_entropy(logits.reshape(B * T, V), targets.reshape(B * T))
        return logits, loss

    # --- save / load (plain .npz, no framework needed) ---
    def state(self):
        return {k: v.data for k, v in self.params.items()}

    def load_state(self, state):
        for k, v in self.params.items():
            if k in state:
                v.data = np.asarray(state[k], dtype=np.float32)


def _slice_last(t: Tensor, a, b):
    """Differentiable slice of the last axis: t[..., a:b]."""
    out = Tensor(t.data[..., a:b], (t,), "slice")

    def _backward():
        g = np.zeros_like(t.data)
        g[..., a:b] = out.grad
        t.grad += g

    out._backward = _backward
    return out

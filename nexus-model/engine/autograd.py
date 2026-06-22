"""
Minimal reverse-mode autograd over NumPy arrays.

This is the "Learner": a small engine that records every math operation it does
in a forward pass, then walks that graph backwards (the chain rule) to compute
how each parameter should change to lower the loss. That is exactly what a real
deep-learning framework (PyTorch / TensorFlow) does under the hood -- this is a
from-scratch, readable version of it.

No PyTorch, no TensorFlow. Just NumPy + math.
"""

import math

import numpy as np

# Precompute gelu's constant as a PYTHON float. Using np.sqrt here would return a
# float64 scalar and silently upcast every activation to float64 (2x memory).
_GELU_C = math.sqrt(2.0 / math.pi)


def _noop():
    return None


def _unbroadcast(grad, shape):
    """Sum a gradient back down to `shape` (undoes NumPy broadcasting)."""
    while grad.ndim > len(shape):
        grad = grad.sum(axis=0)
    for i, s in enumerate(shape):
        if s == 1 and grad.shape[i] != 1:
            grad = grad.sum(axis=i, keepdims=True)
    return grad


class Tensor:
    """An N-dimensional array that remembers how it was computed."""

    def __init__(self, data, _children=(), _op=""):
        self.data = np.asarray(data, dtype=np.float32)
        self.grad = np.zeros_like(self.data)
        self._backward = lambda: None
        self._prev = set(_children)
        self._op = _op

    @property
    def shape(self):
        return self.data.shape

    # --- elementwise ops -------------------------------------------------
    def __add__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        out = Tensor(self.data + other.data, (self, other), "+")

        def _backward():
            self.grad += _unbroadcast(out.grad, self.data.shape)
            other.grad += _unbroadcast(out.grad, other.data.shape)

        out._backward = _backward
        return out

    def __mul__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        out = Tensor(self.data * other.data, (self, other), "*")

        def _backward():
            self.grad += _unbroadcast(other.data * out.grad, self.data.shape)
            other.grad += _unbroadcast(self.data * out.grad, other.data.shape)

        out._backward = _backward
        return out

    def __truediv__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        out = Tensor(self.data / other.data, (self, other), "/")

        def _backward():
            self.grad += _unbroadcast(out.grad / other.data, self.data.shape)
            other.grad += _unbroadcast(
                -out.grad * self.data / (other.data ** 2), other.data.shape
            )

        out._backward = _backward
        return out

    def __matmul__(self, other):
        out = Tensor(self.data @ other.data, (self, other), "@")

        def _backward():
            a = out.grad @ np.swapaxes(other.data, -1, -2)
            b = np.swapaxes(self.data, -1, -2) @ out.grad
            self.grad += _unbroadcast(a, self.data.shape)
            other.grad += _unbroadcast(b, other.data.shape)

        out._backward = _backward
        return out

    def __neg__(self):
        return self * -1.0

    def __sub__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        return self + (-other)

    def __radd__(self, other):
        return self + other

    def __rmul__(self, other):
        return self * other

    # --- shape ops -------------------------------------------------------
    def reshape(self, *shape):
        out = Tensor(self.data.reshape(*shape), (self,), "reshape")

        def _backward():
            self.grad += out.grad.reshape(self.data.shape)

        out._backward = _backward
        return out

    def swapaxes(self, a, b):
        out = Tensor(np.swapaxes(self.data, a, b), (self,), "swapaxes")

        def _backward():
            self.grad += np.swapaxes(out.grad, a, b)

        out._backward = _backward
        return out

    def sum(self, axis=None, keepdims=False):
        out = Tensor(self.data.sum(axis=axis, keepdims=keepdims), (self,), "sum")

        def _backward():
            g = out.grad
            if axis is not None and not keepdims:
                g = np.expand_dims(g, axis)
            self.grad += np.ones_like(self.data) * g

        out._backward = _backward
        return out

    # --- activations -----------------------------------------------------
    def exp(self):
        out = Tensor(np.exp(self.data), (self,), "exp")

        def _backward():
            self.grad += out.data * out.grad

        out._backward = _backward
        return out

    def gelu(self):
        x = self.data
        c = _GELU_C
        inner = c * (x + 0.044715 * x ** 3)
        t = np.tanh(inner)
        out = Tensor(0.5 * x * (1.0 + t), (self,), "gelu")

        def _backward():
            sech2 = 1.0 - t ** 2
            dx = 0.5 * (1.0 + t) + 0.5 * x * sech2 * c * (1.0 + 3 * 0.044715 * x ** 2)
            self.grad += out.grad * dx

        out._backward = _backward
        return out

    def softmax(self, axis=-1):
        m = self.data.max(axis=axis, keepdims=True)
        e = np.exp(self.data - m)
        s = e / e.sum(axis=axis, keepdims=True)
        out = Tensor(s, (self,), "softmax")

        def _backward():
            g = out.grad
            dot = (g * s).sum(axis=axis, keepdims=True)
            self.grad += s * (g - dot)

        out._backward = _backward
        return out

    # --- run the chain rule ---------------------------------------------
    def backward(self):
        topo, visited = [], set()

        def build(v):
            if v not in visited:
                visited.add(v)
                for child in v._prev:
                    build(child)
                topo.append(v)

        build(self)
        self.grad = np.ones_like(self.data)
        for v in reversed(topo):
            v._backward()

        # Drop the closures/edges to shrink the cycles the GC must trace. The
        # training loop still calls gc.collect() each step (these tensors form
        # reference cycles that refcounting alone won't reclaim). Empty tuple
        # keeps _prev iterable, since parameter tensors are reused next step.
        for v in topo:
            v._backward = _noop
            v._prev = ()


# --- functions that operate on Tensors ----------------------------------
def embedding(weight, idx):
    """Gather rows of `weight` (V, C) at integer indices `idx` -> (..., C)."""
    out = Tensor(weight.data[idx], (weight,), "embedding")

    def _backward():
        np.add.at(weight.grad, idx, out.grad)

    out._backward = _backward
    return out


def layernorm(x, gain, bias, eps=1e-5):
    """Normalize the last dimension, then scale + shift (learned gain/bias)."""
    xd = x.data
    mu = xd.mean(-1, keepdims=True)
    xc = xd - mu
    var = (xc ** 2).mean(-1, keepdims=True)
    inv = 1.0 / np.sqrt(var + eps)
    xhat = xc * inv
    out = Tensor(xhat * gain.data + bias.data, (x, gain, bias), "layernorm")

    def _backward():
        go = out.grad
        D = xd.shape[-1]
        bias.grad += _unbroadcast(go, bias.data.shape)
        gain.grad += _unbroadcast(go * xhat, gain.data.shape)
        dxhat = go * gain.data
        dvar = (dxhat * xc * -0.5 * inv ** 3).sum(-1, keepdims=True)
        dmu = (-dxhat * inv).sum(-1, keepdims=True) + dvar * (-2.0 * xc).mean(
            -1, keepdims=True
        )
        x.grad += dxhat * inv + dvar * 2.0 * xc / D + dmu / D

    out._backward = _backward
    return out


def cross_entropy(logits, targets):
    """Mean softmax cross-entropy. logits (N, V), targets (N,) int -> scalar."""
    data = logits.data
    m = data.max(axis=-1, keepdims=True)
    shifted = data - m
    logsumexp = np.log(np.exp(shifted).sum(axis=-1, keepdims=True))
    logp = shifted - logsumexp
    N = data.shape[0]
    loss = -(logp[np.arange(N), targets]).mean()
    out = Tensor(loss, (logits,), "cross_entropy")
    probs = np.exp(logp)

    def _backward():
        grad = probs.copy()
        grad[np.arange(N), targets] -= 1.0
        grad /= N
        logits.grad += grad * out.grad

    out._backward = _backward
    return out

"""
Serve your trained model over HTTP so the Nexus app can chat with it.

Stdlib-only HTTP server (no Flask). Endpoints:
  GET  /health   -> { ok, status, model_loaded, checkpoint, params }
  POST /reload   -> reloads the latest checkpoint from out/ (call after training)
  POST /chat     -> generate. Accepts EITHER:
                      { prompt, system?, max_tokens?, temperature? }
                    OR (OpenAI-style):
                      { messages: [{role, content}, ...] }
                    Returns: { content, reply, model }   (reply == content)

Run:  python serve.py            (port from NEXUS_MODEL_PORT, default 4500)
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from engine.tokenizer import BPETokenizer
from engine.model import GPT, Config
from engine.generate import generate

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
PORT = int(os.environ.get("NEXUS_MODEL_PORT", "4500"))

MODEL = {"gpt": None, "tok": None, "checkpoint": None, "meta": {}}

# Generation safety caps (prevent runaway output).
MAX_NEW_TOKENS_CAP = 400


def _quality_status(params, loss):
    """Honest label — small from-scratch models are experimental, not usable."""
    if params and params >= 30_000_000 and loss is not None and loss < 3.5:
        return "usable"
    return "experimental"


def load():
    """Load the latest checkpoint from out/. Returns True if a model is loaded."""
    cfg_path = os.path.join(OUT, "config.json")
    weights = os.path.join(OUT, "weights.npz")
    tok_path = os.path.join(OUT, "tokenizer.json")
    # Optional training metadata (step + loss) written by train.py.
    meta = {}
    meta_path = os.path.join(OUT, "meta.json")
    if os.path.exists(meta_path):
        try:
            meta = json.load(open(meta_path))
        except Exception:
            meta = {}
    MODEL["meta"] = meta
    if not (os.path.exists(cfg_path) and os.path.exists(weights) and os.path.exists(tok_path)):
        MODEL["gpt"], MODEL["tok"], MODEL["checkpoint"] = None, None, None
        return False
    try:
        with open(cfg_path) as f:
            cfg = Config.from_dict(json.load(f))
        gpt = GPT(cfg)
        state = np.load(weights)
        gpt.load_state({k: state[k] for k in state.files})
        MODEL["gpt"] = gpt
        MODEL["tok"] = BPETokenizer.load(tok_path)
        MODEL["checkpoint"] = weights
        return True
    except Exception as e:
        print(f"[serve] failed to load checkpoint: {e}")
        MODEL["gpt"], MODEL["tok"], MODEL["checkpoint"] = None, None, None
        return False


def _messages_to_prompt(messages):
    """Flatten OpenAI-style messages into (system, prompt)."""
    system = ""
    lines = []
    for m in messages or []:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if role == "system":
            system = content
        elif role == "user":
            lines.append(f"User: {content}")
        elif role == "assistant":
            lines.append(f"Assistant: {content}")
    lines.append("Assistant:")
    return system, "\n".join(lines)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return None

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path == "/health":
            gpt = MODEL["gpt"]
            params = gpt.num_params() if gpt else 0
            meta = MODEL.get("meta", {})
            loss = meta.get("loss")
            self._send(200, {
                "ok": True,
                "service": "nexus-from-scratch",
                "port": PORT,
                "status": "online",
                "model_loaded": gpt is not None,
                "loaded": gpt is not None,          # back-compat
                "checkpoint": MODEL["checkpoint"],
                "checkpoint_step": meta.get("step"),
                "loss": loss,
                "parameter_count": params,
                "params": params,                   # back-compat
                "quality_status": _quality_status(params, loss),
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/reload":
            ok = load()
            return self._send(200, {
                "ok": True, "model_loaded": ok, "checkpoint": MODEL["checkpoint"],
                "params": MODEL["gpt"].num_params() if MODEL["gpt"] else 0,
            })

        if self.path not in ("/chat", "/generate"):
            return self._send(404, {"error": "not found"})

        if MODEL["gpt"] is None:
            return self._send(503, {
                "error": "model not trained yet",
                "reply": "This model hasn't been trained yet. Go to the Train page, "
                         "build a corpus, and train first.",
            })

        data = self._read_json()
        if data is None:
            return self._send(400, {"error": "invalid json"})

        # Accept either {messages:[...]} or {prompt, system}.
        if data.get("messages"):
            system, prompt = _messages_to_prompt(data["messages"])
        else:
            system = (data.get("system") or "").strip()
            prompt = data.get("prompt", "")
        full = (system + "\n\n" + prompt).strip() if system else prompt

        max_new = min(int(data.get("max_tokens", 160)), MAX_NEW_TOKENS_CAP)
        try:
            out = generate(
                MODEL["gpt"], MODEL["tok"], full,
                max_new_tokens=max_new,
                temperature=float(data.get("temperature", 0.8)),
                top_k=int(data.get("top_k", 40)),
            )
        except Exception as e:
            return self._send(500, {"error": f"generation failed: {e}"})

        completion = out[len(full):].strip() or out.strip()
        gpt = MODEL["gpt"]
        self._send(200, {
            "content": completion,
            "reply": completion,
            "model": "nexus-from-scratch",
            "parameter_count": gpt.num_params() if gpt else 0,
            "checkpoint": MODEL["checkpoint"],
        })

    def log_message(self, *args):
        pass  # quiet


def main():
    loaded = load()
    print(f"[serve] Nexus model server on http://127.0.0.1:{PORT}", flush=True)
    print("[serve] checkpoint loaded" if loaded
          else "[serve] no trained model yet — /health works, /chat returns a clear message",
          flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

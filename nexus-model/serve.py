"""
Serve your trained model over HTTP so the Nexus app can chat with it.

Stdlib-only HTTP server (no Flask needed). Exposes:
  GET  /health           -> { ok, loaded, params }
  POST /chat  {prompt, system?, max_tokens?, temperature?}  -> { content }

Run:  python serve.py            (defaults to port 4500)
Then Nexus's "Nexus (your model)" adapter calls http://localhost:4500/chat.
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

MODEL = {"gpt": None, "tok": None}


def load():
    cfg_path = os.path.join(OUT, "config.json")
    if not os.path.exists(cfg_path):
        return False
    with open(cfg_path) as f:
        cfg = Config.from_dict(json.load(f))
    gpt = GPT(cfg)
    state = np.load(os.path.join(OUT, "weights.npz"))
    gpt.load_state({k: state[k] for k in state.files})
    MODEL["gpt"] = gpt
    MODEL["tok"] = BPETokenizer.load(os.path.join(OUT, "tokenizer.json"))
    return True


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

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path == "/health":
            gpt = MODEL["gpt"]
            self._send(200, {
                "ok": True,
                "loaded": gpt is not None,
                "params": gpt.num_params() if gpt else 0,
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/chat":
            return self._send(404, {"error": "not found"})
        if MODEL["gpt"] is None:
            return self._send(503, {"error": "model not trained yet -- run train.py"})
        length = int(self.headers.get("Content-Length", 0))
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._send(400, {"error": "invalid json"})

        system = (data.get("system") or "").strip()
        prompt = data.get("prompt", "")
        full = (system + "\n\n" + prompt).strip() if system else prompt
        out = generate(
            MODEL["gpt"], MODEL["tok"], full,
            max_new_tokens=int(data.get("max_tokens", 160)),
            temperature=float(data.get("temperature", 0.8)),
            top_k=int(data.get("top_k", 40)),
        )
        completion = out[len(full):].strip() or out.strip()
        self._send(200, {"content": completion, "model": "nexus-local"})

    def log_message(self, *args):
        pass  # quiet


def main():
    loaded = load()
    print(f"Nexus model server on http://localhost:{PORT}")
    print("loaded" if loaded else "NO trained model yet (train.py first) -- serving /health only")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

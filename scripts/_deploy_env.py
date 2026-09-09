"""Tiny .env.deploy loader shared by the Hostinger deploy scripts.

No third-party dependency (dotenv) required — just enough parsing to read
KEY=VALUE lines from scripts/.env.deploy into os.environ.
"""
import os

_ENV_PATH = os.path.join(os.path.dirname(__file__), ".env.deploy")


def load():
    if not os.path.exists(_ENV_PATH):
        raise SystemExit(
            f"Missing {_ENV_PATH}\n"
            "Copy scripts/.env.deploy.example to scripts/.env.deploy and fill in real values."
        )
    with open(_ENV_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def require(*keys):
    load()
    missing = [k for k in keys if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"scripts/.env.deploy is missing required value(s): {', '.join(missing)}")
    return {k: os.environ[k] for k in keys}

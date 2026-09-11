# Nexus AI — system handover

Everything an engineer (or another AI agent) needs to pick this up and work on
it. Written from the live system, not from memory.

**No credentials are in this file.** Where each secret lives is named; the
values must be granted separately. See *Access you must be given*.

---

## What this is

**Nexus AI** — a multi-model AI chat hub with an agent that can write code, run
it in a sandbox, use git, search the web, and call connected MCP services.
It serves several models: the user's own Qwen 3.8 27B (self-hosted, two compute
modes) plus Claude / GPT / Gemini / Groq via the user's API keys.

Three machines are involved:

| Piece | Where | Notes |
|---|---|---|
| Web client | **Vercel** — `nerxux.vercel.app` | React + Vite, auto-deploys on push to `main` |
| API server | **Hostinger VPS** — `2.25.126.125:4000` | Node/Express under PM2, process `nexus-server` |
| Database + auth | **Supabase** | Postgres + auth; URL in `server/.env` |
| GPU compute | **RunPod** pod, reached by SSH tunnel from the VPS | "Turbo" mode |
| CPU compute | The same Hostinger VPS | "Always On" mode |

`/api/*` on the Vercel domain is **rewritten** to the Hostinger server. The
client never talks to the VPS directly.

> Vercel's external rewrite kills any single request at **~120 s** (measured).
> This is why chat runs as an async job: `POST /api/chat` with `async: true`
> returns a `jobId` immediately and the client polls `GET /api/chat/jobs/:id`.
> Never make chat a single long request again.

---

## Hostinger VPS

```
ip        2.25.126.125      ssh root@2.25.126.125
os        Linux 6.8 (Ubuntu 24.04)
cpu/ram   8 cores / 31 GB      disk 387 GB (26 GB used)
```

PM2 processes (`pm2 list`, `pm2 logs <name>`):

| Process | Command | Purpose |
|---|---|---|
| `nexus-server` | `node /root/nerxux/server/index.js` (cwd `/root/nerxux/server`) | The API, port 4000 |
| `viewe-dashboard` | `venv/bin/python -m uvicorn app.main:app --port 8000` (cwd `/root/viewe-account`) | A **different, live** project — see below |

Ports: `4000` API · `8000` viewe-dashboard · `11434` Ollama (Always On) ·
`11435` SSH tunnel to the RunPod GPU · `22` ssh.

Installed for the agent's sandbox: `node 22`, `npm 10`, `git`, `bwrap`
(bubblewrap), `gh` CLI, `poppler-utils`, `pypdf`, `playwright` + Chromium at
`/usr/local/share/playwright`, `python3.12`.
**Not installed: `go`, `docker`.**

---

## Repositories

| Repo | Local path (VPS) | Branch |
|---|---|---|
| `fearlessgrowth300-coder/nerxux` — this app | `/root/nerxux` | `main` |
| `fearlessgrowth300-coder/viewe-account` — user's Twitch project | `/root/viewe-account` | `feature/dev` |

Also cloned on the user's Windows PC at `C:\Users\UPCOMING\nerxux`.

### Layout of `nerxux`

```
client/           React + Vite + Tailwind (deploys to Vercel)
  src/pages/      Chat, Settings, Skills, Notes, Connections, Instructions
  src/lib/        api, chat, conversations, skills, notes, compute, upload
  tests/          node --test (29 tests)
server/
  index.js        Express app, port 4000
  routes/         chat, compute, connections, mcp, upload, native, account, training
  adapters/       claude, openai, gemini, groq, ollama, nexus, higgsfield, elevenlabs
  lib/            sandbox, agentLoop, agentTools, computeManager, ollamaTunnel,
                  chatJobs, fitContext, connectorTools, skillTools, vault, mcp*,
                  webSearch, redact, attachments
  tests/          node --test (81 tests)
shared/models.js  model registry used by both sides
supabase/schema.sql
scripts/deploy_hostinger_server.py
```

---

## Deploying

```bash
cd scripts && python deploy_hostinger_server.py
```

It SSHes to the VPS, does `git fetch origin main && git reset --hard
origin/main`, `npm ci`, restarts PM2, and **asserts the deployed commit equals
local HEAD**, printing `Deployed commit: <sha>`.

* **Push before deploying** — it deploys what is on GitHub, not your working tree.
* If the printed sha is not your HEAD, the deploy did nothing. (It used to
  ignore exit codes and report success while shipping nothing; it now fails loudly.)
* **Never `sftp` files into `/root/nerxux`** — `reset --hard` discards them.
* The client deploys itself via Vercel on push to `main`. Client-only changes
  need no server restart.
* **A deploy restarts the server, which kills the GPU tunnel and any in-flight
  chat job.** Do not deploy while the user is mid-task.

---

## Compute: "Always On" vs "Turbo"

Both serve the same model, `orcarouter/Qwen3.8-27B-Uncensored:latest` (17.7 GB, Q4_K_M).

**Always On** — Ollama on the VPS itself, CPU only, `http://127.0.0.1:11434`.
Measured: reads prompts at **23 tok/s**, generates at **4.9 tok/s**.

**Turbo** — a RunPod GPU pod (NVIDIA A40, 48 GB). Measured: reads at
**1,138 tok/s**, generates at **19.8 tok/s**.

> Reading is **49× faster** on the GPU, and that — not generation speed — is
> what makes Always On unusable for agent work: every step re-reads the whole
> conversation. One build step ≈ 16 min on CPU vs ≈ 2 min on GPU.

### How Turbo works

The **VPS** opens the SSH tunnel — *not* the user's PC, which can be switched
off with no effect:

```
ssh -N -L 127.0.0.1:11435:127.0.0.1:11434 root@<pod-ip> -p <pod-port>
```

`server/lib/computeManager.js` + `ollamaTunnel.js`:

* The pod id is **discovered**, not hard-coded: it tries the known id, and
  otherwise lists the account's pods (`GET https://rest.runpod.io/v1/pods`) and
  picks the running one, else the newest. Persisted to
  `server/.compute-state.json`. **Never ask the user for a pod id.**
* A pod with an empty `/workspace` **provisions itself**: it installs Ollama to
  `/workspace/nerxux-ollama` and pulls the model (~17 GB), logging to
  `/workspace/nexus-provision.log`, then connects automatically.
* A dead tunnel is rebuilt before a request, and again mid-turn if it drops.
* Pod-local volumes do **not** survive terminating a pod. Stopping keeps them.

---

## The agent sandbox

`server/lib/sandbox.js` — bubblewrap (`bwrap`), OS-level isolation.

* Per-conversation directory: `/tmp/nexus_sandbox/<conversationId>/work`,
  mounted at **`/workspace`**. It persists across restarts.
* Harness files live **outside** the workspace, mounted read-only at `/nexus`
  (the script being executed, the git hook template). Do not put them back in
  `/workspace` — the model treats them as project files and investigates them.
* `projectPath` bind-mounts a real host folder at `/workspace/project` **and**
  at its own host path, so absolute paths work in shell commands. It is sticky
  per conversation. Junk values fall back to the sandbox root.
* Network: `profile: 'none'` is airgapped, `'full'` has internet (auto-escalated
  when the command contains curl/wget/git clone/push).
* Git auth is injected as `GIT_CONFIG_*` env covering https **and** SSH-style
  remotes. Secrets are scrubbed from `.git/config` and from all tool output
  (`lib/redact.js`) — tool output is stored in the DB and shown in chat.

---

## Context and tool budget (read before changing prompts)

The local model's window is **65,536** tokens on Turbo, **16,384** on Always On
(`num_ctx`, set in `adapters/ollama.js`).

* `lib/fitContext.js` trims the request to fit, **re-fitted every round** of a
  turn — a long agent turn keeps appending tool output, so what fits at step 1
  need not fit at step 40. It keeps the system prompt and the most recent turns.
* `lib/connectorTools.js` selects connector tools **per message**. Higgsfield
  alone exposes 101 tools ≈ 41,000 tokens — more than the whole window. Injecting
  them all evicted the conversation and the model answered about whatever tool
  was in front of it. The rest stay reachable via `find_connector_tools`.
* `lib/skillTools.js` puts only a **one-line index** of skills in the prompt;
  the body is fetched on demand with `load_skill`. Pasting all skills in full
  was ~3.9 M characters.
* Agent tools (sandbox/file/git) are attached **per turn** by `lib/needsTools.js`
  — only when the message actually asks for work. Web search is deliberately
  independent of this.

---

## Data (Supabase)

Tables: `conversations`, `conversation_messages`, `skills`, `notes`,
`connections` (encrypted API keys), `mcp_connectors`, `instructions`.

* RLS scopes everything to the signed-in user. The server uses the service-role
  key and must filter by `user_id` itself.
* API keys are encrypted AES-256-GCM with `VAULT_ENCRYPTION_KEY` (`lib/vault.js`).
* **Notes** with `in_context = true` and **skills** are injected into the system
  prompt, which trimming never drops — that is the only durable memory.

---

## Environment (`/root/nerxux/server/.env`, values not listed)

```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAULT_ENCRYPTION_KEY,
RUNPOD_API_KEY, RUNPOD_POD_ID, HOSTINGER_OLLAMA_URL,
BRAVE_SEARCH_API_KEY, CLIENT_ORIGINS, PORT
```

Client (Vercel env): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL`.

`scripts/.env.deploy` (gitignored) holds the deploy SSH details.

---

## Access you must be given

This document deliberately contains no secrets. To work on the system you need:

1. **SSH to the VPS** — key at `/root/.ssh/id_ed25519` on the VPS; the same
   public key is registered in the RunPod account, so new pods accept it.
2. **GitHub** — a fine-grained token scoped to the repos being changed.
3. **Supabase** — project URL, service-role key (server) / anon key (client).
4. **RunPod API key** — already in `server/.env`.
5. **Vercel** — only needed to change client env vars or force a redeploy.

Prefer adding provider keys through the app's **Connections** page (encrypted
vault) rather than pasting them into chat — chat messages are stored in
Supabase in plain text.

---

## The other project on this VPS: `viewe-account`

Not part of Nexus AI, but it lives on the same box and the agent works on it.

* `/root/viewe-account` — FastAPI backend (`app/`), Go engine (`engine/`),
  React frontend (`frontend/`), branch `feature/dev`.
* **It is LIVE**: `viewe-dashboard` serves it on port 8000. Editing `app/`
  changes production. Never restart it without being asked.
* The Go engine **cannot be built here** — no `go`, no Docker. Read/edit only.
* Redis and Celery are not running, so queue paths cannot be exercised.
* `.env`, `data/accounts/*.json`, `proxies.txt`, `data/proxies.json` hold live
  credentials. Never commit or print them.
* Verify a backend change with `venv/bin/python -c "import app.main"`.

There is a `viewe-account` **skill** in the app carrying all of the above, so
the agent loads it automatically.

---

## Gotchas that cost real time

* Chat must stay an **async job** — Vercel kills requests at ~120 s.
* `num_predict` too low truncates a tool call into an unparseable fragment.
* Ollama returns `{error: {...}}` as an **object**; `new Error(obj)` becomes
  `[object Object]`. Always normalise error text.
* Gemini 3 rejects tool results sent with role `function` — they must be a
  `user` turn, and the model's own parts (with `thoughtSignature`) must be
  echoed back verbatim.
* Gemini free tier is **5–20 requests per day** per model. Unusable for agent work.
* Higgsfield `generate_image` only **queues** a job; the result needs
  `job_status` with `sync: true`. Without it the model announces an image that
  does not exist.
* Editing a chat message **forks a new conversation**, unless everything after
  it is an error (then it retries in place).
* The client sends the whole conversation each message; the server trims it.
* Tests: `cd server && node --test tests/*.test.mjs` (81) and
  `cd client && node --test tests/*.test.mjs` (29). Run both before deploying.

---

## Health check

```bash
curl -s http://127.0.0.1:4000/api/health              # API
curl -s http://127.0.0.1:11434/api/tags               # Always On model
curl -s http://127.0.0.1:11435/api/tags               # Turbo tunnel
pm2 list                                              # processes
cat /root/nerxux/server/.compute-state.json           # selected mode + pod
```

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

### Agent evidence and project checkpoints

The web client includes a bounded excerpt of saved tool steps in the next
model request. The server keeps redacted command output in per-conversation
evidence files under `NEXUS_AGENT_STATE_DIR` (default:
`~/.local/state/nexus-agent`). The agent can call `inspect_execution` with a
`query`, or with `evidenceId` plus `start` and `limit`, to recover exact output
that no longer fits in chat context. A project outcome from another chat also
requires its indexed `sessionId`. Back up this state directory with VPS app
data; deleting it loses the evidence archive.

Successful commands and passing `verify_work` checks are saved per user and
project path. Project checkpoints are historical evidence, not proof that the
current files still match. Every potentially mutating Nexus tool advances the
project generation, including changes made from another chat; later responses
mark an older check stale until the current revision is verified again.

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

## Compute: "Always On" vs "Turbo" vs "Kaggle"

**Kaggle (added 2026-09-16)** is a third mode: a Kaggle notebook's 2x T4 GPU (free,
~30 GPU-hrs/week), reached over a **reverse** SSH tunnel — the notebook opens it INTO
this VPS (backwards from Turbo, where the VPS opens the tunnel out to RunPod), because
Kaggle has no public address of its own.

- **VPS side:** `/root/.ssh/authorized_keys` has one extra, tightly restricted entry:
  `restrict,port-forwarding,permitopen="127.0.0.1:1",permitlisten="127.0.0.1:20140",command="echo tunnel-only key; exit 1" ssh-ed25519 ... kaggle-tunnel-nexus`.
  Verified live (2026-09-16): the key cannot open a shell, cannot forward any other
  port, cannot local-forward anywhere — it can ONLY reverse-forward to
  `127.0.0.1:20140`. (`permitopen="none"` is rejected by OpenSSH 9.6 as invalid — use
  a dead port like `127.0.0.1:1` instead, or the key fails to authenticate at all.)
  The private key itself is not in this repo or on the VPS filesystem — only the
  user has it, to paste into a Kaggle Secret.
- **Nexus side:** `computeManager.js` exports `KAGGLE_URL` (`http://127.0.0.1:20140`),
  `switchToKaggle()`, `kaggleReachable()` (a `/health` probe, no SSH involved — the
  tunnel already did that work), `ensureKaggleReady()` (same pre-flight-then-fallback
  pattern as `ensureTurboReady`: not reachable -> falls back to Always On, never
  strands a turn), and `getKaggleUsage()` (a rolling 7-day connected-seconds counter,
  purely advisory — Kaggle enforces the real 30h/week cap on its own side).
  `adapters/ollama.js`: Kaggle always talks the OpenAI protocol via
  `lib/llamaServerChat.js` (same translation Always On's llama-server uses), gets
  Turbo's generous budget (`generousBudget = isRunpod || isKaggle` — GPU reads fast
  and reuses the prompt cache) but keeps its real model name (`modelForTarget(model,
  isRunpod, isKaggle)` — no Always-On-model swap). `client/components/ComputeBar.jsx`
  has a third button; picking it is safe even if the notebook is off (falls back
  per-turn with a notice, same UX as a dead Turbo pod).
- **The notebook:** `kaggle-nexus-turbo.ipynb` (given to the user, not in this repo —
  it embeds no secret itself, it reads one from a Kaggle Secret named
  `NEXUS_TUNNEL_KEY`). Builds llama.cpp with CUDA at the same pinned commit used for
  Always On (`4df29be4`), runs `Swift-Qwen3.8-27B-Uncensored-Dynamic-MTP-UD-Q4_K_XL.gguf`
  (self-speculative MTP, single file) on both T4s, then opens the reverse tunnel and
  idles printing a heartbeat until stopped or the session/quota ends.
- **Not verified (couldn't be, from here):** that Kaggle's sandbox actually permits
  outbound SSH (port 22) from a notebook. Everything else in this mode was tested
  against the real VPS; this one assumption only gets checked when the user runs it.
- **To change the port:** update `KAGGLE_URL` in `server/.env`, the notebook's
  `REMOTE_PORT`, AND the `permitlisten` value in authorized_keys — all three must
  agree or the tunnel is refused.

## Compute: "Always On" vs "Turbo"

**Turbo** serves `orcarouter/Qwen3.8-27B-Uncensored:latest` (17.7 GB, Q4_K_M).

**Always On (since 2026-09-16)** is **llama-server**, not Ollama: systemd unit
`llama-server`, `127.0.0.1:8080`, CPU build of llama.cpp `4df29be4` + the HauhauCS FastMTP
patch in `/opt/llama/llama.cpp`, model `Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf`
with the `FastMTP-32K` draft (spec-type draft-mtp, n-max 3), context 32768, reasoning xhigh.
`server/.env`: `HOSTINGER_OLLAMA_URL=http://127.0.0.1:8080`, `ALWAYS_ON_API=openai`,
`OLLAMA_JOURNAL_UNIT=llama-server` (live read progress parses its log). The adapter
translates Ollama `/api/chat` <-> OpenAI `/v1/chat/completions` in `lib/llamaServerChat.js`;
Turbo still speaks Ollama. The VPS `ollama` service is stopped and disabled (RAM).
First measured request (316-token prompt, cold): reads **7 tok/s**, writes **3.7 tok/s**
(FastMTP accepted 51/87 drafts) — slower than the MoE model below; read-time estimates
learn from real timings. To go back: `systemctl disable --now llama-server`, reinstall/pull
the Ollama model, `systemctl enable --now ollama`, unset `ALWAYS_ON_API`, URL back to :11434.

Before that, **Always On** served `huihui_ai/Qwen3.6-abliterated:35b-a3b` (23 GB, mixture-of-experts,
~3B active) since 2026-09-15 — the chat picker entry is the same; the adapter swaps the
27B's names for `ALWAYS_ON_MODEL` when the target is Always On (`modelForTarget` in
`adapters/ollama.js`; set `ALWAYS_ON_MODEL` in `server/.env` to change it). Measured on the
VPS: reads 64 tok/s cold / 218 warm (27B: ~15), writes 15.4 tok/s (27B: 4.9), and no
"forcing full prompt re-processing" warning. Only one of the two fits in the VPS RAM at a
time (31 GB); the 27B is still on disk. Read-time estimates learn per model from Ollama's
`prompt_eval_count`/`prompt_eval_duration`.

Measured on a real 22k-token chat (2026-09-15): this model ALSO logs "forcing full prompt
re-processing", so each step re-read the whole chat (~12 min). Since then Always On sends at
most `ALWAYS_ON_PROMPT_TOKENS` (14k, older turns trimmed; rules, NEXUS.md and the execution
record always kept), the turn limit is 60 min like Turbo, and a step is only started when
reading + `ALWAYS_ON_ANSWER_S` (180 s) fits in the time left.

The numbers below are the 27B's.

**Always On** — Ollama on the VPS itself, CPU only, `http://127.0.0.1:11434`.
Measured: reads prompts at **23 tok/s**, generates at **4.9 tok/s**.

**Turbo** — a RunPod GPU pod (NVIDIA A40, 48 GB). Measured: reads at
**1,138 tok/s**, generates at **19.8 tok/s**.

> Reading is **49× faster** on the GPU, and that — not generation speed — is
> what makes Always On unusable for agent work: every step re-reads the whole
> conversation. One build step ≈ 16 min on CPU vs ≈ 2 min on GPU.

> **Measured 2026-09-15 (Ollama journal):** this model cannot reuse the prompt
> cache between requests ("forcing full prompt re-processing … hybrid/recurrent
> memory"), and CPU reading slows as the prompt grows: 4k tokens in 282 s, 21k
> tokens in ~56 min. One agent step on a 22k-token chat took **63 minutes**.
> `estimateReadSeconds()` in `adapters/ollama.js` is fitted to these numbers.
> Since then: a step that can't be read in the turn's remaining budget is not
> sent (the reply says so and suggests Turbo); every model request carries the
> turn deadline; the end-of-turn summary is skipped when it would take >8 min to
> read; and `chatJobs.js` ends any job after 80 min (`MAX_RUNTIME_MS`) so the
> chat can never show "Thinking…" forever. Job start/finish lines are in
> `pm2 logs nexus-server` (`[nexus-ai] chat job`).

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

## Added 2026-09-16: OmniRoute, Graphify, agent-skills, Ponytail

**OmniRoute** (github.com/diegosouzapw/OmniRoute, npm `omniroute` 3.8.50) is an AI gateway on the
VPS: systemd `omniroute`, `127.0.0.1:20128` only, `REQUIRE_API_KEY=true`, working dir and data
`/var/lib/omniroute`, settings `/etc/omniroute/omniroute.env` (600: dashboard `INITIAL_PASSWORD`,
JWT/API-key/storage secrets — never commit). Nexus provider `omniroute` (`adapters/omniroute.js`,
shares the OpenAI-compatible loop in `adapters/groq.js`); platform key `OMNIROUTE_API_KEY` +
`OMNIROUTE_URL` in `server/.env`. The picker shows its `auto/*` routing profiles only. Out of the box
`auto` answers via OpenCode's free model; add provider keys/OAuth in its dashboard for more
(reach it with `ssh -L 20128:127.0.0.1:20128 root@2.25.126.125`, then http://localhost:20128).
It runs separately from `/root/.env` — that file is a stray copy of Nexus secrets and should be removed.

**Graphify** (Graphify-Labs/graphify, pip `graphifyy`) is installed in `/usr/local/lib/graphify-venv`
with `/usr/local/bin/graphify`, so the agent can run it inside bwrap (offline, code only):
`graphify update . --no-cluster`, `graphify query "…"`, `explain`, `affected`, `path`, `god-nodes`.
Output `graphify-out/` must stay gitignored.

**Skills** (Supabase `skills`, user ff9d0de8): all 25 addyosmani/agent-skills, 4 Ponytail skills
(ponytail, -review, -audit, -debt; -gain/-help skipped as plugin-only) and a compact `graphify` usage
skill. 50 enabled skills ≈ 3k tokens of index on every message; bodies are 1–28k chars and are loaded
on demand with `load_skill` — expensive on Always On (7 tok/s read), cheap on Turbo.

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

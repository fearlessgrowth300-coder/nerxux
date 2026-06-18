# Nexus AI

A multi-model AI hub: chat across **Claude / GPT-4o / Gemini**, chain models in a
**pipeline** (analyst → executor), analyze **video with vision**, route requests
with an **intent router**, manage **skills + global instructions**, and store
provider API keys in an **encrypted vault**.

**Stack:** React + Vite + Tailwind (client) · Node.js + Express (server) · Supabase (auth + database)

---

## Features

| Area | What it does |
| --- | --- |
| **Auth** | Supabase email/password, protected routes, session context |
| **Instructions** | Global system prompt, saved per user, prepended to every request |
| **Skills** | CRUD prompt modules with enable/disable; enabled skills appended to the system prompt |
| **Connections** | Encrypted API vault (Anthropic / OpenAI / Gemini / ElevenLabs / Higgsfield) — keys never returned to the browser |
| **Chat** | Markdown + syntax-highlighted code, per-message model badge, typing indicator, history |
| **Dual models** | Model A / Model B selectors + pipeline mode |
| **Video** | Upload `.mp4/.mov/.webm` → Gemini 1.5 Pro vision → structured analysis injected into the next model |
| **Intent router** | Lightweight Claude call routes each message to the right tool(s); asks you to connect missing tools |
| **Adapters** | Normalized adapters for all five providers (text / vision / audio / video) |

---

## Project structure

```
nexus-ai/
├── client/    # React + Vite + Tailwind frontend (deploy to Vercel)
│   ├── src/
│   ├── vercel.json        # SPA rewrites + asset caching
│   └── .env.example
├── server/    # Node.js + Express backend (adapters, vault, vision, router)
│   ├── adapters/          # claude / openai / gemini / elevenlabs / higgsfield
│   ├── lib/               # supabase, auth, crypto, vault, gemini, router
│   ├── routes/            # connections, chat, upload
│   └── .env.example
├── shared/    # Shared model/provider registry (used by client + server)
├── supabase/  # schema.sql — run once in the Supabase SQL editor
└── package.json  # convenience scripts
```

---

## Prerequisites

- Node.js 18+ (developed on Node 24)
- A Supabase project (free tier is fine)

## Quick start (local)

```bash
# from the repo root
npm run install:all          # installs client + server deps

# 1) create the database tables — paste supabase/schema.sql into
#    Supabase Dashboard → SQL Editor → Run

# 2) fill in env files (see below), then in two terminals:
npm run dev:server           # http://localhost:4000
npm run dev:client           # http://localhost:5173
```

The Vite dev server proxies `/api/*` to the Express server on port 4000, so no
CORS setup is needed in development.

---

## Environment variables

Copy each `.env.example` to `.env` and fill in values.

**client/.env**
| Var | Notes |
| --- | --- |
| `VITE_SUPABASE_URL` | Public Supabase URL |
| `VITE_SUPABASE_ANON_KEY` | Public anon key (RLS-protected) |
| `VITE_API_BASE_URL` | Leave blank in dev (uses the Vite proxy); in prod set to the deployed API origin, e.g. `https://api.yourdomain.com` |

**server/.env**
| Var | Notes |
| --- | --- |
| `PORT` | API port (default 4000) |
| `CLIENT_ORIGINS` | Comma-separated allowed origins for CORS. Supports `*` wildcards, e.g. `https://nexus.yourdomain.com,https://*.vercel.app` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase access (service role — never expose) |
| `VAULT_ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM encryption of user API keys. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ANTHROPIC_API_KEY` etc. | Optional platform fallbacks; per-user vault keys take priority |

> ⚠️ Provider API keys are **never** stored in the client. Users add them in the
> Connections vault; they're encrypted at rest server-side and never returned.

---

## Deployment

Nexus AI is two deployables: a **static frontend** and a **Node API server**.

### 1. Frontend → Vercel

1. Push this repo to GitHub.
2. In Vercel, **New Project → import the repo**.
3. Set **Root Directory** to `client/`. Vercel auto-detects Vite and uses the
   included `client/vercel.json` (SPA rewrites so React Router works on refresh).
4. Add environment variables (Project → Settings → Environment Variables):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_API_BASE_URL` → your deployed API origin (step 2)
5. Deploy. You'll get a `*.vercel.app` URL.

### 2. Backend → Render / Railway / Fly (any Node host)

The server is a standard Express app (`npm start`). Deploy `server/` to any Node
host:

- **Root directory:** `server/`
- **Build:** `npm install`
- **Start:** `npm start`
- **Env vars:** everything from `server/.env` (see table above). Set
  `CLIENT_ORIGINS` to your Vercel URL **and** custom domain, e.g.
  `https://nexus-ai.vercel.app,https://nexus.yourdomain.com`.

Then point the frontend's `VITE_API_BASE_URL` at this server's URL and redeploy
the frontend.

---

## Connecting a custom domain (Vercel)

1. **Buy/own a domain** (Namecheap, Cloudflare, Google Domains, etc.).
2. In Vercel: **Project → Settings → Domains → Add** → enter your domain
   (e.g. `nexus.yourdomain.com` or the apex `yourdomain.com`).
3. Vercel shows the DNS record to add at your registrar:
   - **Subdomain** (`nexus.yourdomain.com`): add a **CNAME** → `cname.vercel-dns.com`
   - **Apex** (`yourdomain.com`): add an **A** record → `76.76.21.21` (or follow
     Vercel's shown value), or use your registrar's ALIAS/ANAME to the CNAME target.
4. Wait for DNS to propagate (minutes to a few hours). Vercel auto-issues a free
   SSL certificate.
5. **Update CORS:** add the custom domain to the server's `CLIENT_ORIGINS` and
   redeploy the API. (Wildcards like `https://*.yourdomain.com` are supported.)
6. If your API is also on a custom subdomain (e.g. `api.yourdomain.com`), set the
   frontend's `VITE_API_BASE_URL` to it and redeploy the frontend.

That's it — your hub is live on your own domain with HTTPS.

---

## Security notes

- Rotate the Supabase **database password** and **service role key** if they were
  ever shared during development (Dashboard → Settings → Database / API).
- `VAULT_ENCRYPTION_KEY` must stay secret and stable — changing it makes existing
  stored keys undecryptable (users would re-enter them).
- Enable Supabase **email confirmation** in production (Authentication → Providers).

---

## Build status

Built step-by-step, all 12 steps complete ✅ — setup, auth, dashboard,
instructions, skills, vault, chat, dual models, video vision, intent router,
adapters, and custom-domain readiness.

-- ============================================================================
-- Nexus AI — database schema
-- Run this in the Supabase Dashboard → SQL Editor (paste & Run).
-- Safe to re-run: every statement is idempotent.
-- Row Level Security ensures each user can only touch their own rows.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Step 4 — Global instructions (one row per user)
-- ---------------------------------------------------------------------------
create table if not exists public.user_instructions (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  content    text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.user_instructions enable row level security;

drop policy if exists "instructions_owner_all" on public.user_instructions;
create policy "instructions_owner_all"
  on public.user_instructions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Step 5 — Skills (many per user). Enabled skills are appended to the prompt.
-- ---------------------------------------------------------------------------
create table if not exists public.skills (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  description text not null default '',
  content     text not null default '',
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists skills_user_id_idx on public.skills (user_id);

alter table public.skills enable row level security;

drop policy if exists "skills_owner_all" on public.skills;
create policy "skills_owner_all"
  on public.skills
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Step 6 — Connections / API vault (one row per user+provider).
-- Keys are stored ENCRYPTED (AES-256-GCM) by the server. The plaintext key is
-- never stored and never returned to the client. RLS is enabled defensively;
-- the server accesses this table with the service role (which bypasses RLS),
-- so the anon/client key can never read ciphertext directly.
-- ---------------------------------------------------------------------------
create table if not exists public.connections (
  user_id        uuid not null references auth.users (id) on delete cascade,
  provider       text not null,
  key_ciphertext text not null,
  key_iv         text not null,
  key_tag        text not null,
  last4          text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.connections enable row level security;

-- No client policies on purpose: only the service role (server) may touch this
-- table. Without a policy, RLS denies all anon/authenticated access by default.
drop policy if exists "connections_owner_all" on public.connections;

-- ---------------------------------------------------------------------------
-- MCP connectors — custom Model Context Protocol servers per user.
-- The optional OAuth secret is stored encrypted (AES-256-GCM); discovered
-- tools are cached as JSON. Server-only access (service role), like connections.
-- ---------------------------------------------------------------------------
create table if not exists public.mcp_connectors (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  name               text not null,
  url                text not null,
  oauth_client_id    text,
  secret_ciphertext  text,
  secret_iv          text,
  secret_tag         text,
  tools              jsonb not null default '[]'::jsonb,
  enabled            boolean not null default true,
  last_status        text not null default 'unknown',
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists mcp_connectors_user_id_idx on public.mcp_connectors (user_id);

alter table public.mcp_connectors enable row level security;

-- Server-only (service role bypasses RLS); no client policy on purpose.
drop policy if exists "mcp_connectors_owner_all" on public.mcp_connectors;

-- OAuth state for MCP connectors that require browser login (e.g. Higgsfield,
-- Notion). Tokens are stored encrypted; client info (DCR) + PKCE verifier +
-- CSRF state are transient working values used during the auth handshake.
alter table public.mcp_connectors
  add column if not exists oauth_client jsonb,
  add column if not exists oauth_verifier text,
  add column if not exists oauth_state text,
  add column if not exists oauth_tokens_ciphertext text,
  add column if not exists oauth_tokens_iv text,
  add column if not exists oauth_tokens_tag text,
  add column if not exists tool_perms jsonb not null default '{}'::jsonb,
  add column if not exists oauth_redirect text;

-- ---------------------------------------------------------------------------
-- Native connectors — first-party service integrations (e.g. YouTube) that use
-- the provider's own OAuth + REST API rather than MCP. One row per user+provider.
-- App client_id + secret (provider OAuth app) and tokens are stored encrypted.
-- ---------------------------------------------------------------------------
create table if not exists public.native_connections (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  provider           text not null,
  client_id          text,
  secret_ciphertext  text,
  secret_iv          text,
  secret_tag         text,
  tokens_ciphertext  text,
  tokens_iv          text,
  tokens_tag         text,
  oauth_state        text,
  oauth_redirect     text,
  status             text not null default 'disconnected',
  meta               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists native_connections_user_idx on public.native_connections (user_id);
alter table public.native_connections enable row level security;
-- Server-only (service role); no client policy on purpose.
drop policy if exists "native_connections_owner_all" on public.native_connections;

-- ---------------------------------------------------------------------------
-- Second brain — persistent conversation history (per user). Replaces the old
-- browser-localStorage chat so chats survive across devices/sessions and can be
-- reopened and resumed where you left off.
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_user_idx on public.conversations (user_id, updated_at desc);
alter table public.conversations enable row level security;
drop policy if exists "conversations_owner_all" on public.conversations;
create policy "conversations_owner_all"
  on public.conversations
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.conversation_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            text not null,
  content         text not null default '',
  model           text,
  data            jsonb,                 -- full message object (attachments, media, routing…)
  created_at      timestamptz not null default now()
);
create index if not exists conversation_messages_idx on public.conversation_messages (conversation_id, created_at);
alter table public.conversation_messages enable row level security;
drop policy if exists "conversation_messages_owner_all" on public.conversation_messages;
create policy "conversation_messages_owner_all"
  on public.conversation_messages
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Notes — an Obsidian-style knowledge base (markdown + [[backlinks]]). Notes
-- flagged in_context are fed to the model as knowledge in every chat.
-- ---------------------------------------------------------------------------
create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null default 'Untitled',
  content    text not null default '',
  in_context boolean not null default false,  -- feed this note to the AI?
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notes_user_idx on public.notes (user_id, updated_at desc);
alter table public.notes enable row level security;
drop policy if exists "notes_owner_all" on public.notes;
create policy "notes_owner_all"
  on public.notes
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

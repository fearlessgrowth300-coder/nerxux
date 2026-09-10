import { executeInSandbox } from './sandbox.js'
import { runOnPod } from './pod.js'
import { getProviderKey } from './vault.js'
import { runWebSearchTool } from './webSearch.js'
import { AGENT_TOOL_DEFS, toOpenAITools, fileToolCommand } from './agentTools.js'

// How to work — shared by every model that gets the agent tools (Claude,
// GPT-4o, Gemini, Groq, the local models).
export const AGENT_GUIDANCE = `
You are Nexus AI with direct execution capabilities ("hands").
You have access to:
1. An isolated OS-level Linux sandbox (Python, Node, TypeScript, C++, Bash, Git; a persistent /workspace for this chat).
2. Direct terminal execution on the remote RunPod GPU pod (via SSH).

When the user asks you to write, test, run, clone, build, inspect, or execute code or terminal commands, DO NOT just describe what to do. ACTUALLY EXECUTE IT by calling a tool.

How to work (this is how good engineers use these tools):
- Look before you act: list_files / read_file the relevant parts of the project before changing it.
- Write files with write_file (whole file) or edit_file (small change) — NEVER via shell heredocs or echo.
- Work in small verified steps: write a file, then build/run/test, read the error, fix it, continue.
- After a batch of changes, prove it: run the build or tests and read the output. "Done" means it runs.
- Keep a short plan in your head and finish every item on it.

WORK AUTONOMOUSLY. When given a task, carry it all the way to completion in this
turn: plan briefly, then execute step after step until it is actually done and
verified (files written, build/tests run, pushed if asked). Do NOT stop to ask
"should I continue?", "do you want me to build it?", "shall I proceed?" — the
answer is always yes. Do NOT end your turn with a plan or a list of next steps
you haven't executed. Only pause to ask when something genuinely blocks you that
you cannot obtain yourself (e.g. a credential the user never provided) — and
first try to work around it.

Tool-call size: keep every single tool call small — write 1–2 files per call
and keep each call under ~150 lines. A very long call gets truncated and is
LOST, so many small calls always beat one giant one. Long-running commands
(npm install, builds) are fine on their own; don't combine them with file
writes.

Paths: every tool call starts in /workspace (persistent for this chat, but
thrown away when the chat ends). If the user gives you an absolute path on
their own machine to an EXISTING project (this only works when Nexus itself
is running on their machine, not the hosted version) — set it once via
projectPath on any tool call, and it stays in effect for every later call
in this chat automatically; you don't need to repeat it. It replaces
/workspace as the project root: relative paths resolve there, execute_command
and run_code start there. When a projectPath is set, work on the files that
are already there — don't clone or re-scaffold, look at what exists first.

Without a projectPath, if the project lives in a subfolder (e.g.
/workspace/repo after a git clone), use absolute paths or "cd /workspace/repo
&& ..." in EVERY command — files written to /workspace/app instead of
/workspace/repo/app are in the wrong place. Pass code as plain source text in
the "code" field, never as a JSON object. After writing files, verify with
ls / cat before moving on, and never repeat a step you have already completed.

Available Tools:
- write_file(path, content) / edit_file(path, old, new) / read_file(path) / list_files(path) / search_files(pattern, path)
- execute_command(command, target, profile, projectPath): Runs a shell/git command. target can be "sandbox" (default) or "pod".
- run_code(language, code, profile, projectPath): Runs a code snippet in the sandbox.
- run_on_pod(command): Runs a shell command directly on the RunPod GPU pod.
- web_search(query): Searches the live web and returns real results (only offered when the user has web search turned on).

Git works in the sandbox (clone, commit, branch, diff all work with no setup).
git push/pull against a PRIVATE repo is authenticated automatically when the
user has pasted a GitHub token (ghp_... / github_pat_...) anywhere in this chat,
or connected one under Connections — this works transparently on EVERY git
command, so never embed the token yourself: don't put it in a clone URL, don't
run "git remote set-url" with it, don't write it to .netrc or any file. If a plain
"https://github.com/..." URL fails to authenticate, that means no token is
available — ask the user for one, don't work around it by embedding it.

Credentials the user pastes in the chat (Supabase URL/keys, API keys, DB
URLs) are meant to be used: put them in the project's .env / config files
exactly as given, and use them. Never ask the user to re-send something
that's already in the conversation.

`.trim()

// Extra note for the local Ollama models only: some of them can't do native
// function calling and fall back to emitting a JSON block in their text.
export const OLLAMA_FORMAT_NOTE = `
Format:
If your runtime supports function calling, use the function calling schema.
Otherwise, you can output an execution block:
{"tool": "execute_command", "command": "git clone https://github.com/user/repo", "target": "sandbox"}
or
{"tool": "write_file", "path": "repo/app/page.tsx", "content": "..."}
or
run: git clone https://github.com/user/repo

Once executed, you will receive the actual output, exit code, and files, and you can inspect results and decide the next step.
`.trim()

export const AGENT_SYSTEM_PROMPT = AGENT_GUIDANCE + '\n\n' + OLLAMA_FORMAT_NOTE

// Ollama / OpenAI compatible tool definitions (derived from the shared defs).
export const AGENT_TOOLS = toOpenAITools(AGENT_TOOL_DEFS)

// Only added to the request's tool list when the user's Web toggle is on
// (see ollama.js) — kept separate from AGENT_TOOLS so it's never offered
// when search is off.
export const WEB_SEARCH_AGENT_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the live web for current information and return real results (title, URL, snippet).',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query'],
    },
  },
}

// The model sometimes hands us its whole tool-call object as the `code` /
// `command` string ('{"language":"python","code":"..."}'). Run literally,
// that's a Python dict expression: exit 0, no output, nothing written — and
// the agent then loops forever believing it wrote the files. Unwrap it.
export function normalizeToolArgs(name, args = {}) {
  const out = { ...args }
  for (const key of ['code', 'command']) {
    const v = out[key]
    if (typeof v !== 'string' || !/^\s*\{/.test(v)) continue
    let inner = null
    // Models also emit the object with real newlines inside the strings,
    // which strict JSON rejects — retry with them escaped.
    for (const candidate of [v, v.replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t')]) {
      try { inner = JSON.parse(candidate); break } catch {}
    }
    if (inner && typeof inner === 'object' && (typeof inner.code === 'string' || typeof inner.command === 'string')) {
      Object.assign(out, inner, { [key]: inner[key] ?? inner.code ?? inner.command })
    }
  }
  return out
}

// A GitHub token the user pasted straight into the chat. If they gave it to
// the model, they meant for it to be used — no separate vault step needed.
// Prefers the most recent one; fine-grained (github_pat_) or classic (ghp_…).
export function harvestGithubToken(text = '') {
  const matches = String(text).match(/\b(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})\b/g)
  return matches ? matches[matches.length - 1] : null
}

// Once a chat mounts a local project folder, every later call in that same
// chat should keep using it without the model re-stating the path on every
// single tool call (it will forget, especially deep into a long build).
// Session-scoped, not global — a different chat working on a different
// folder is unaffected. Cleared by giving `projectPath: null`/`""` explicitly.
const lastProjectPath = new Map() // sessionId -> path
export const _lastProjectPathForTest = lastProjectPath // tests only

// Executes a single tool call against the local sandbox or Runpod pod.
// `chatText` = the conversation so far, scanned for pasted credentials.
export async function executeAgentTool({ name, args: rawArgs = {}, sessionId = 'default', projectPath = null, userId = null, chatText = '' }) {
  const args = normalizeToolArgs(name, rawArgs)
  const cleanSession = sessionId || 'default'
  // An explicit projectPath (even "" / null, to unmount) updates what this
  // chat remembers; omitting the field just reuses whatever was set before.
  if ('projectPath' in args) {
    if (args.projectPath) lastProjectPath.set(cleanSession, args.projectPath)
    else lastProjectPath.delete(cleanSession)
  }
  const targetProj = args.projectPath || projectPath || lastProjectPath.get(cleanSession) || null

  if (name === 'web_search') {
    // Reshaped to match the sandbox result shape ({stdout,...}) that the
    // caller (ollama.js) already knows how to turn into a tool observation.
    const start = Date.now()
    const { content } = await runWebSearchTool({ query: args.query })
    return { ok: true, stdout: content, stderr: '', exitCode: 0, durationMs: Date.now() - start, target: 'web_search' }
  }

  // File tools: a fixed bash recipe per tool, with all model-supplied text
  // delivered base64-encoded — the model never composes shell syntax. A
  // relative path resolves against /workspace/project when a local folder
  // is bind-mounted for this call, /workspace otherwise — matching where
  // execute_command/run_code actually start (see sandbox.js's targetDir).
  const fileCmd = fileToolCommand(name, args, {
    base: targetProj ? '/workspace/project' : '/workspace',
    hostRoot: targetProj,
  })
  if (fileCmd) {
    const r = await executeInSandbox({
      code: fileCmd, language: 'bash', sessionId: cleanSession, profile: 'none', projectPath: targetProj,
    })
    return { ...r, target: name }
  }

  if (name === 'run_code') {
    return executeInSandbox({
      code: args.code || '',
      language: args.language || 'python',
      sessionId: cleanSession,
      profile: args.profile || 'none',
      projectPath: targetProj,
      ...(await gitCreds(userId, chatText)),
    })
  }

  if (name === 'run_on_pod' || (name === 'execute_command' && args.target === 'pod')) {
    return runOnPod(args.command || '')
  }

  if (name === 'execute_command') {
    // Default to sandbox bash execution
    return executeInSandbox({
      code: args.command || '',
      language: 'bash',
      sessionId: cleanSession,
      profile: args.profile || 'full',
      projectPath: targetProj,
      ...(await gitCreds(userId, chatText)),
    })
  }

  throw new Error(`Unknown agent tool: "${name}"`)
}

// Looks up the user's own GitHub token (paste one under Connections — it's
// auto-detected by prefix, same vault as the model API keys) so `git clone`/
// `git push` in the sandbox can authenticate. No token connected -> git still
// works for anything that doesn't need auth (clone of a public repo, local
// commits), it just can't push/pull anything private.
async function gitCreds(userId, chatText = '') {
  // A token pasted in this conversation wins — it's the most explicit intent.
  const pasted = harvestGithubToken(chatText)
  if (pasted) return { gitToken: pasted }
  if (!userId) return {}
  try {
    const token = await getProviderKey(userId, 'github')
    return token ? { gitToken: token } : {}
  } catch {
    return {}
  }
}

// Parses freeform model text for JSON tool calls or "run: <command>" patterns
export function extractToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return []
  const calls = []

  // 1. Check for JSON blocks: {"tool": "...", ...}
  const jsonRegex = /\{[\s\r\n]*"tool"[\s\r\n]*:[\s\r\n]*"([^"]+)"[\s\S]*?\}/g
  let match
  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0])
      if (parsed.tool) {
        if (parsed.tool === 'run_code') {
          calls.push({
            name: 'run_code',
            args: {
              language: parsed.language || 'python',
              code: parsed.code || '',
              profile: parsed.profile || 'none',
              projectPath: parsed.projectPath,
            },
          })
        } else if (parsed.tool === 'execute_command' || parsed.tool === 'run_on_pod') {
          calls.push({
            name: parsed.tool === 'run_on_pod' ? 'run_on_pod' : 'execute_command',
            args: {
              command: parsed.command || parsed.code || '',
              target: parsed.target || (parsed.tool === 'run_on_pod' ? 'pod' : 'sandbox'),
              profile: parsed.profile || 'full',
              projectPath: parsed.projectPath,
            },
          })
        } else if (parsed.tool === 'web_search') {
          calls.push({ name: 'web_search', args: { query: parsed.query || parsed.q || '' } })
        } else if (['write_file', 'read_file', 'edit_file', 'list_files', 'search_files'].includes(parsed.tool)) {
          const { tool, ...rest } = parsed
          calls.push({ name: tool, args: rest })
        }
      }
    } catch {}
  }

  if (calls.length > 0) return calls

  // 2. Check for "run: <command>" or "run_on_pod: <command>"
  const runLines = text.split('\n')
  for (const line of runLines) {
    const trimmed = line.trim()
    const podMatch = /^run_on_pod:\s*(.+)$/i.exec(trimmed)
    if (podMatch) {
      calls.push({
        name: 'run_on_pod',
        args: { command: podMatch[1].trim() },
      })
      continue
    }
    const runMatch = /^run:\s*(.+)$/i.exec(trimmed)
    if (runMatch) {
      calls.push({
        name: 'execute_command',
        args: { command: runMatch[1].trim(), target: 'sandbox', profile: 'full' },
      })
    }
  }

  return calls
}

import { executeInSandbox } from './sandbox.js'
import { runOnPod } from './pod.js'
import { getProviderKey } from './vault.js'
import { runWebSearchTool } from './webSearch.js'

// System instructions that inform models how to use their execution "hands"
export const AGENT_SYSTEM_PROMPT = `
You are Nexus AI with direct execution capabilities ("hands").
You have access to:
1. An isolated OS-level Linux sandbox (with Python, JS, TS, C++, Bash, Git, and persistent /workspace).
2. Direct terminal execution on the remote Runpod GPU pod (via SSH).

When the user asks you to write, test, run, clone, build, inspect, or execute code or terminal commands, DO NOT just describe what to do. ACTUALLY EXECUTE IT by calling a tool or outputting a tool call block.

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

Paths: every tool call starts in /workspace (persistent for this chat). If
the project lives in a subfolder (e.g. /workspace/repo after a git clone),
use absolute paths or "cd /workspace/repo && ..." in EVERY command — files
written to /workspace/app instead of /workspace/repo/app are in the wrong
place. Pass code as plain source text in the "code" field, never as a JSON
object. After writing files, verify with ls / cat before moving on, and
never repeat a step you have already completed.

Available Tools:
- run_code(language, code, profile, projectPath): Runs code in the isolated local sandbox.
- execute_command(command, target, profile, projectPath): Runs a shell/git command. target can be "sandbox" (default) or "pod".
- run_on_pod(command): Runs a shell command directly on the Runpod GPU pod.
- web_search(query): Searches the live web and returns real results (only offered when the user has web search turned on).

Git works in the sandbox (clone, commit, branch, diff all work with no setup).
git push/pull against a PRIVATE repo needs the user's GitHub token connected
under Connections (paste a personal access token, ghp_... or github_pat_...).
If a push fails with an auth error, tell the user to connect GitHub there —
don't guess at credentials or invent a token.

Format:
If your runtime supports function calling, use the function calling schema.
Otherwise, you can output an execution block:
{"tool": "execute_command", "command": "git clone https://github.com/user/repo", "target": "sandbox"}
or
{"tool": "run_code", "language": "python", "code": "print('hello from sandbox')"}
or
run: git clone https://github.com/user/repo

Once executed, you will receive the actual output, exit code, and files, and you can inspect results and decide the next step.
`.trim()

// Ollama / OpenAI compatible tool definitions
export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_code',
      description: 'Execute code in the local OS-level isolated sandbox (supports python, javascript, typescript, c++, bash) with persistent /workspace.',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['python', 'javascript', 'typescript', 'c++', 'bash'],
            description: 'Programming language to execute',
          },
          code: {
            type: 'string',
            description: 'The complete code snippet to execute',
          },
          profile: {
            type: 'string',
            enum: ['none', 'full'],
            description: 'Network profile: "none" for airgapped, "full" for internet access (required for network/packages)',
          },
          projectPath: {
            type: 'string',
            description: 'Optional path on host to bind-mount into /workspace/project',
          },
        },
        required: ['language', 'code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute a bash or git command (e.g. git clone, git add, git commit, git push, ls, npm install) in the sandbox or on the Runpod GPU pod.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command line to run',
          },
          target: {
            type: 'string',
            enum: ['sandbox', 'pod'],
            description: 'Where to execute: "sandbox" (local isolated environment) or "pod" (remote Runpod GPU pod)',
          },
          profile: {
            type: 'string',
            enum: ['none', 'full'],
            description: 'Network profile for sandbox: "none" or "full"',
          },
          projectPath: {
            type: 'string',
            description: 'Optional host project directory to mount into /workspace/project',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_on_pod',
      description: 'Execute a shell command directly on the remote Runpod GPU pod via SSH.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Command to run on the Runpod pod',
          },
        },
        required: ['command'],
      },
    },
  },
]

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

// Executes a single tool call against the local sandbox or Runpod pod
export async function executeAgentTool({ name, args: rawArgs = {}, sessionId = 'default', projectPath = null, userId = null }) {
  const args = normalizeToolArgs(name, rawArgs)
  const cleanSession = sessionId || 'default'

  if (name === 'web_search') {
    // Reshaped to match the sandbox result shape ({stdout,...}) that the
    // caller (ollama.js) already knows how to turn into a tool observation.
    const start = Date.now()
    const { content } = await runWebSearchTool({ query: args.query })
    return { ok: true, stdout: content, stderr: '', exitCode: 0, durationMs: Date.now() - start, target: 'web_search' }
  }
  const targetProj = args.projectPath || projectPath || null

  if (name === 'run_code') {
    return executeInSandbox({
      code: args.code || '',
      language: args.language || 'python',
      sessionId: cleanSession,
      profile: args.profile || 'none',
      projectPath: targetProj,
      ...(await gitCreds(userId)),
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
      ...(await gitCreds(userId)),
    })
  }

  throw new Error(`Unknown agent tool: "${name}"`)
}

// Looks up the user's own GitHub token (paste one under Connections — it's
// auto-detected by prefix, same vault as the model API keys) so `git clone`/
// `git push` in the sandbox can authenticate. No token connected -> git still
// works for anything that doesn't need auth (clone of a public repo, local
// commits), it just can't push/pull anything private.
async function gitCreds(userId) {
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

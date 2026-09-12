// The agent's "hands", defined once in the Anthropic/MCP tool shape and
// converted for adapters that speak OpenAI-style function calling.
//
// File tools exist because making a model write files through bash strings
// (heredocs, quoting, nested JSON) was the single biggest source of botched
// builds. write_file/edit_file take the content as a plain argument and we
// deliver it to the sandbox base64-encoded, so no quoting can go wrong.
import { WEB_SEARCH_TOOL } from './webSearch.js'
import { fileMutationCommand } from './fileMutation.js'

const str = (description) => ({ type: 'string', description })
// Set once (on any tool call) to bind-mount a real local folder on the host
// running the server — e.g. an existing project on the user's own PC when
// they're running Nexus locally — at the project root instead of the
// throwaway per-chat sandbox dir. Sticky: it's remembered for every later
// call in this same chat, so it only needs to be given once.
const PROJECT_PATH_FIELD = str('Absolute Linux path on the Nexus host. Persisted for this conversation. Changing or clearing an established project requires set_execution_context.')

export const AGENT_TOOL_DEFS = [
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content (parent folders are created). Use this for every file you write — never heredocs. Paths are relative to the current project (a mounted local folder if one is set, else /workspace) unless absolute.',
    input_schema: { type: 'object', properties: { path: str('File path, e.g. repo/app/page.tsx'), content: str('Full file content'), projectPath: PROJECT_PATH_FIELD }, required: ['path', 'content'] },
  },
  {
    name: 'read_file',
    description: 'Read a file. Returns its text (long files are truncated; use start/limit for the rest).',
    input_schema: { type: 'object', properties: { path: str('File path'), start: { type: 'integer', description: 'First line (1-based)' }, limit: { type: 'integer', description: 'Max lines (default 400)' }, projectPath: PROJECT_PATH_FIELD }, required: ['path'] },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact text snippet in a file with new text (the old text must appear exactly once). Cheaper and safer than rewriting the whole file.',
    input_schema: { type: 'object', properties: { path: str('File path'), old: str('Exact text to replace'), new: str('Replacement text'), projectPath: PROJECT_PATH_FIELD }, required: ['path', 'old', 'new'] },
  },
  {
    name: 'list_files',
    description: 'List files and folders under a path (recursive, node_modules/.git skipped).',
    input_schema: { type: 'object', properties: { path: str('Folder (default: project root)'), depth: { type: 'integer', description: 'Max depth (default 3)' }, projectPath: PROJECT_PATH_FIELD } },
  },
  {
    name: 'search_files',
    description: 'Search file contents under a path for a regex (grep -rn). Returns matching lines with file:line.',
    input_schema: { type: 'object', properties: { pattern: str('Regex to search for'), path: str('Folder (default: project root)'), projectPath: PROJECT_PATH_FIELD } },
  },
  {
    name: 'execute_command',
    description: 'Run a shell command in the sandbox (git, npm, ls, cat, build, tests…). Starts in /workspace; use "cd <dir> && …" or absolute paths. target "pod" runs it on the RunPod GPU pod instead.',
    input_schema: {
      type: 'object',
      properties: {
        command: str('The shell command line'),
        target: { type: 'string', enum: ['sandbox', 'pod'], description: 'Where to run (default sandbox)' },
        profile: { type: 'string', enum: ['none', 'full'], description: 'Network: "full" (default) or "none"' },
        projectPath: PROJECT_PATH_FIELD,
        purpose: { type: 'string', enum: ['work', 'diagnostic'], description: 'diagnostic means a read-only inspection or minimal probe; allowed during a diagnostic checkpoint. Never edit files in a diagnostic command.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_code',
    description: 'Run a code snippet in the sandbox (python, javascript, typescript, c++, bash). Prefer write_file + execute_command for anything that creates files.',
    input_schema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'javascript', 'typescript', 'c++', 'bash'] },
        code: str('The complete code to run (plain source text)'),
        profile: { type: 'string', enum: ['none', 'full'], description: 'Network: "none" (default) or "full"' },
        projectPath: PROJECT_PATH_FIELD,
      },
      required: ['language', 'code'],
    },
  },
  {
    name: 'run_on_pod',
    description: 'Run a command on the GPU pod only after set_execution_context explicitly selects pod. Turbo inference does not move execution there.',
    input_schema: { type: 'object', properties: { command: str('Command to run on the pod') }, required: ['command'] },
  },
  {
    name: 'inspect_execution', description: 'Read the durable machine, project, diagnostic checkpoint, recent evidence IDs, verification checks and next step. Use at the start of resumed work.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_execution_context', description: 'Explicitly change execution machine or project. Does not transfer files. Keep application work on the VPS; select pod only for a task that needs execution there, never merely because Turbo is selected.',
    input_schema: { type: 'object', properties: { environment: { type: 'string', enum: ['sandbox', 'pod'] }, projectPath: str('Absolute directory; empty string resets to the conversation sandbox'), reason: str('Why this task requires a different machine or project') }, required: ['environment', 'projectPath', 'reason'] },
  },
  {
    name: 'diagnose_failure', description: 'Release a diagnostic checkpoint only after fresh source inspection and a diagnostic command. Cite their server evidence IDs, explain the observed cause and the next check. This does not mark the repair verified.',
    input_schema: { type: 'object', properties: { evidenceIds: { type: 'array', items: { type: 'integer' } }, cause: str('Observed cause supported by the cited results'), nextCheck: str('Targeted repair and original failing check to rerun') }, required: ['evidenceIds', 'cause', 'nextCheck'] },
  },
  {
    name: 'verify_work', description: 'Run a read-only test/build/deployment check and assert actual stdout outcomes. Exit zero alone is insufficient. Use json_number min=1 for counts that must be positive; emit a final JSON object from the test. Checks become stale after further changes. Each label describes only the requirement checked; do not use echo to invent evidence.',
    input_schema: { type: 'object', properties: { command: str('Real check command; preserve failures, do not change project source'), label: str('Specific acceptance requirement being tested'), kind: { type: 'string', enum: ['test', 'build', 'deployment'] }, assertions: { type: 'array', minItems: 1, items: { type: 'object', properties: { type: { type: 'string', enum: ['contains', 'json_number'] }, value: str('Required stdout text for contains'), field: str('Dotted JSON numeric field for json_number'), min: { type: 'number' } }, required: ['type'] } } }, required: ['command', 'label', 'kind', 'assertions'] },
  },
  {
    name: 'record_progress', description: 'Persist the concrete next step or blocker for later turns. Completed changes, failures and checks are recorded automatically; this note cannot declare verification.',
    input_schema: { type: 'object', properties: { nextStep: str('Concrete next action or unresolved blocker; omit secrets') }, required: ['nextStep'] },
  },
  {
    name: 'transfer_file', description: 'Copy one file from the current VPS project/sandbox to an absolute pod path. Verifies byte count, SHA-256 and supported syntax before atomic replacement. Returns destination evidence; does not execute or change the project context. Pod must already be running.',
    input_schema: { type: 'object', properties: { path: str('Source file in current project'), destination: str('Absolute destination file on pod') }, required: ['path', 'destination'] },
  },
]

export const AGENT_TOOL_NAMES = new Set([...AGENT_TOOL_DEFS.map((t) => t.name), WEB_SEARCH_TOOL.name])

export function toOpenAITools(defs) {
  return defs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
}

// Sandbox result -> the text the model reads back.
export function observationText(name, result) {
  const out = (result.stdout || '').trim()
  const err = (result.stderr || '').trim()
  const context = result.context ? `[Execution #${result.evidenceId}: machine=${result.machine || result.context.machine}; environment=${result.context.environment}; initial cwd=${result.context.cwd}; project=${result.context.projectPath || '(conversation workspace)'}; exit=${result.exitCode}; revision=${result.context.revision}; diagnosisRequired=${result.context.diagnosticRequired}]\n` : ''
  if (['write_file', 'read_file', 'edit_file', 'list_files', 'search_files', 'web_search'].includes(name)) {
    return context + (result.ok ? (out || '(ok)') : `Error: ${err || out || 'failed'}`)
  }
  const body = out ? out : err ? `(Error: ${err})` : result.ok ? '(command succeeded with no stdout)' : '(command failed with no output)'
  return context + `[Tool Execution: ${name} on ${result.target || 'sandbox'}]\nExit Code: ${result.exitCode}\nOutput:\n${body}${out && err ? `\nStderr:\n${err}` : ''}`
}

// A step record for the UI's tool card / live progress.
export function toStep(name, args, result) {
  return {
    tool: name,
    args,
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    target: result.target || 'sandbox',
    evidenceId: result.evidenceId,
    context: result.context,
    machine: result.machine,
  }
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// `base` is /workspace/project when a local folder is bind-mounted for this
// call (see agentLoop.js), /workspace otherwise — a relative path from the
// model resolves against whichever one is actually the working project, not
// always the bare sandbox root.
// `hostRoot` is the project's path on the HOST. The user refers to the project
// by that path and the model repeats it, but inside the sandbox the folder is
// mounted at `base` — so a literal /root/my-project/README.md came back as
// "No such file" even though the instruction was exactly right. Map host paths
// under the project onto the mount instead of failing.
const absPath = (p, base, hostRoot = null) => {
  const s = String(p || '').trim()
  if (!s) return base
  if (!s.startsWith('/')) return `${base}/${s.replace(/^\.\//, '')}`
  if (hostRoot) {
    const root = String(hostRoot).replace(/\\/g, '/').replace(/\/+$/, '')
    if (root && (s === root || s.startsWith(root + '/'))) {
      return s === root ? base : base + s.slice(root.length)
    }
  }
  return s
}

// Bash for each file tool. Everything model-supplied goes through base64 or
// single-quote escaping — the model never gets to build shell syntax.
// `base`: the effective project root for a relative path (see absPath above).
export function fileToolCommand(name, args = {}, { base = '/workspace', hostRoot = null } = {}) {
  switch (name) {
    case 'write_file': {
      const p = absPath(args.path, base, hostRoot)
      const fileName = p.split('/').filter(Boolean).pop() || ''
      // Real credentials (Supabase URLs/keys, DB connection strings) live in
      // this chat and legitimately belong in project env files — but an env
      // file with no .gitignore covering it is one `git add -A` away from a
      // committed secret. Guarantee coverage the moment the file is written,
      // regardless of what .gitignore (if any) the model wrote itself.
      const isSecretFile = /^\.env(\..+)?$/i.test(fileName) || /\.(pem|key|p12|pfx)$/i.test(fileName) || /^id_(rsa|ed25519|ecdsa)$/.test(fileName)
      const guard = isSecretFile
        ? ` && { D="$(dirname ${q(p)})"; GI="$D/.gitignore"; grep -qxF '.env*' "$GI" 2>/dev/null || printf '%s\n' '.env*' >> "$GI"; }`
        : ''
      return fileMutationCommand(name, args, p) + guard
    }
    case 'read_file': {
      const p = absPath(args.path, base, hostRoot)
      const start = Math.max(1, Number(args.start) || 1)
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 400))
      return `test -f ${q(p)} || { echo "No such file: ${p}" >&2; exit 1; }; total=$(awk 'END { print NR }' ${q(p)}); sed -n '${start},${start + limit - 1}p' ${q(p)} | nl -ba -v ${start}; if [ "$total" -gt ${start + limit - 1} ]; then echo "... (${'$'}total lines total; showing ${start}-${start + limit - 1})"; fi`
    }
    case 'edit_file': {
      const p = absPath(args.path, base, hostRoot)
      return fileMutationCommand(name, args, p)
    }
    case 'list_files': {
      const p = absPath(args.path, base, hostRoot)
      const depth = Math.min(8, Math.max(1, Number(args.depth) || 3))
      return `cd ${q(p)} 2>/dev/null || { echo "No such folder: ${p}" >&2; exit 1; }; find . -maxdepth ${depth} \\( -name node_modules -o -name .git -o -name .next -o -name dist \\) -prune -o -print | sed 's|^\\./||' | sort | head -400`
    }
    case 'search_files': {
      const p = absPath(args.path, base, hostRoot)
      return `grep -rn --include='*' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next -E ${q(args.pattern ?? '')} ${q(p)} 2>/dev/null | cut -c1-300 | head -200; true`
    }
    default:
      return null
  }
}

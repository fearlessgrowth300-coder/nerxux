// The agent's "hands", defined once in the Anthropic/MCP tool shape and
// converted for adapters that speak OpenAI-style function calling.
//
// File tools exist because making a model write files through bash strings
// (heredocs, quoting, nested JSON) was the single biggest source of botched
// builds. write_file/edit_file take the content as a plain argument and we
// deliver it to the sandbox base64-encoded, so no quoting can go wrong.
import { WEB_SEARCH_TOOL } from './webSearch.js'

const str = (description) => ({ type: 'string', description })

export const AGENT_TOOL_DEFS = [
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the sandbox with the given content (parent folders are created). Use this for every file you write — never heredocs. Paths are relative to /workspace unless absolute.',
    input_schema: { type: 'object', properties: { path: str('File path, e.g. repo/app/page.tsx'), content: str('Full file content') }, required: ['path', 'content'] },
  },
  {
    name: 'read_file',
    description: 'Read a file from the sandbox. Returns its text (long files are truncated; use start/limit for the rest).',
    input_schema: { type: 'object', properties: { path: str('File path'), start: { type: 'integer', description: 'First line (1-based)' }, limit: { type: 'integer', description: 'Max lines (default 400)' } }, required: ['path'] },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact text snippet in a file with new text (the old text must appear exactly once). Cheaper and safer than rewriting the whole file.',
    input_schema: { type: 'object', properties: { path: str('File path'), old: str('Exact text to replace'), new: str('Replacement text') }, required: ['path', 'old', 'new'] },
  },
  {
    name: 'list_files',
    description: 'List files and folders under a path in the sandbox (recursive, node_modules/.git skipped).',
    input_schema: { type: 'object', properties: { path: str('Folder (default /workspace)'), depth: { type: 'integer', description: 'Max depth (default 3)' } } },
  },
  {
    name: 'search_files',
    description: 'Search file contents under a path for a regex (grep -rn). Returns matching lines with file:line.',
    input_schema: { type: 'object', properties: { pattern: str('Regex to search for'), path: str('Folder (default /workspace)') }, required: ['pattern'] },
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
        projectPath: str('Optional host directory to mount at /workspace/project'),
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
        projectPath: str('Optional host directory to mount at /workspace/project'),
      },
      required: ['language', 'code'],
    },
  },
  {
    name: 'run_on_pod',
    description: 'Run a shell command directly on the RunPod GPU pod via SSH.',
    input_schema: { type: 'object', properties: { command: str('Command to run on the pod') }, required: ['command'] },
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
  if (['write_file', 'read_file', 'edit_file', 'list_files', 'search_files', 'web_search'].includes(name)) {
    return result.ok ? (out || '(ok)') : `Error: ${err || out || 'failed'}`
  }
  const body = out ? out : err ? `(Error: ${err})` : '(command succeeded with no stdout)'
  return `[Tool Execution: ${name} on ${result.target || 'sandbox'}]\nExit Code: ${result.exitCode}\nOutput:\n${body}${out && err ? `\nStderr:\n${err}` : ''}`
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
  }
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const absPath = (p, fallback = '/workspace') => {
  const s = String(p || '').trim()
  if (!s) return fallback
  return s.startsWith('/') ? s : `/workspace/${s.replace(/^\.\//, '')}`
}

// Bash for each file tool. Everything model-supplied goes through base64 or
// single-quote escaping — the model never gets to build shell syntax.
export function fileToolCommand(name, args = {}) {
  switch (name) {
    case 'write_file': {
      const p = absPath(args.path)
      return `mkdir -p "$(dirname ${q(p)})" && printf '%s' ${q(b64(args.content ?? ''))} | base64 -d > ${q(p)} && echo "wrote ${p} ($(wc -c < ${q(p)}) bytes)"`
    }
    case 'read_file': {
      const p = absPath(args.path)
      const start = Math.max(1, Number(args.start) || 1)
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 400))
      return `test -f ${q(p)} || { echo "No such file: ${p}" >&2; exit 1; }; total=$(wc -l < ${q(p)}); sed -n '${start},${start + limit - 1}p' ${q(p)} | cut -c1-500 | nl -ba -v ${start}; if [ "$total" -gt ${start + limit - 1} ]; then echo "... (${'$'}total lines total; showing ${start}-${start + limit - 1})"; fi`
    }
    case 'edit_file': {
      const p = absPath(args.path)
      const py = [
        'import sys, base64',
        'p = sys.argv[1]',
        `old = base64.b64decode(${JSON.stringify(b64(args.old ?? ''))}).decode()`,
        `new = base64.b64decode(${JSON.stringify(b64(args.new ?? ''))}).decode()`,
        'src = open(p, encoding="utf-8").read()',
        'n = src.count(old)',
        'if n != 1:',
        '    sys.stderr.write(f"old text must appear exactly once in {p}, found {n}\\n"); sys.exit(1)',
        'open(p, "w", encoding="utf-8").write(src.replace(old, new, 1))',
        'print(f"edited {p}")',
      ].join('\n')
      return `PY="$(command -v python3 || command -v python)" && printf '%s' ${q(b64(py))} | base64 -d | "$PY" - ${q(p)}`
    }
    case 'list_files': {
      const p = absPath(args.path)
      const depth = Math.min(8, Math.max(1, Number(args.depth) || 3))
      return `cd ${q(p)} 2>/dev/null || { echo "No such folder: ${p}" >&2; exit 1; }; find . -maxdepth ${depth} \\( -name node_modules -o -name .git -o -name .next -o -name dist \\) -prune -o -print | sed 's|^\\./||' | sort | head -400`
    }
    case 'search_files': {
      const p = absPath(args.path)
      return `grep -rn --include='*' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next -E ${q(args.pattern ?? '')} ${q(p)} 2>/dev/null | cut -c1-300 | head -200; true`
    }
    default:
      return null
  }
}

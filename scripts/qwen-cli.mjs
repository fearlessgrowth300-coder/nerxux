#!/usr/bin/env node
// A terminal coding agent powered by your Qwen 3.8 27B model — same tools
// (write_file, edit_file, read_file, list_files, search_files,
// execute_command), but running natively on THIS machine: no sandbox, no
// bwrap, no bind-mount, because there's nothing to bridge — it just reads
// and writes your real files directly with Node's own fs/child_process.
// That's also why it needs no special setup: if you can run `node`, this
// works. Real isolation only matters when running arbitrary/untrusted code;
// this is you, in your own terminal, on your own machine.
//
// Usage:
//   node scripts/qwen-cli.mjs [project-directory]      (default: cwd)
//   QWEN_HOST=http://127.0.0.1:11435 node scripts/qwen-cli.mjs   (use Turbo — tunnel it first, see connect_runpod.bat)
//
// Talks to Ollama's /api/chat directly. Default host is the Hostinger
// Always-On box (reachable from anywhere, ~2-5 tok/s); point QWEN_HOST at
// 127.0.0.1:11435 after running connect_runpod.bat for the faster GPU.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { exec } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AGENT_TOOL_DEFS, toOpenAITools } from '../server/lib/agentTools.js'

const HOST = process.env.QWEN_HOST || 'http://2.25.126.125:11434'
const MODEL = process.env.QWEN_MODEL || 'orcarouter/Qwen3.8-27B-Uncensored'
const PROJECT_DIR = path.resolve(process.argv[2] || process.cwd())
const NUM_PREDICT = 4000 // no proxy timeout here to dodge — just a runaway-generation backstop

if (!fs.existsSync(PROJECT_DIR)) {
  console.error(`No such directory: ${PROJECT_DIR}`)
  process.exit(1)
}

// Same tool list the web app gives Qwen, minus run_on_pod (that's the RunPod
// GPU pod specifically, not relevant to "edit files on this machine") and
// minus each schema's projectPath field (there's only ever one project here:
// PROJECT_DIR, fixed for the life of this process).
const TOOLS = toOpenAITools(
  AGENT_TOOL_DEFS.filter((t) => t.name !== 'run_on_pod').map((t) => {
    const { projectPath, ...rest } = t.input_schema.properties
    return { ...t, input_schema: { ...t.input_schema, properties: rest } }
  })
)

function resolvePath(p) {
  const s = String(p || '').trim()
  if (!s) return PROJECT_DIR
  const abs = path.isAbsolute(s) ? s : path.join(PROJECT_DIR, s)
  return path.normalize(abs)
}

// Same secret-file convention as the web app: writing an env/key-shaped file
// always ensures a .gitignore covers it, so a later `git add -A` can't catch it.
function guardSecretFile(absPath) {
  const base = path.basename(absPath)
  const isSecret = /^\.env(\..+)?$/i.test(base) || /\.(pem|key|p12|pfx)$/i.test(base) || /^id_(rsa|ed25519|ecdsa)$/.test(base)
  if (!isSecret) return
  const gi = path.join(path.dirname(absPath), '.gitignore')
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : ''
  if (!existing.split('\n').some((l) => l.trim() === '.env*')) {
    fs.writeFileSync(gi, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + '.env*\n')
  }
}

function listFiles(dir, depth, prefix = '') {
  const skip = new Set(['node_modules', '.git', '.next', 'dist', 'build'])
  let out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    out.push(rel)
    if (entry.isDirectory() && depth > 1) out = out.concat(listFiles(path.join(dir, entry.name), depth - 1, rel))
  }
  return out
}

function searchFiles(dir, pattern, skip = new Set(['node_modules', '.git', '.next', 'dist', 'build'])) {
  const re = new RegExp(pattern)
  const hits = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (hits.length < 200) {
        let text
        try { text = fs.readFileSync(full, 'utf8') } catch { continue } // binary/unreadable — skip
        text.split('\n').forEach((line, i) => {
          if (hits.length < 200 && re.test(line)) hits.push(`${path.relative(PROJECT_DIR, full)}:${i + 1}:${line.slice(0, 300)}`)
        })
      }
    }
  }
  walk(dir)
  return hits
}

export async function runTool(name, args) {
  try {
    if (name === 'write_file') {
      const p = resolvePath(args.path)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, args.content ?? '')
      guardSecretFile(p)
      return `wrote ${path.relative(PROJECT_DIR, p)} (${Buffer.byteLength(args.content ?? '')} bytes)`
    }
    if (name === 'read_file') {
      const p = resolvePath(args.path)
      if (!fs.existsSync(p)) return `Error: no such file: ${path.relative(PROJECT_DIR, p)}`
      const lines = fs.readFileSync(p, 'utf8').split('\n')
      const start = Math.max(1, Number(args.start) || 1)
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 400))
      const slice = lines.slice(start - 1, start - 1 + limit)
      const body = slice.map((l, i) => `${start + i}\t${l.slice(0, 500)}`).join('\n')
      return lines.length > start - 1 + limit ? `${body}\n... (${lines.length} lines total; showing ${start}-${start + limit - 1})` : body
    }
    if (name === 'edit_file') {
      const p = resolvePath(args.path)
      const src = fs.readFileSync(p, 'utf8')
      const count = src.split(args.old ?? '  no-match  ').length - 1
      if (count !== 1) return `Error: old text must appear exactly once in ${path.relative(PROJECT_DIR, p)}, found ${count}`
      fs.writeFileSync(p, src.replace(args.old, args.new ?? ''))
      return `edited ${path.relative(PROJECT_DIR, p)}`
    }
    if (name === 'list_files') {
      const p = resolvePath(args.path)
      if (!fs.existsSync(p)) return `Error: no such folder: ${path.relative(PROJECT_DIR, p)}`
      return listFiles(p, Math.min(8, Math.max(1, Number(args.depth) || 3))).slice(0, 400).join('\n') || '(empty)'
    }
    if (name === 'search_files') {
      const p = resolvePath(args.path)
      const hits = searchFiles(fs.existsSync(p) ? p : PROJECT_DIR, args.pattern ?? '')
      return hits.join('\n') || '(no matches)'
    }
    if (name === 'execute_command') {
      return await new Promise((resolve) => {
        exec(args.command || '', { cwd: PROJECT_DIR, timeout: 5 * 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          const out = (stdout || '').trim(), errText = (stderr || '').trim()
          resolve(out || errText ? `${out}${out && errText ? '\n' : ''}${errText}` : err ? `(exit ${err.code})` : '(no output)')
        })
      })
    }
    return `Error: unknown tool "${name}"`
  } catch (e) {
    return `Error: ${e.message}`
  }
}

const SYSTEM_PROMPT = `You are a coding agent with direct file access to a real project on the user's own machine, at ${PROJECT_DIR}. You are NOT in a sandbox — every write is real and immediate.

Work autonomously: when asked to build or fix something, carry it through to done in this turn — write files, run builds/tests, verify the result — instead of stopping to ask permission or describing a plan you haven't executed.

Look before you act: list_files/read_file before changing things you haven't seen. Use write_file (whole file) or edit_file (small change) — never printf/echo/heredocs through execute_command. Keep tool calls small (1-2 files per call). Verify with a build/test run before calling something done.`

const messages = [{ role: 'system', content: SYSTEM_PROMPT }]

function spinner(label) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  const start = Date.now()
  const timer = setInterval(() => {
    process.stdout.write(`\r${frames[i++ % frames.length]} ${label} (${Math.round((Date.now() - start) / 1000)}s)  `)
  }, 100)
  return () => { clearInterval(timer); process.stdout.write('\r' + ' '.repeat(40) + '\r') }
}

async function chat() {
  for (let step = 0; step < 60; step++) {
    const stop = spinner(step === 0 ? 'thinking' : 'working')
    let resp
    try {
      resp = await fetch(`${HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: false, options: { num_predict: NUM_PREDICT } }),
      })
    } catch (e) {
      stop()
      console.error(`\nCan't reach ${HOST}: ${e.message}\nIs the Hostinger box up, or (for Turbo) did you run connect_runpod.bat first?`)
      return
    }
    stop()
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      console.error(`\nOllama returned ${resp.status}: ${body.slice(0, 300)}`)
      return
    }
    const data = await resp.json()
    const msg = data.message || {}
    const calls = msg.tool_calls || []
    if (!calls.length) {
      console.log('\n' + (msg.content || '(empty reply)') + '\n')
      messages.push({ role: 'assistant', content: msg.content || '' })
      return
    }
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls })
    for (const call of calls) {
      const name = call.function?.name
      let args = call.function?.arguments || {}
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
      const summary = String(args.path || args.command || args.pattern || '').slice(0, 80)
      process.stdout.write(`  ${name} ${summary}\n`)
      const result = await runTool(name, args)
      console.log('    ' + result.split('\n').slice(0, 6).join('\n    ') + (result.split('\n').length > 6 ? '\n    ...' : ''))
      messages.push({ role: 'tool', content: result })
    }
  }
  console.log('\n(stopped after 60 tool steps — say "continue" if it needs more)\n')
}

// Only start the interactive REPL when this file is actually run (`node
// scripts/qwen-cli.mjs`) — not when it's imported elsewhere (e.g. to reuse
// runTool) purely for its exports.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  console.log(`Qwen CLI — ${MODEL}`)
  console.log(`Project: ${PROJECT_DIR}`)
  console.log(`Host: ${HOST}${HOST.includes('2.25.126.125') ? ' (Always-On, ~2-5 tok/s)' : ' (Turbo, if tunneled)'}`)
  console.log('Type your request, or /exit to quit.\n')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
  rl.prompt()
  // Piped/scripted input can deliver several lines before the first reply
  // finishes (readline parses every newline already in the buffer up front,
  // regardless of how long the async handler for line 1 takes) — queue so a
  // line typed/piped mid-reply waits its turn instead of racing it.
  const queue = []
  let busy = false
  // If stdin hits EOF while a reply is still in flight (only happens with
  // piped/redirected input, never a real interactive terminal), readline
  // marks itself closed internally before the 'close' event even fires —
  // .prompt() on it past that point throws. Nothing useful to show a prompt
  // for at that point anyway (nobody's there to read it).
  const safePrompt = () => { try { rl.prompt() } catch {} }
  const drain = async () => {
    if (busy) return
    busy = true
    while (queue.length) {
      const text = queue.shift()
      if (text === '/exit' || text === '/quit') { rl.close(); return }
      if (text) { messages.push({ role: 'user', content: text }); await chat() }
      safePrompt()
    }
    busy = false
  }
  rl.on('line', (line) => { queue.push(line.trim()); drain() })
  // Piped input hits EOF (closing stdin, firing this) right after its last
  // line arrives — must not exit while that line's reply is still in flight.
  rl.on('close', async () => {
    while (busy) await new Promise((r) => setTimeout(r, 200))
    process.exit(0)
  })
}

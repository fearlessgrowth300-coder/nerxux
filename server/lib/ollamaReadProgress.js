import { spawn } from 'node:child_process'

// Ollama sends nothing back while it reads a prompt — on the Always On CPU
// that silence lasts many minutes and the chat looked frozen. Its log does
// report the read, every ~1k tokens:
//   slot print_timing: id 0 | task 1511 | prompt processing, n_tokens = 5120, progress = 0.28, t = 83.52 s / 61.30 tokens per second
// Always On runs Ollama on this same machine under systemd, so follow its
// journal while a read is in flight and hand those numbers to the chat.
// Anywhere journalctl is missing (Windows dev, a remote pod) this is a no-op
// and the caller falls back to its time estimate.

const LINE = /task\s+(\d+)\s*\|\s*prompt processing, n_tokens\s*=\s*(\d+), progress\s*=\s*([\d.]+), t\s*=\s*([\d.]+) s \/\s*([\d.]+) tokens per second/

export function parseProgressLine(line) {
  const m = LINE.exec(String(line))
  if (!m) return null
  const tokens = Number(m[2])
  const progress = Math.min(1, Number(m[3]))
  return {
    task: m[1],
    tokens,
    progress,
    totalTokens: progress > 0 ? Math.round(tokens / progress) : null,
    seconds: Number(m[4]),
    tokPerSec: Number(m[5]),
  }
}

const subscribers = new Set()
let child = null
let buffer = ''

function start() {
  if (child || process.platform === 'win32' || process.env.OLLAMA_JOURNAL === '0') return
  try {
    child = spawn('journalctl', ['-u', process.env.OLLAMA_JOURNAL_UNIT || 'ollama', '-f', '-n', '0', '-o', 'cat'], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    child = null
    return
  }
  const self = child
  self.on('error', () => { if (child === self) child = null })
  self.on('exit', () => { if (child === self) child = null })
  self.stdout.setEncoding('utf8')
  self.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      const p = parseProgressLine(line)
      if (p) for (const fn of subscribers) fn(p)
    }
  })
}

function stop() {
  if (!child) return
  try { child.kill() } catch {}
  child = null
  buffer = ''
}

// Calls `onUpdate(progress)` for the read this caller started. Several jobs
// can share one Ollama, so latch onto the first task id that reports after
// subscribing and ignore the others. Returns an unsubscribe function.
export function watchReadProgress(onUpdate) {
  let task = null
  const fn = (p) => {
    if (task == null) task = p.task
    if (p.task === task) onUpdate(p)
  }
  subscribers.add(fn)
  start()
  return () => {
    subscribers.delete(fn)
    if (!subscribers.size) stop()
  }
}

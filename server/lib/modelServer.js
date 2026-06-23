// Auto-start + control for the local Python model server (nexus-model/serve.py).
//
// The frustration so far was that the model server had to be started by hand and
// kept dying. This module makes the Node API server bring it up automatically on
// boot (if it isn't already running) and reload its checkpoint after training.
//
// The Python process is spawned DETACHED so it survives Node restarts (e.g. from
// `node --watch`); ensureModelServer() health-checks first so we never start two.
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = path.join(__dirname, '..', '..', 'nexus-model')
const PY = process.env.PYTHON_BIN || 'python'
const PORT = process.env.NEXUS_MODEL_PORT || '4500'
const MODEL_URL = process.env.NEXUS_MODEL_URL || `http://127.0.0.1:${PORT}`

async function isUp(timeoutMs = 2000) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const r = await fetch(`${MODEL_URL}/health`, { signal: ctrl.signal })
    clearTimeout(t)
    return r.ok
  } catch {
    return false
  }
}

// Start serve.py if it isn't already responding. Safe to call repeatedly.
export async function ensureModelServer() {
  if (await isUp()) {
    console.log(`[nexus-ai] model server already up at ${MODEL_URL}`)
    return true
  }
  console.log(`[nexus-ai] starting model server: ${PY} -u serve.py (cwd ${MODEL_DIR})`)
  try {
    const child = spawn(PY, ['-u', 'serve.py'], {
      cwd: MODEL_DIR,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, NEXUS_MODEL_PORT: PORT },
    })
    child.on('error', (e) =>
      console.error(`[nexus-ai] could not launch model server (${PY}): ${e.message}. ` +
        `Install Python and deps: cd nexus-model && pip install -r requirements.txt`)
    )
    child.unref()
  } catch (e) {
    console.error(`[nexus-ai] model server spawn failed: ${e.message}`)
    return false
  }
  // Poll until it answers (up to ~20s — first load reads the checkpoint).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await isUp()) {
      console.log(`[nexus-ai] model server is up at ${MODEL_URL}`)
      return true
    }
  }
  console.warn('[nexus-ai] model server did not come up in time (check Python install).')
  return false
}

// Tell the running model server to reload the latest checkpoint (after training).
export async function reloadModelServer() {
  try {
    const r = await fetch(`${MODEL_URL}/reload`, { method: 'POST' })
    return r.ok ? await r.json() : { ok: false }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

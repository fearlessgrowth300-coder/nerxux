// Training data + model-training control for the user's own model (nexus-model/).
//
// - POST /api/training/upload   multipart "files" -> nexus-model/data/uploads/
// - GET  /api/training/status   corpus size, file count, training state, health
// - POST /api/training/build    run the data pipeline -> corpus.txt
// - POST /api/training/start    launch training (python train.py) in background
// - POST /api/training/stop     stop a running training job
// - GET  /api/training/logs     recent build/train output
import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { v4 as uuid } from 'uuid'
import { requireAuth } from '../lib/auth.js'
import { health as modelHealth } from '../adapters/nexus.js'
import { ensureModelServer, reloadModelServer } from '../lib/modelServer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_DIR = path.join(__dirname, '..', '..', 'nexus-model')
const UPLOADS = path.join(MODEL_DIR, 'data', 'uploads')
const CORPUS = path.join(MODEL_DIR, 'data', 'corpus.txt')
const PY = process.env.PYTHON_BIN || 'python'

fs.mkdirSync(UPLOADS, { recursive: true })

const ALLOWED = new Set(['.pdf', '.txt', '.md', '.html', '.htm', '.epub'])

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    // keep a readable, collision-free name
    const base = path.basename(file.originalname, ext).replace(/[^\w.-]+/g, '_').slice(0, 60)
    cb(null, `${base}_${uuid().slice(0, 8)}${ext}`)
  },
})
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ALLOWED.has(ext)) return cb(null, true)
    cb(new Error('Allowed for training: .pdf .txt .md .html .epub'))
  },
})

const router = Router()
router.use(requireAuth)

// --- single in-memory job (one machine, one trainer) ---
const job = { running: false, kind: null, log: [], startedAt: null, proc: null }
function pushLog(line) {
  job.log.push(line)
  if (job.log.length > 400) job.log.shift()
}
function runPython(args, kind) {
  if (job.running) throw new Error(`A ${job.kind} job is already running.`)
  job.running = true
  job.kind = kind
  job.startedAt = Date.now()
  job.log = []
  pushLog(`$ python ${args.join(' ')}`)
  const proc = spawn(PY, args, { cwd: MODEL_DIR })
  job.proc = proc
  proc.stdout.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && pushLog(l.trimEnd())))
  proc.stderr.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && pushLog(l.trimEnd())))
  proc.on('close', async (code) => {
    pushLog(`\n[${kind} finished with exit code ${code}]`)
    job.running = false
    job.proc = null
    // After a successful training run, make sure the model server is up and
    // tell it to load the freshly-saved checkpoint so chat uses the new model.
    if (kind === 'train' && code === 0) {
      pushLog('[reloading model server with the new checkpoint...]')
      await ensureModelServer()
      const r = await reloadModelServer()
      pushLog(r?.model_loaded ? '[model server now serving the new checkpoint]'
                              : '[reload attempted — check the model server]')
    }
  })
  proc.on('error', (e) => {
    pushLog(`[failed to launch python: ${e.message}]`)
    job.running = false
    job.proc = null
  })
}

function listUploads() {
  if (!fs.existsSync(UPLOADS)) return []
  return fs.readdirSync(UPLOADS)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const st = fs.statSync(path.join(UPLOADS, f))
      return { name: f, sizeBytes: st.size }
    })
}

// POST /upload — multipart field "files"
router.post('/upload', (req, res) => {
  upload.array('files', 50)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    const files = (req.files || []).map((f) => ({ name: f.filename, sizeBytes: f.size }))
    res.json({ uploaded: files, total: listUploads().length })
  })
})

// DELETE /upload/:name — remove one source file
router.delete('/upload/:name', (req, res) => {
  const name = path.basename(req.params.name)
  const p = path.join(UPLOADS, name)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  res.json({ ok: true, total: listUploads().length })
})

// GET /status
router.get('/status', async (req, res) => {
  const corpusBytes = fs.existsSync(CORPUS) ? fs.statSync(CORPUS).size : 0
  const health = await modelHealth()
  res.json({
    uploads: listUploads(),
    corpusBytes,
    job: { running: job.running, kind: job.kind, startedAt: job.startedAt },
    health,
  })
})

// GET /logs
router.get('/logs', (req, res) => {
  res.json({ running: job.running, kind: job.kind, log: job.log })
})

// POST /build — extract/clean/dedupe uploads into corpus.txt
router.post('/build', (req, res) => {
  try {
    runPython(['-m', 'pipeline.build_corpus'], 'build')
    res.json({ ok: true })
  } catch (e) {
    res.status(409).json({ error: e.message })
  }
})

// POST /start — train. Body may set steps / n_layer / n_embd / block.
router.post('/start', (req, res) => {
  const { steps = 2000, n_layer = 4, n_head = 4, n_embd = 128, block = 64, vocab = 2048 } = req.body || {}
  const args = [
    'train.py',
    '--steps', String(steps),
    '--n_layer', String(n_layer),
    '--n_head', String(n_head),
    '--n_embd', String(n_embd),
    '--block', String(block),
    '--vocab', String(vocab),
  ]
  try {
    runPython(args, 'train')
    res.json({ ok: true })
  } catch (e) {
    res.status(409).json({ error: e.message })
  }
})

// POST /stop
router.post('/stop', (req, res) => {
  if (job.proc) {
    job.proc.kill()
    pushLog('[stopped by user]')
  }
  res.json({ ok: true })
})

export default router

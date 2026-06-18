import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { v4 as uuid } from 'uuid'
import { requireAuth } from '../lib/auth.js'
import { getDecryptedKey } from '../lib/vault.js'
import { analyzeVideo, stubAnalysis } from '../lib/gemini.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const ALLOWED = new Set([
  'video/mp4',
  'video/quicktime', // .mov
  'video/webm',
])
const ALLOWED_EXT = new Set(['.mp4', '.mov', '.webm'])

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) =>
    cb(null, `${uuid()}${path.extname(file.originalname).toLowerCase()}`),
})

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ALLOWED.has(file.mimetype) || ALLOWED_EXT.has(ext)) return cb(null, true)
    cb(new Error('Only .mp4, .mov, and .webm videos are allowed'))
  },
})

const router = Router()

// POST /api/upload — multipart form field "video". Analyzes the video with
// Gemini (or a stub if no key) and returns structured analysis. The temp file
// is always deleted afterward.
router.post('/', requireAuth, (req, res, next) => {
  upload.single('video')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message })
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided (field "video")' })
    }

    const { path: filePath, mimetype, originalname, size } = req.file
    try {
      const apiKey = await getDecryptedKey(req.user.id, 'gemini')

      let analysis
      let source
      if (apiKey) {
        try {
          analysis = await analyzeVideo({
            apiKey,
            filePath,
            mimeType: mimetype || 'video/mp4',
            displayName: originalname,
          })
          source = 'gemini'
        } catch (gemErr) {
          // Surface a helpful note but still return a stub so the flow continues.
          analysis = {
            ...stubAnalysis({ filename: originalname, sizeBytes: size }),
            scene: `Gemini analysis failed: ${gemErr.message}`,
          }
          source = 'error'
        }
      } else {
        analysis = stubAnalysis({ filename: originalname, sizeBytes: size })
        source = 'stub'
      }

      res.json({ filename: originalname, source, analysis })
    } catch (err) {
      next(err)
    } finally {
      fs.unlink(filePath, () => {}) // best-effort cleanup
    }
  })
})

export default router

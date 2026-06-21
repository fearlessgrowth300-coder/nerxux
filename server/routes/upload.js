import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { v4 as uuid } from 'uuid'
import { requireAuth } from '../lib/auth.js'
import { getProviderKey } from '../lib/vault.js'
import { analyzeVideo, stubAnalysis } from '../lib/gemini.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const DOC_EXT = new Set(['.pdf'])
const ALLOWED_EXT = new Set([...VIDEO_EXT, ...IMAGE_EXT, ...DOC_EXT])

function kindFor(ext) {
  if (VIDEO_EXT.has(ext)) return 'video'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (DOC_EXT.has(ext)) return 'pdf'
  return null
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) =>
    cb(null, `${uuid()}${path.extname(file.originalname).toLowerCase()}`),
})

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB (video); images/pdf are far smaller
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ALLOWED_EXT.has(ext)) return cb(null, true)
    cb(new Error('Allowed: images (.png .jpg .webp .gif), .pdf, and videos (.mp4 .mov .webm)'))
  },
})

const router = Router()

// POST /api/upload — multipart field "file" (or legacy "video").
// - video -> Gemini analysis (or stub)
// - image / pdf -> returned as base64 so the model can read it directly (vision/doc)
router.post('/', requireAuth, (req, res, next) => {
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'video', maxCount: 1 }])(
    req,
    res,
    async (uploadErr) => {
      if (uploadErr) return res.status(400).json({ error: uploadErr.message })
      const file = req.files?.file?.[0] || req.files?.video?.[0]
      if (!file) return res.status(400).json({ error: 'No file provided (field "file")' })

      const { path: filePath, mimetype, originalname, size } = file
      const ext = path.extname(originalname).toLowerCase()
      const kind = kindFor(ext)

      try {
        if (kind === 'video') {
          const apiKey = await getProviderKey(req.user.id, 'gemini')
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
              analysis = { ...stubAnalysis({ filename: originalname, sizeBytes: size }), scene: `Gemini analysis failed: ${gemErr.message}` }
              source = 'error'
            }
          } else {
            analysis = stubAnalysis({ filename: originalname, sizeBytes: size })
            source = 'stub'
          }
          return res.json({ kind: 'video', filename: originalname, source, analysis })
        }

        // image / pdf -> base64 (read directly by the model)
        const base64 = fs.readFileSync(filePath).toString('base64')
        return res.json({
          kind,
          filename: originalname,
          mimeType: mimetype || (kind === 'pdf' ? 'application/pdf' : 'image/png'),
          base64,
          sizeBytes: size,
        })
      } catch (err) {
        next(err)
      } finally {
        fs.unlink(filePath, () => {})
      }
    }
  )
})

export default router

import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import connectionsRouter from './routes/connections.js'
import chatRouter from './routes/chat.js'
import uploadRouter from './routes/upload.js'

const app = express()
const PORT = process.env.PORT || 4000

// ---- CORS ----
// Comma-separated list of allowed origins in CLIENT_ORIGINS, e.g.
// "http://localhost:5173,https://nexus.yourdomain.com,https://*.vercel.app".
// Entries may contain a "*" wildcard to allow preview/subdomain deployments.
const allowedOrigins = (process.env.CLIENT_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

// Convert each allowed-origin entry into a matcher (exact string or wildcard regex).
const originMatchers = allowedOrigins.map((entry) => {
  if (entry.includes('*')) {
    const pattern = entry
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex metachars
      .replace(/\*/g, '.*') // wildcard -> match anything
    return new RegExp(`^${pattern}$`)
  }
  return entry
})

function isOriginAllowed(origin) {
  return originMatchers.some((m) =>
    m instanceof RegExp ? m.test(origin) : m === origin
  )
}

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin / server-to-server requests (no Origin header).
      if (!origin || isOriginAllowed(origin)) return callback(null, true)
      return callback(new Error(`Origin ${origin} not allowed by CORS`))
    },
    credentials: true,
  })
)

app.use(express.json({ limit: '2mb' }))

// ---- Health check ----
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'nexus-ai-server',
    time: new Date().toISOString(),
  })
})

// ---- API routes ----
app.use('/api/connections', connectionsRouter)
app.use('/api/chat', chatRouter)
app.use('/api/upload', uploadRouter)

// ---- Central error handler ----
// Every route added in later steps should `next(err)` so errors land here
// with a consistent JSON shape and proper status codes.
app.use((err, req, res, next) => {
  console.error('[nexus-ai] error:', err.message)
  const status = err.status || 500
  res.status(status).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`[nexus-ai] server listening on http://localhost:${PORT}`)
})

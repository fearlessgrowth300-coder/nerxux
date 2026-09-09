import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import {
  getLiveComputeStatus,
  setHostingerIp,
  switchToAlwaysOn,
  switchToTurbo,
  startRunpodPod,
  stopRunpodPod,
  fetchPodDetails,
} from '../lib/computeManager.js'

const router = Router()

// Compute controls can start billable infrastructure and expose operational
// details, so every route in this router requires an authenticated user.
router.use(requireAuth)

// GET /api/compute/status
router.get('/status', async (req, res) => {
  try {
    const status = await getLiveComputeStatus()
    res.json(status)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/compute/switch
// Body: { mode: "always_on" | "turbo", stopPod?: boolean }
router.post('/switch', async (req, res) => {
  try {
    const { mode = 'always_on', stopPod = false } = req.body || {}
    if (mode === 'turbo') {
      const result = await switchToTurbo()
      return res.json(result)
    } else {
      const result = await switchToAlwaysOn({ stopPod })
      return res.json(result)
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/compute/hostinger
// Body: { ip: "..." }
router.post('/hostinger', (req, res) => {
  try {
    const { ip } = req.body || {}
    if (!ip) return res.status(400).json({ error: 'IP address or hostname required' })
    const updated = setHostingerIp(ip)
    res.json({ ok: true, hostingerUrl: updated })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/compute/pod/start
router.post('/pod/start', async (req, res) => {
  try {
    const result = await startRunpodPod()
    res.json({ ok: true, result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/compute/pod/stop
router.post('/pod/stop', async (req, res) => {
  try {
    const result = await stopRunpodPod()
    res.json({ ok: true, result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/compute/pod
router.get('/pod', async (req, res) => {
  try {
    const details = await fetchPodDetails()
    res.json({
      id: details.id,
      name: details.name,
      status: details.status,
      cost: details.cost,
      gpu: details.gpu
        ? { id: details.gpu.id, count: details.gpu.count }
        : null,
      createdAt: details.createdAt,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router

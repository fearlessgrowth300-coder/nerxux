import { Router } from 'express'
import {
  getComputeStatus,
  setHostingerIp,
  switchToAlwaysOn,
  switchToTurbo,
  startRunpodPod,
  stopRunpodPod,
  fetchPodDetails,
} from '../lib/computeManager.js'

const router = Router()

// GET /api/compute/status
router.get('/status', async (req, res) => {
  try {
    const status = getComputeStatus()
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
    res.json(details)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router

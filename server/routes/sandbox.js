import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import { executeInSandbox } from '../lib/sandbox.js'
import { runOnPod } from '../lib/pod.js'

const router = Router()

// These routes execute commands locally or on the GPU pod.
router.use(requireAuth)

// POST /api/sandbox/run
// Body: { code, language, sessionId, profile, stdin, projectPath, workingDir, gitToken, gitUser, gitEmail }
router.post('/run', async (req, res) => {
  try {
    const {
      code = '',
      language = 'python',
      sessionId = 'default',
      profile = 'none',
      stdin = '',
      projectPath = null,
      workingDir = null,
      gitToken = null,
      gitUser = 'Nexus AI',
      gitEmail = 'nexus@local.dev',
    } = req.body || {}

    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'Code cannot be empty' })
    }

    const result = await executeInSandbox({
      code,
      language,
      sessionId,
      profile,
      stdin,
      projectPath,
      workingDir,
      gitToken,
      gitUser,
      gitEmail,
    })

    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message || 'Sandbox execution failed' })
  }
})

// POST /api/sandbox/pod
// Body: { command, cwd, timeoutMs }
router.post('/pod', async (req, res) => {
  try {
    const { command = '', cwd = null, timeoutMs = 45000 } = req.body || {}
    if (!command || !command.trim()) {
      return res.status(400).json({ error: 'Command cannot be empty' })
    }

    const result = await runOnPod(command, { cwd, timeoutMs })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message || 'Pod execution failed' })
  }
})

export default router

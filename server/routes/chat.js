import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import { getModelById } from '../../shared/models.js'
import { routeIntent } from '../lib/router.js'
import { listConnections, getProviderKey } from '../lib/vault.js'
import { runTool } from '../adapters/index.js'
import { getEnabledConnectors } from '../lib/mcpStore.js'
import { callMcpTool } from '../lib/mcp.js'
import { savePending, takePending } from '../lib/pendingApprovals.js'
import { buildNativeToolset } from '../lib/nativeTools.js'
import { createJob, completeJob, failJob, touchJob } from '../lib/chatJobs.js'

const router = Router()
router.use(requireAuth)

// Provider/model metadata for router "tools".
const TOOL_META = {
  claude: { label: 'Claude Sonnet', model: 'claude-sonnet' },
  openai: { label: 'GPT-4o', model: 'gpt-4o' },
  gemini: { label: 'Gemini 1.5 Pro', model: 'gemini-1.5-pro' },
  elevenlabs: { label: 'ElevenLabs', gen: true },
  higgsfield: { label: 'Higgsfield', gen: true },
}
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1)

// Flattens conversation history into a single prompt string (the adapters take
// one prompt). Optional video analysis is injected as leading context.
function buildPrompt(history, videoContext) {
  const lines = []
  if (videoContext) {
    lines.push(`[Context from an uploaded video]\n${videoContext}\n`)
  }
  const turns = history.filter((m) => m.role === 'user' || m.role === 'assistant')
  for (const m of turns) {
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
  }
  lines.push('Assistant:')
  return lines.join('\n')
}

// Converts an adapter response into a chat message for the client.
function toMessage(result, { modelLabel, stage } = {}) {
  return {
    role: 'assistant',
    content: result.content || '',
    model: result.model,
    modelLabel,
    stage,
    ...(result.media ? { media: result.media, mediaType: result.type } : {}),
    ...(result.toolSteps?.length ? { toolSteps: result.toolSteps } : {}),
  }
}

// Builds the MCP toolset for a user: Anthropic-format tool defs plus a router
// that executes a tool call against the right connector. Only the Claude
// adapter uses these; other adapters ignore the extra args.
async function buildMcpToolset(userId, connectorIds) {
  let connectors = await getEnabledConnectors(userId)
  // Per-chat selection: if the client sent a list, only use those connectors.
  if (Array.isArray(connectorIds)) {
    connectors = connectors.filter((c) => connectorIds.includes(c.id))
  }
  const tools = []
  const routeMap = new Map()
  const permMap = new Map()
  for (const c of connectors) {
    for (const t of c.tools || []) {
      tools.push({
        name: t.name,
        description: t.description || '',
        input_schema: t.inputSchema || { type: 'object', properties: {} },
      })
      routeMap.set(t.name, { url: c.url, token: c.token, authProvider: c.authProvider })
      permMap.set(t.name, c.toolPerms?.[t.name] || 'allow')
    }
  }
  // Merge native (first-party) tools — e.g. YouTube — for connected providers.
  const native = await buildNativeToolset(userId)
  for (const t of native.tools) tools.push(t)

  const permissionFor = (name) => permMap.get(name) || 'allow'
  // Returns { content, media? } — content is text for the model, media (if any)
  // is a generated image/audio/video to surface in the chat.
  const onToolCall = async (name, input) => {
    if (native.has(name)) return { content: await native.run(name, input) }
    const target = routeMap.get(name)
    if (!target) return { content: `No connector provides tool "${name}".` }
    const r = await callMcpTool({
      url: target.url,
      token: target.token,
      authProvider: target.authProvider,
      name,
      args: input,
    })
    const content = r.text || (r.media ? 'Generated media (shown below).' : JSON.stringify(r.raw || {}))
    return { content, media: r.media || null }
  }
  return { tools, onToolCall, permissionFor }
}

// Runs a chat-capable model (claude/openai/gemini) by id, with optional MCP
// tools, attachments (images/PDF), and web search.
async function runChatModel(modelId, userId, { prompt, history, systemPrompt, mcp, attachments, webSearch, permissionFor, resume, sessionId, projectPath, signal }) {
  const info = getModelById(modelId)
  if (!info) throw new Error(`Unknown model: ${modelId}`)
  const result = await runTool(info.provider, userId, {
    prompt,
    history,
    systemPrompt,
    model: info.apiModel,
    tools: mcp?.tools,
    onToolCall: mcp?.onToolCall,
    attachments,
    webSearch,
    permissionFor,
    resume,
    sessionId,
    projectPath,
    signal,
  })
  return { result, label: info.label }
}

// POST /api/chat
// Manual: { history, modelA, modelB, pipeline, systemPrompt, videoContext }
// Auto:   { history, auto:true, systemPrompt, videoContext }
//
// Two ways to get the answer back:
// - `async: true` -> responds immediately with { jobId }; the client polls
//   GET /api/chat/jobs/:id until it's done. This is what the web client uses:
//   Vercel's proxy to this backend kills any single request at ~120s
//   (measured), and the CPU-bound local model regularly needs longer than
//   that for real answers / multi-step tool use. Short poll requests never
//   get near that limit, no matter how long generation takes.
// - Otherwise the reply is returned in the same response (kept for API users
//   and older clients).
router.post('/', async (req, res, next) => {
  const controller = new AbortController()
  if (req.body?.async) {
    const job = createJob(req.user.id, controller)
    handleChat(req.user.id, req.body, controller.signal)
      .then((result) => completeJob(job, result))
      .catch((err) => failJob(job, err))
    return res.json({ jobId: job.id })
  }
  // If the client gives up (closes the tab, retries, navigates away), stop
  // generating instead of burning CPU on a request nobody's waiting for.
  req.on('close', () => controller.abort())
  try {
    res.json(await handleChat(req.user.id, req.body, controller.signal))
  } catch (err) {
    if (err.name === 'AbortError') return // client disconnected — nothing to respond to
    next(err)
  }
})

// GET /api/chat/jobs/:id — poll an async chat job.
router.get('/jobs/:id', (req, res) => {
  const job = touchJob(req.params.id, req.user.id)
  if (!job) {
    return res.status(404).json({ error: 'That request has expired — please resend your message.' })
  }
  if (job.status === 'running') return res.json({ status: 'running' })
  res.json({ status: job.status, result: job.result, error: job.error })
})

async function handleChat(userId, body, signal) {
  const {
    history = [],
    modelA = 'claude-sonnet',
    modelB = null,
    pipeline = false,
    systemPrompt = '',
    videoContext = null,
    auto = false,
    attachments = [],
    webSearch = false,
    connectorIds = null,
    sessionId = null,
    projectPath = null,
  } = body || {}

  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  const userText = lastUser?.content?.trim() || ''
  const basePrompt = buildPrompt(history, videoContext)

  // MCP tools the user has connected + enabled (used by the Claude adapter).
  const mcp = await buildMcpToolset(userId, connectorIds)
  const extra = { attachments, webSearch, sessionId, projectPath, signal }
  {

    // ---------- AUTO (intent router) MODE ----------
    if (auto) {
      const connections = await listConnections(userId)
      // A tool is available if the user connected it OR the platform key is set.
      const connectedTools = connections
        .filter((c) => c.connected || c.platform)
        .map((c) => c.provider)

      const { decision, source, error } = await routeIntent({
        userMessage: userText,
        connectedTools,
        anthropicKey: await getProviderKey(userId, 'claude'),
      })

      const required = [decision.primary_tool]
      if (decision.pipeline && decision.secondary_tool) required.push(decision.secondary_tool)
      const missing = required.filter((t) => !connectedTools.includes(t))
      const routing = { ...decision, source, ...(error ? { error } : {}) }

      if (missing.length > 0) {
        const names = missing.map((t) => TOOL_META[t]?.label || titleCase(t))
        return ({
          routing,
          messages: [
            {
              role: 'assistant',
              routingBlocked: true,
              content: [
                `🔌 To handle this (**${decision.task}**) I need ${names
                  .map((n) => `**${n}**`)
                  .join(' and ')} connected.`,
                '',
                `Add your ${names.join(' and ')} ${names.length > 1 ? 'keys' : 'key'} in **Connections**, then try again.`,
              ].join('\n'),
            },
          ],
        })
      }

      const messages = []
      const chain = [{ tool: decision.primary_tool, stage: decision.pipeline ? 'analyst' : undefined }]
      if (decision.pipeline && decision.secondary_tool) {
        chain.push({ tool: decision.secondary_tool, stage: 'executor' })
      }

      let priorOutput = null
      for (const step of chain) {
        const meta = TOOL_META[step.tool]
        try {
          let result
          if (meta.gen) {
            // Generation tool (elevenlabs / higgsfield).
            const genPrompt = priorOutput
              ? `${userText}\n\nUse this as the script/brief:\n${priorOutput}`
              : userText
            result = await runTool(step.tool, userId, { prompt: genPrompt })
          } else {
            const prompt = priorOutput
              ? `${basePrompt}\n\n[Analysis from the previous step]\n${priorOutput}`
              : basePrompt
            const r = await runChatModel(meta.model, userId, { prompt, systemPrompt, mcp, ...extra })
            result = r.result
            priorOutput = result.content
          }
          messages.push(toMessage(result, { modelLabel: meta.label, stage: step.stage }))
        } catch (e) {
          if (e.name === 'AbortError') throw e
          messages.push({
            role: 'assistant',
            error: true,
            stage: step.stage,
            modelLabel: meta.label,
            content: `⚠️ ${meta.label}: ${e.message}`,
          })
          break
        }
      }
      return ({ routing, messages })
    }

    // ---------- MANUAL MODE ----------
    const usePipeline = Boolean(modelB && pipeline)
    const messages = []

    if (usePipeline) {
      // Model A = analyst.
      let analysis = null
      try {
        const a = await runChatModel(modelA, userId, {
          prompt: `${basePrompt}\n\n(Act as an analyst: break down the request and prepare concise notes for an executor model.)`,
          systemPrompt,
          mcp,
          ...extra,
        })
        analysis = a.result.content
        messages.push(toMessage(a.result, { modelLabel: a.label, stage: 'analyst' }))
      } catch (e) {
        if (e.name === 'AbortError') throw e
        const label = getModelById(modelA)?.label || modelA
        return ({
          messages: [{ role: 'assistant', error: true, modelLabel: label, content: `⚠️ ${label}: ${e.message}` }],
        })
      }
      // Model B = executor, using A's analysis.
      try {
        const b = await runChatModel(modelB, userId, {
          prompt: `${basePrompt}\n\n[Analyst notes]\n${analysis}\n\n(Act as the executor: produce the final answer.)`,
          systemPrompt,
          mcp,
        })
        messages.push(toMessage(b.result, { modelLabel: b.label, stage: 'executor' }))
      } catch (e) {
        if (e.name === 'AbortError') throw e
        const label = getModelById(modelB)?.label || modelB
        messages.push({ role: 'assistant', error: true, modelLabel: label, stage: 'executor', content: `⚠️ ${label}: ${e.message}` })
      }
      return ({ messages })
    }

    // Single model (supports per-tool approval pauses).
    try {
      const r = await runChatModel(modelA, userId, {
        prompt: basePrompt, history, systemPrompt, mcp, ...extra, permissionFor: mcp.permissionFor,
      })
      if (r.result?.pending) {
        const pendingId = savePending({
          userId: userId, modelId: modelA, systemPrompt, webSearch, connectorIds,
          resumeState: r.result.resumeState, pendingTools: r.result.pendingTools,
        })
        return ({
          messages: [{ role: 'approval', pendingId, modelLabel: r.label, tools: r.result.pendingTools }],
        })
      }
      messages.push(toMessage(r.result, { modelLabel: r.label }))
    } catch (e) {
      if (e.name === 'AbortError') throw e
      const label = getModelById(modelA)?.label || modelA
      messages.push({ role: 'assistant', error: true, modelLabel: label, content: `⚠️ ${label}: ${e.message}` })
    }
    return { messages }
  }
}

// POST /api/chat/resume — continue a paused turn after the user decides on
// approval-required tools. Body: { pendingId, decisions: { toolUseId: 'approve'|'deny' } }
router.post('/resume', async (req, res, next) => {
  try {
    const { pendingId, decisions = {} } = req.body || {}
    const pend = takePending(pendingId)
    if (!pend || pend.userId !== req.user.id) {
      return res.status(400).json({ error: 'This approval expired — please resend your message.' })
    }

    const mcp = await buildMcpToolset(pend.userId, pend.connectorIds)

    // Combine the already-run auto tools with the user's decisions.
    const results = [...(pend.resumeState.autoResults || [])]
    let media = pend.resumeState.media || null
    for (const t of pend.pendingTools) {
      if ((decisions[t.id] || 'deny') === 'approve') {
        let content = '', isError = false
        try {
          let res = await mcp.onToolCall(t.name, t.input)
          if (typeof res === 'string') res = { content: res }
          content = res.content
          if (res.media) media = res.media
        } catch (e) {
          content = `Tool error: ${e.message}`
          isError = true
        }
        results.push({ type: 'tool_result', tool_use_id: t.id, content: String(content ?? ''), ...(isError ? { is_error: true } : {}) })
      } else {
        results.push({ type: 'tool_result', tool_use_id: t.id, content: 'The user denied permission to run this tool.', is_error: true })
      }
    }

    const r = await runChatModel(pend.modelId, pend.userId, {
      systemPrompt: pend.systemPrompt,
      mcp,
      webSearch: pend.webSearch,
      permissionFor: mcp.permissionFor,
      resume: { messages: pend.resumeState.messages, results, media },
    })

    if (r.result?.pending) {
      const nextId = savePending({
        userId: pend.userId, modelId: pend.modelId, systemPrompt: pend.systemPrompt,
        webSearch: pend.webSearch, connectorIds: pend.connectorIds,
        resumeState: r.result.resumeState, pendingTools: r.result.pendingTools,
      })
      return res.json({ messages: [{ role: 'approval', pendingId: nextId, modelLabel: r.label, tools: r.result.pendingTools }] })
    }
    res.json({ messages: [toMessage(r.result, { modelLabel: r.label })] })
  } catch (err) {
    next(err)
  }
})

export default router

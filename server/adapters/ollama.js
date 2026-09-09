// Adapter for models served by a local Ollama instance — including the user's
// OWN fine-tuned model (`nexus-mine`), imported from the Colab fine-tune. Ollama
// exposes an HTTP API on :11434; no API key is needed (it's local).
// Use 127.0.0.1 (not "localhost"): on Windows, Node resolves localhost to IPv6
// ::1 first, but Ollama listens on IPv4 only, so "localhost" fails to connect.
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS, executeAgentTool, extractToolCallsFromText } from '../lib/agentLoop.js'
import { getComputeStatus } from '../lib/computeManager.js'

// Some Ollama-fronting proxies return `error` as an object ({message, type})
// instead of a plain string. `new Error(object)` stringifies it to the
// useless "[object Object]" — always reduce it to real text first.
function errorText(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value.message || value.error || JSON.stringify(value)
  return String(value)
}

function resolveTargetUrl(model) {
  const status = getComputeStatus()
  if (status.mode === 'turbo') {
    return status.activeUrl // http://127.0.0.1:11435
  }
  return status.hostingerUrl || 'http://127.0.0.1:11434'
}

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  parts.push(AGENT_SYSTEM_PROMPT)
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// { prompt, history, systemPrompt, skills, model, sessionId, projectPath, userId } -> normalized response with toolSteps
export async function run({ prompt, history, systemPrompt, skills, model, sessionId, projectPath, userId }) {
  const targetUrl = resolveTargetUrl(model)
  const isRunpod = targetUrl.includes('11435')
  const system = composeSystem(systemPrompt, skills)
  const messages = []
  if (system) messages.push({ role: 'system', content: system })

  if (Array.isArray(history) && history.length > 0) {
    for (const h of history) {
      if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
        messages.push({ role: h.role, content: h.content })
      }
    }
  } else if (prompt) {
    messages.push({ role: 'user', content: prompt })
  }

  const toolSteps = []
  const MAX_STEPS = 6
  let finalContent = ''

  for (let step = 0; step < MAX_STEPS; step++) {
    let resp
    try {
      resp = await fetch(`${targetUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'nexus-mine',
          messages,
          tools: AGENT_TOOLS,
          stream: false,
        }),
      })
    } catch (e) {
      const cause = e.cause?.code || e.cause?.message || ''
      const targetDesc = isRunpod ? `Runpod GPU Ollama tunnel at ${targetUrl}` : `local Ollama at ${targetUrl}`
      throw new Error(
        `Can't reach ${targetDesc}. Is the SSH tunnel / Ollama active? (${e.message}${cause ? ' / ' + cause : ''})`
      )
    }

    if (!resp.ok) {
      let msg = `Ollama returned ${resp.status}`
      try {
        const j = await resp.json()
        if (j.error) msg = errorText(j.error)
      } catch {}
      throw new Error(msg)
    }

    const data = await resp.json()
    const msg = data.message || {}
    const rawContent = msg.content || ''
    finalContent = rawContent

    // 1. Check for native tool calls from Ollama
    let detectedCalls = []
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.name) {
          detectedCalls.push({
            name: tc.function.name,
            args: tc.function.arguments || {},
          })
        }
      }
    }

    // 2. Check for freeform/JSON tool calls in text if native was empty
    if (detectedCalls.length === 0) {
      detectedCalls = extractToolCallsFromText(rawContent)
    }

    // If no tool calls, the model is done!
    if (detectedCalls.length === 0) {
      break
    }

    // Execute the tool calls
    messages.push({ role: 'assistant', content: rawContent })

    for (const call of detectedCalls) {
      try {
        const result = await executeAgentTool({
          name: call.name,
          args: call.args,
          sessionId,
          projectPath,
          userId,
        })

        toolSteps.push({
          tool: call.name,
          args: call.args,
          ok: result.ok,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          target: result.target || 'sandbox',
        })

        // Give observation back to the model
        const outputSummary = result.stdout
          ? result.stdout
          : result.stderr
            ? `(Error: ${result.stderr})`
            : '(command succeeded with no stdout)'

        const obs = `[Tool Execution: ${call.name} on ${result.target || 'sandbox'}]\nExit Code: ${result.exitCode}\nOutput:\n${outputSummary}`
        messages.push({ role: 'user', content: obs })
      } catch (err) {
        toolSteps.push({
          tool: call.name,
          args: call.args,
          ok: false,
          exitCode: 1,
          stderr: err.message,
          target: 'error',
        })
        messages.push({
          role: 'user',
          content: `[Tool Execution Failed: ${call.name}]\nError: ${err.message}`,
        })
      }
    }
  }

  return {
    ok: true,
    provider: 'ollama',
    type: 'text',
    content: finalContent,
    model: dataModel(model),
    toolSteps,
  }
}

function dataModel(m) {
  return m || 'nexus-mine'
}

// Reachability + list of installed Ollama models (merges local + Runpod GPU).
export async function health() {
  const models = []
  let reachable = false
  const status = getComputeStatus()
  const urls = [status.activeUrl, status.hostingerUrl, 'http://127.0.0.1:11435'].filter(Boolean)
  for (const url of [...new Set(urls)]) {
    try {
      const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) {
        reachable = true
        const j = await r.json()
        models.push(...(j.models || []).map((m) => m.name))
      }
    } catch {}
  }
  return { reachable, models: [...new Set(models)] }
}

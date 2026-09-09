// Adapter for models served by a local Ollama instance — including the user's
// OWN fine-tuned model (`nexus-mine`), imported from the Colab fine-tune. Ollama
// exposes an HTTP API on :11434; no API key is needed (it's local).
// Use 127.0.0.1 (not "localhost"): on Windows, Node resolves localhost to IPv6
// ::1 first, but Ollama listens on IPv4 only, so "localhost" fails to connect.
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS, WEB_SEARCH_AGENT_TOOL, executeAgentTool, extractToolCallsFromText } from '../lib/agentLoop.js'
import { getComputeStatus } from '../lib/computeManager.js'
import { hasBraveKey } from '../lib/webSearch.js'
import { withDocuments, imageAttachments } from '../lib/attachments.js'

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

// { prompt, history, systemPrompt, skills, model, sessionId, projectPath, userId, signal, webSearch, attachments } -> normalized response with toolSteps
export async function run({ prompt, history, systemPrompt, skills, model, sessionId, projectPath, userId, signal, webSearch, attachments, onProgress = () => {} }) {
  const targetUrl = resolveTargetUrl(model)
  const agentTools = webSearch && hasBraveKey() ? [...AGENT_TOOLS, WEB_SEARCH_AGENT_TOOL] : AGENT_TOOLS
  const isRunpod = targetUrl.includes('11435')
  // Chat requests run as background jobs the client polls (routes/chat.js),
  // so there's no proxy timeout to squeeze under any more. This budget is
  // purely about not leaving someone staring at a spinner forever on the
  // CPU-only box (~5 tok/s): keep going while the answer is genuinely
  // unfinished, but cap the whole turn at a few minutes.
  // A real build (install + write dozens of files + run it) is a long turn.
  // On the GPU the cap is only a backstop against a runaway loop — the user
  // has a Stop button and abandoned jobs get aborted — so it's generous.
  const WALL_CLOCK_BUDGET_MS = (isRunpod ? 60 : 10) * 60 * 1000
  // This model tends to produce long hidden "thinking" before its actual
  // answer. num_predict bounds a single call so one runaway generation can't
  // eat the whole budget; Turbo (30-65 tok/s) gets a much higher ceiling.
  // Hitting the cap doesn't lose the rest of the answer — see the
  // continuation loop below.
  // A tool call that writes files counts against this too: at 3000 the model's
  // "write the whole app in one command" calls got truncated mid-JSON, the
  // call was lost, and the turn ended in a "cut short" note.
  const numPredict = isRunpod ? 12000 : 900
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

  // Attachments belong to the latest user turn: images ride along as Ollama
  // `images` (the Qwen/vision models read them directly), PDFs as extracted
  // text in the message body.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  if (lastUser && attachments?.length) {
    lastUser.content = withDocuments(lastUser.content, attachments)
    const images = imageAttachments(attachments).map((a) => a.base64)
    if (images.length) lastUser.images = images
  }

  const toolSteps = []
  // Model round-trips per turn (tool rounds + continuations). Six was enough
  // for "run this script"; building a project is dozens of tool calls, and
  // cutting the loop there is exactly what made the agent stop and narrate
  // "next I'll…" instead of finishing. The wall-clock budget is the real cap.
  const MAX_STEPS = 60
  let autoContinues = 0
  let finalContent = ''
  // Loop guards: a model that re-issues the exact same tool call, or keeps
  // ending on the exact same "Now the core libraries:" text, is stuck — no
  // amount of "yes, continue" fixes that. Refuse to re-run duplicates and
  // stop nudging once the text repeats.
  const seenCalls = new Map()
  const seenTexts = new Set()
  const requestStart = Date.now()

  for (let step = 0; step < MAX_STEPS; step++) {
    let resp
    try {
      resp = await fetch(`${targetUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'nexus-mine',
          messages,
          tools: agentTools,
          stream: false,
          options: { num_predict: numPredict },
        }),
        signal,
      })
    } catch (e) {
      if (e.name === 'AbortError') throw e // client disconnected — stop, don't burn CPU on a dead request
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

    if (detectedCalls.length === 0) {
      finalContent += rawContent
      const elapsed = Date.now() - requestStart
      const hasBudget = elapsed < WALL_CLOCK_BUDGET_MS - 15000
      // The model did real work this turn and then stopped to ask permission
      // ("Should I build it now?") or announced a next step without doing it.
      // The user already asked for the task — answer for them and keep going,
      // a bounded number of times, so the job doesn't stall waiting on a "yes".
      const textKey = rawContent.trim().slice(0, 300)
      if (toolSteps.length && looksUnfinished(rawContent) && seenTexts.has(textKey)) {
        finalContent += '\n\n*(stopped — the agent kept repeating this same step without making progress. Check what was actually written and tell it exactly what to do next.)*'
        break
      }
      seenTexts.add(textKey)
      if (toolSteps.length && hasBudget && autoContinues < 4 && looksUnfinished(rawContent)) {
        autoContinues++
        onProgress({ type: 'text', text: rawContent })
        messages.push({ role: 'assistant', content: rawContent })
        messages.push({ role: 'user', content: 'Yes. Continue and complete the entire task now without asking again — execute the remaining steps, verify the result, then report what was done.' })
        continue
      }
      // num_predict cut the answer off mid-thought rather than the model
      // choosing to stop. Ask it to keep going instead of showing a
      // truncated reply — as long as there's still wall-clock budget left.
      const truncated = data.done_reason === 'length'
      if (truncated && (!hasBudget || step === MAX_STEPS - 1)) {
        finalContent += '\n\n*(stopped here — this turn ran out of time; send "continue" and it will pick up where it left off)*'
        break
      }
      if (!truncated) break
      messages.push({ role: 'assistant', content: rawContent })
      // In an agentic turn the thing that got truncated is almost always an
      // oversized tool call (one command writing many files). Continuing the
      // cut-off text would just produce unparseable JSON — redo it smaller.
      messages.push({
        role: 'user',
        content: toolSteps.length
          ? 'Your last message was cut off because it was too long — the tool call in it was lost and did NOT run. Do not continue the cut-off text. Redo that work as several smaller tool calls (write 1–2 files per call, keep each call well under 150 lines), then carry on with the task.'
          : 'Continue your previous answer exactly where you left off. Do not repeat or restate anything already said.',
      })
      continue
    }

    // Execute the tool calls
    finalContent = rawContent
    if (rawContent.trim()) onProgress({ type: 'text', text: rawContent })
    messages.push({ role: 'assistant', content: rawContent })

    for (const call of detectedCalls) {
      const callKey = call.name + ' ' + JSON.stringify(call.args)
      const times = (seenCalls.get(callKey) || 0) + 1
      seenCalls.set(callKey, times)
      if (times > 2) {
        const step = { tool: call.name, args: call.args, ok: false, exitCode: 1, stderr: 'Refused: this exact call has already run twice in this turn.', target: 'loop-guard' }
        toolSteps.push(step)
        onProgress({ type: 'tool', ...step })
        messages.push({ role: 'user', content: `[Tool Execution Refused: ${call.name}]\nYou already ran this exact call twice — it will not be run again. It did not achieve what you expected. Check the actual state with ls/cat, then do the NEXT step differently.` })
        continue
      }
      try {
        const result = await executeAgentTool({
          name: call.name,
          args: call.args,
          sessionId,
          projectPath,
          userId,
          // Everything the user has typed in this chat — pasted tokens are picked up from here.
          chatText: messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n'),
        })

        const step = {
          tool: call.name,
          args: call.args,
          ok: result.ok,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          target: result.target || 'sandbox',
        }
        toolSteps.push(step)
        onProgress({ type: 'tool', ...step, stdout: step.stdout.slice(0, 2000), stderr: step.stderr.slice(0, 2000) })

        // Give observation back to the model
        const outputSummary = result.stdout
          ? result.stdout
          : result.stderr
            ? `(Error: ${result.stderr})`
            : '(command succeeded with no stdout)'

        const obs = `[Tool Execution: ${call.name} on ${result.target || 'sandbox'}]\nExit Code: ${result.exitCode}\nOutput:\n${outputSummary}`
        messages.push({ role: 'user', content: obs })
      } catch (err) {
        const step = { tool: call.name, args: call.args, ok: false, exitCode: 1, stderr: err.message, target: 'error' }
        toolSteps.push(step)
        onProgress({ type: 'tool', ...step })
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

// A turn that ends by asking the user whether to proceed, or by announcing
// what it will do next ("Now let me build out the files:") without a tool
// call, is not a finished task.
export function looksUnfinished(text = '') {
  const t = text.trim()
  if (!t) return false
  // Ends by asking permission.
  if (/\b(should|shall|would you like|do you want|want me to|may i|can i|ready for me to|let me know if (you'?d like|you want|i should))\b[^?]{0,120}\?\s*$/i.test(t.slice(-400))) return true
  // Ends on a colon: "Now let me build out the files:" — announced, not done.
  if (/:\s*$/.test(t)) return true
  // Last sentence announces an action it never took ("Let me check what was
  // created and start building." — but not "Let me know if you need more").
  const last = t.split(/(?<=[.!])\s+/).pop() || ''
  return /\b(let me(?! know)|i'?ll|i will|i'?m going to|i am going to|next,? (i|we)|now (let'?s|i'?ll|we'?ll)|let'?s)\b/i.test(last)
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

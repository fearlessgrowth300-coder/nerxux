// Adapter for models served by a local Ollama instance — including the user's
// OWN fine-tuned model (`nexus-mine`), imported from the Colab fine-tune. Ollama
// exposes an HTTP API on :11434; no API key is needed (it's local).
// Use 127.0.0.1 (not "localhost"): on Windows, Node resolves localhost to IPv6
// ::1 first, but Ollama listens on IPv4 only, so "localhost" fails to connect.
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS, WEB_SEARCH_AGENT_TOOL, executeAgentTool, extractToolCallsFromText } from '../lib/agentLoop.js'
import { toOpenAITools, AGENT_TOOL_NAMES, observationText, toStep } from '../lib/agentTools.js'
import { agentStatePrompt, verificationFooter } from '../lib/agentState.js'
import { createToolRecovery } from '../lib/toolRecovery.js'
import { fitMessages } from '../lib/fitContext.js'
import { getComputeStatus, ensureTurboReady } from '../lib/computeManager.js'
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

// Ollama's own wording when the tool call it received will not parse.
const MALFORMED_TOOL_CALL = /XML syntax error|unexpected end element|invalid character|unmarshal|failed to parse tool/i

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
// `tools` / `onToolCall` carry the connected MCP + native tools (Higgsfield,
// YouTube, …). Without them the local models were the only ones that couldn't
// use a connector: the API models got the full toolset and Qwen got none.
export async function run({ prompt, history, systemPrompt, skills, model, sessionId, projectPath, userId, signal, webSearch, attachments, tools = [], onToolCall = null, onProgress = () => {} }) {
  const targetUrl = resolveTargetUrl(model)
  const externalTools = toOpenAITools(tools)
  const externalNames = new Set(tools.map((t) => t.name))
  const agentTools = [
    ...(webSearch && hasBraveKey() ? [...AGENT_TOOLS, WEB_SEARCH_AGENT_TOOL] : AGENT_TOOLS),
    ...externalTools,
  ]
  const isRunpod = targetUrl.includes('11435')
  // Rebuild a dead tunnel BEFORE sending, rather than discovering it is dead
  // by waiting out a five-minute timeout on a request that could never land.
  if (isRunpod) await ensureTurboReady()
  // Chat requests run as background jobs the client polls (routes/chat.js),
  // so there's no proxy timeout to squeeze under any more. This budget is
  // purely about not leaving someone staring at a spinner forever on the
  // CPU-only box (~5 tok/s): keep going while the answer is genuinely
  // unfinished, but cap the whole turn at a few minutes.
  // A real build (install + write dozens of files + run it) is a long turn.
  // On the GPU the cap is only a backstop against a runaway loop — the user
  // has a Stop button and abandoned jobs get aborted — so it's generous.
  const WALL_CLOCK_BUDGET_MS = (isRunpod ? 60 : 25) * 60 * 1000
  // This model tends to produce long hidden "thinking" before its actual
  // answer. num_predict bounds a single call so one runaway generation can't
  // eat the whole budget; Turbo (30-65 tok/s) gets a much higher ceiling.
  // Hitting the cap doesn't lose the rest of the answer — see the
  // continuation loop below.
  // A tool call that writes files counts against this too: at 3000 the model's
  // "write the whole app in one command" calls got truncated mid-JSON, the
  // call was lost, and the turn ended in a "cut short" note.
  // Always On was left at 900 — a THIRD of the 3000 that was already proven
  // too small above. A write_file carrying a real file cannot fit in 900
  // tokens, so the call was cut mid-emission and Ollama's tool parser
  // rejected the fragment ("XML syntax error ... unexpected end element").
  const numPredict = isRunpod ? 12000 : 3000
  // The model supports far more, but Ollama defaults it to 32,768 — which a
  // build conversation crosses, after which EVERY message in that chat fails
  // with "exceeds the available context size". 64k is verified to fit on the
  // A40 alongside the weights. The CPU box stays small on purpose: it reads at
  // ~23 tok/s, so a 64k prompt there would be three quarters of an hour.
  const numCtx = isRunpod ? 65536 : 16384
  // What is left for the conversation once the answer's budget is set aside.
  const promptBudget = numCtx - numPredict - 1500
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
  // Every image/video/audio a connector produced this turn, in order, so a
  // "make me 4 images" turn shows all four instead of only the last one.
  const mediaOut = []
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
  const recovery = createToolRecovery()
  const seenTexts = new Set()
  const requestStart = Date.now()
  let parseRetries = 0
  let tunnelRetries = 0

  // Set when the loop ends on a real answer. If it instead runs out of rounds or
  // wall-clock while still working, nothing has summarised the turn — the reply
  // was an empty card over dozens of tool actions. See the wrap-up after the loop.
  let finished = false

  for (let step = 0; step < MAX_STEPS; step++) {
    // The budget check used to live only on the text-answer path, so a model
    // that kept calling tools ran straight past it — one turn went 84 minutes.
    if (Date.now() - requestStart > WALL_CLOCK_BUDGET_MS) break
    messages[0].content = system + '\n\n' + await agentStatePrompt(userId, sessionId)
    let resp
    try {
      resp = await fetch(`${targetUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'nexus-mine',
          // Re-fitted every round: a long turn keeps appending tool output, so
          // a conversation that fitted at the start need not fit by step 40.
          messages: fitMessages(messages, promptBudget).messages,
          tools: agentTools,
          stream: false,
          options: { num_predict: numPredict, num_ctx: numCtx },
        }),
        signal,
      })
    } catch (e) {
      if (e.name === 'AbortError') throw e // client disconnected — stop, don't burn CPU on a dead request
      const cause = e.cause?.code || e.cause?.message || ''
      // The tunnel was checked before the turn started, but a build is dozens
      // of round-trips over many minutes and the tunnel can die in the middle
      // of one — a dropped SSH connection, or the server being restarted by a
      // deploy. Throwing here threw away everything done so far. Rebuild and
      // retry the same step instead.
      if (isRunpod && tunnelRetries < 3) {
        tunnelRetries++
        onProgress({ type: 'text', text: `(reconnecting to the GPU — attempt ${tunnelRetries})` })
        const back = await ensureTurboReady()
        if (back) {
          step--
          continue
        }
      }
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
      // Ollama could not parse the tool call the model emitted — almost always
      // a call cut off part-way, leaving an unclosed element. Losing the whole
      // turn to that is wrong when asking for a smaller call usually works.
      if (MALFORMED_TOOL_CALL.test(msg)) {
        // Ollama rejects the call and does NOT hand back what the model wrote,
        // so the malformed text itself is unrecoverable here. Record the shape
        // of the request instead — never its content, which routinely holds
        // credentials the user pasted.
        console.error('[nexus-ai] tool-call parse failure:', JSON.stringify({
          error: msg.slice(0, 200),
          target: isRunpod ? 'turbo' : 'always_on',
          model: model || 'nexus-mine',
          step,
          numPredict,
          toolsOffered: agentTools.length,
          messagesInContext: messages.length,
          approxPromptChars: messages.reduce((n, m) => n + (m.content?.length || 0), 0),
        }))
      }
      if (MALFORMED_TOOL_CALL.test(msg) && parseRetries < 2) {
        parseRetries++
        messages.push({
          role: 'user',
          content: 'Your last tool call was cut off before it finished, so it could not be read and did NOT run. ' +
            'Do not repeat it as-is. Redo it as a smaller call — write ONE file, and if the file is long, ' +
            'write it in several successive calls rather than one large one.',
        })
        continue
      }
      throw new Error(
        MALFORMED_TOOL_CALL.test(msg)
          ? `The model kept producing a tool call too long to complete${isRunpod ? '' : ' on the Always On box'}. ` +
            'Ask for one smaller step at a time' + (isRunpod ? '' : ', or switch to Turbo for file-writing work') + '.'
          : msg
      )
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
        finished = true
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
        finished = true
        break
      }
      if (!truncated) {
        finished = true
        break
      }
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
      const callKey = call.name + ' ' + JSON.stringify(call.args)
      const times = (seenCalls.get(callKey) || 0) + 1
      seenCalls.set(callKey, times)
      // Reads are how the agent recovers from a stale edit. They are bounded
      // by the turn budget, not by a lifetime cap of two reads per file.
      const isRead = ['read_file', 'list_files', 'search_files'].includes(call.name)
      if (times > 2 && !isRead) {
        const step = { tool: call.name, args: call.args, ok: false, exitCode: 1, stderr: 'Refused: this exact call has already run twice in this turn.', target: 'loop-guard' }
        toolSteps.push(step)
        onProgress({ type: 'tool', ...step })
        messages.push({ role: 'user', content: `[Tool Execution Refused: ${call.name}]\nYou already ran this exact call twice — it will not be run again. It did not achieve what you expected. Check the actual state with ls/cat, then do the NEXT step differently.` })
        continue
      }
      try {
        // A connected MCP / native tool (image + video generation, YouTube, …).
        // These don't run in the sandbox — they're remote calls — so they take
        // the caller's router instead of executeAgentTool.
        // Route by what it is NOT: a connector tool discovered mid-turn via
        // find_connector_tools will not be in the offered list, but it is still
        // callable — the caller's router knows every connector tool.
        if (onToolCall && (externalNames.has(call.name) || !AGENT_TOOL_NAMES.has(call.name))) {
          const res = await onToolCall(call.name, call.args)
          for (const m of res?.mediaList?.length ? res.mediaList : res?.media ? [res.media] : []) {
            mediaOut.push(m)
            onProgress({ type: 'media', media: m })
          }
          const step = { tool: call.name, args: call.args, ok: true, exitCode: 0, stdout: String(res?.content ?? '').slice(0, 4000), stderr: '', target: 'connector' }
          toolSteps.push(step)
          onProgress({ type: 'tool', ...step })
          messages.push({ role: 'user', content: `[Tool Execution: ${call.name} on connector]\n${res?.content ?? '(no output)'}` })
          continue
        }
        const result = await executeAgentTool({
          name: call.name,
          args: call.args,
          sessionId,
          projectPath,
          userId,
          // Everything the user has typed in this chat — pasted tokens are picked up from here.
          chatText: messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n'),
        })

        const step = toStep(call.name, call.args, result)
        toolSteps.push(step)
        onProgress({ type: 'tool', ...step, stdout: step.stdout.slice(0, 2000), stderr: step.stderr.slice(0, 2000) })

        // A test rerun after a patch is new work, even with identical args.
        if (result.ok && ['write_file', 'edit_file'].includes(call.name)) seenCalls.clear()
        // Always include stderr: a script can print progress before throwing.
        const obs = observationText(call.name, result) + recovery(call.name, result)
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

  // The turn ran out of rounds or time while still working. Its last message
  // was a tool call, so there was no reply at all — the chat showed a bare
  // "Model Executed 76 Tool Actions" card and the user could not tell whether
  // anything had been done. Ask for a short account of the state, without
  // tools, and always say plainly that the turn was cut off.
  if (!finished && !signal?.aborted) {
    let summary = ''
    try {
      const r = await fetch(`${targetUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'nexus-mine',
          messages: fitMessages([
            ...messages,
            {
              role: 'user',
              content:
                'This turn has used its whole step budget and must stop NOW. Do not call any tools. ' +
                'In a few short lines tell the user: what you completed (name the files you changed), ' +
                'what you verified and how, and what is still left to do.',
            },
          ], promptBudget).messages,
          stream: false,
          options: { num_predict: 1500, num_ctx: numCtx },
        }),
        signal,
      })
      if (r.ok) summary = String((await r.json()).message?.content || '').trim()
    } catch {}
    const n = toolSteps.length
    const note = `*(stopped after ${n} tool action${n === 1 ? '' : 's'} — the limit for one turn was reached before the work was finished. Send "continue" and it will pick up from here.)*`
    finalContent = [summary || finalContent.trim(), note].filter(Boolean).join('\n\n')
  }

  if (toolSteps.some(s => AGENT_TOOL_NAMES.has(s.tool) && s.tool !== 'web_search')) {
    finalContent += await verificationFooter(userId, sessionId)
  }
  return {
    ok: true,
    provider: 'ollama',
    type: mediaOut.length ? mediaOut[0].type : 'text',
    content: finalContent,
    model: dataModel(model),
    toolSteps,
    ...(mediaOut.length ? { media: mediaOut[0], mediaList: mediaOut } : {}),
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

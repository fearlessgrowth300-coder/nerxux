// Adapter for models served by a local Ollama instance — including the user's
// OWN fine-tuned model (`nexus-mine`), imported from the Colab fine-tune. Ollama
// exposes an HTTP API on :11434; no API key is needed (it's local).
// Use 127.0.0.1 (not "localhost"): on Windows, Node resolves localhost to IPv6
// ::1 first, but Ollama listens on IPv4 only, so "localhost" fails to connect.
import { Agent } from 'undici'
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS, WEB_SEARCH_AGENT_TOOL, executeAgentTool, extractToolCallsFromText } from '../lib/agentLoop.js'
import { toOpenAITools, AGENT_TOOL_NAMES, observationText, toStep } from '../lib/agentTools.js'
import { createCompletionCheck, finishAgentResponse } from '../lib/agentCompletion.js'
import { redactToolData } from '../lib/redact.js'
import { agentStateParts } from '../lib/agentState.js'
import { createToolRecovery } from '../lib/toolRecovery.js'
import { fitMessages, estimateTokens } from '../lib/fitContext.js'
import { fitTurn } from '../lib/compactTurn.js'
import { alwaysOnUsesOpenAI, postOpenAIChat, openAIModels } from '../lib/llamaServerChat.js'
import { getComputeStatus, ensureTurboReady, takeFallbackReason } from '../lib/computeManager.js'
import { hasBraveKey } from '../lib/webSearch.js'
import { withDocuments, imageAttachments } from '../lib/attachments.js'
import { watchReadProgress } from '../lib/ollamaReadProgress.js'

// Some Ollama-fronting proxies return `error` as an object ({message, type})
// instead of a plain string. `new Error(object)` stringifies it to the
// useless "[object Object]" — always reduce it to real text first.
function errorText(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return value.message || value.error || JSON.stringify(value)
  return String(value)
}

// Sent instead of the full project notes when they do not fit the context.
export const NOTES_POINTER = '\n\n# Project notes\nThis project has a NEXUS.md at its root (too large to include here). Read it with read_file before changing how the project is built, run or deployed.'

// Ollama's own wording when the tool call it received will not parse.
const MALFORMED_TOOL_CALL = /XML syntax error|unexpected end element|invalid character|unmarshal|failed to parse tool/i

// One chat request to the model server. Turbo and a default Always On speak
// Ollama's /api/chat; with ALWAYS_ON_API=openai, Always On is a llama-server and
// the request is translated both ways (lib/llamaServerChat.js), so everything
// after this call sees the same Ollama-shaped reply either way.
function postChat(targetUrl, body, signal, isRunpod) {
  if (!isRunpod && alwaysOnUsesOpenAI()) return postOpenAIChat(targetUrl, body, { signal })
  return fetch(`${targetUrl}/api/chat`, {
    dispatcher: OLLAMA_DISPATCHER,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

function resolveTargetUrl(model) {
  const status = getComputeStatus()
  if (status.mode === 'turbo') {
    return status.activeUrl // http://127.0.0.1:11435
  }
  return status.hostingerUrl || 'http://127.0.0.1:11434'
}

// Node's fetch gives up if response HEADERS have not arrived within 300 s.
// Ollama sends nothing until the whole prompt is read, and on the CPU box a
// cold 27B model plus a 4k-token prompt takes longer than that — so a
// perfectly healthy request came back as "Can't reach local Ollama /
// UND_ERR_HEADERS_TIMEOUT". No header timeout here; the turn's own
// wall-clock budget and the client's abort signal still bound it.
export const OLLAMA_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

// How long the model needs to READ a prompt before it can write anything.
// This model (qwen35, hybrid memory) cannot reuse the previous request's
// prompt cache — Ollama logs "forcing full prompt re-processing" on every
// request — so every agent step re-reads the whole conversation from zero.
// Always On (8-core EPYC, measured from the Ollama journal 2026-09-15):
// 4,096 tokens in 282 s, 21,196 tokens in 3,343 s (~56 min) — reading slows
// as the prompt grows, so the fit is quadratic. Turbo (A40): ~1,100 tok/s.
export function estimateReadSeconds(tokens, isRunpod) {
  if (isRunpod) return Math.ceil(tokens / 1000)
  return Math.ceil(0.0476 * tokens + 5.2e-6 * tokens * tokens)
}

// The no-tools summary at the end of a cut-off turn re-reads the whole
// conversation too. On Always On a long chat took 25+ minutes for it, so it is only
// sent when it can be read in about this long.
export const WRAPUP_MAX_READ_S = 480

// Time kept free for the model to WRITE its answer after reading. A step is
// only started when reading + this fits in what is left of the turn; a step
// that the limit cuts off mid-way throws away everything it read.
// Qwen3.6 35B-A3B writes ~15 tok/s on the VPS, so this covers ~2,700 tokens.
export const ALWAYS_ON_ANSWER_S = 180

// Most Always On sends in tokens (excluding tool definitions). The agent's
// fixed parts are ~7.8k (rules 3,048 + NEXUS.md 2,874 + record 1,592 + 256),
// leaving ~6k for recent conversation. Was the whole 32k window (~25k), which
// made every step on a long chat re-read ~24k tokens (~12 min).
export const ALWAYS_ON_PROMPT_TOKENS = 14000

// Default read_file length on Always On. A 400-line read is ~5k tokens — a
// third of the whole per-step budget — so one file pushed out everything else.
// The tool output says how many lines the file has, so the model can page on.
export const ALWAYS_ON_READ_LINES = 150

// Always On runs a faster model than Turbo. The dense 27B needs up to an hour
// per agent step on the VPS CPU; a mixture-of-experts model with ~3B active
// parameters does each step with a fraction of the compute. Turbo keeps the
// 27B. Only the 27B's names are swapped — any other model is sent as picked.
// Override with ALWAYS_ON_MODEL (e.g. back to the 27B) without a code change.
export const ALWAYS_ON_MODEL = process.env.ALWAYS_ON_MODEL || 'huihui_ai/Qwen3.6-abliterated:35b-a3b'
const BIG_QWEN = new Set([
  'orcarouter/Qwen3.8-27B-Uncensored:latest', 'orcarouter/Qwen3.8-27B-Uncensored',
  'qwen3.8-27b:latest', 'nexus-mine', 'nexus-mine:latest',
])
export function modelForTarget(model, isRunpod) {
  const m = model || 'nexus-mine'
  return !isRunpod && BIG_QWEN.has(m) ? ALWAYS_ON_MODEL : m
}

// estimateReadSeconds is fitted to the 27B. Other models read at their own
// speed, so the adapter learns a per-model scale from Ollama's own timings
// (prompt_eval_count / prompt_eval_duration on every response). Without this
// a faster model would be refused steps it can easily do.
// Starting scale measured on the VPS 2026-09-15: Qwen3.6-35B-A3B read a
// 4,179-token prompt in 65 s cold (19 s warm) vs ~309 s fitted for the 27B,
// and wrote at 15.4 tok/s (27B: 4.9). The cold figure is used; it learns from there.
const INITIAL_READ_SCALE = {
  'always_on|huihui_ai/Qwen3.6-abliterated:35b-a3b': 0.21,
}
const readScale = new Map()
const speedKey = (model, isRunpod) => `${isRunpod ? 'turbo' : 'always_on'}|${model}`
export function readSecondsFor(model, isRunpod, tokens) {
  const key = speedKey(model, isRunpod)
  return Math.ceil(estimateReadSeconds(tokens, isRunpod) * (readScale.get(key) ?? INITIAL_READ_SCALE[key] ?? 1))
}
export function learnReadSpeed(model, isRunpod, estimatedTokens, data) {
  const count = Number(data?.prompt_eval_count)
  const seconds = Number(data?.prompt_eval_duration) / 1e9
  // A small prompt, or one mostly served from cache, says nothing about a full read.
  if (!(count >= 500) || !(seconds > 0) || count < estimatedTokens * 0.5) return
  const scale = Math.min(3, Math.max(0.02, seconds / estimateReadSeconds(estimatedTokens, isRunpod)))
  const key = speedKey(model, isRunpod)
  const prev = readScale.get(key)
  readScale.set(key, prev ? (prev + scale) / 2 : scale)
}
export function resetReadSpeeds() { readScale.clear() }

// Reads an Ollama /api/chat reply. Requests stream, so the chat can show the
// model writing (tokens, its thinking) as it happens instead of minutes of
// silence; a single JSON body (test doubles, older proxies) still works.
// `onChunk({ content, thinking, chunks })` fires for every streamed piece.
export async function readChatResponse(resp, onChunk = () => {}) {
  if (!resp.body || typeof resp.body.getReader !== 'function') return resp.json()
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let thinking = ''
  let chunks = 0
  const toolCalls = []
  let last = {}
  let error = null
  const take = (line) => {
    if (!line.trim()) return
    let j
    try { j = JSON.parse(line) } catch { return }
    if (j.error) { error = j.error; return }
    const m = j.message || {}
    if (m.content) content += m.content
    if (m.thinking) thinking += m.thinking
    if (Array.isArray(m.tool_calls)) toolCalls.push(...m.tool_calls)
    chunks++
    last = j
    onChunk({ content, thinking, chunks })
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) take(line)
    if (error) break
  }
  if (!error) take(buf + decoder.decode())
  if (error) {
    reader.cancel().catch(() => {})
    return { error }
  }
  return {
    ...last,
    message: {
      ...(last.message || {}),
      role: 'assistant',
      content,
      ...(thinking ? { thinking } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
  }
}

const tail = (text, n = 280) => { const t = String(text || '').trim(); return t.length > n ? '…' + t.slice(-n) : t }

const fmtMinutes = (s) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`)

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
  const emitProgress = onProgress
  onProgress = event => emitProgress(redactToolData(event))
  let targetUrl = resolveTargetUrl(model)
  const externalTools = toOpenAITools(tools)
  const externalNames = new Set(tools.map((t) => t.name))
  const agentTools = [
    ...(webSearch && hasBraveKey() ? [...AGENT_TOOLS, WEB_SEARCH_AGENT_TOOL] : AGENT_TOOLS),
    ...externalTools,
  ]
  // Rebuild a dead tunnel BEFORE sending, rather than discovering it is dead
  // by waiting out a five-minute timeout on a request that could never land.
  // If the pod itself is gone (out of credit, exited), ensureTurboReady has
  // already switched to Always On: run the turn there instead of failing it.
  const fallbackNote = () => `(Turbo is unavailable — ${takeFallbackReason() || 'the GPU pod is not running'}. Continuing on Always On, which is slower.)`
  if (targetUrl.includes('11435') && !(await ensureTurboReady())) {
    targetUrl = resolveTargetUrl(model)
    onProgress({ type: 'text', text: fallbackNote() })
  }
  let isRunpod = targetUrl.includes('11435')
  // Chat requests run as background jobs the client polls (routes/chat.js),
  // so there's no proxy timeout to squeeze under any more. This budget is
  // purely about not leaving someone staring at a spinner forever on the
  // CPU-only box (~5 tok/s): keep going while the answer is genuinely
  // unfinished, but cap the whole turn at a few minutes.
  // A real build (install + write dozens of files + run it) is a long turn.
  // On the GPU the cap is only a backstop against a runaway loop — the user
  // has a Stop button and abandoned jobs get aborted — so it's generous.
  // Always On was 25 min, but with each step re-reading the whole chat
  // (~12 min on a 22k-token chat, 2026-09-15) that allowed ONE step per
  // "continue" and cut the second one off at 88% read — pure waste. The step
  // pre-check below stops a turn cleanly instead of letting the limit cut it.
  const WALL_CLOCK_BUDGET_MS = 60 * 60 * 1000
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
  let numPredict = isRunpod ? 12000 : 3000
  // The model supports far more, but Ollama defaults it to 32,768 — which a
  // build conversation crosses, after which EVERY message in that chat fails
  // with "exceeds the available context size". 64k is verified to fit on the
  // A40 alongside the weights. The CPU box was held at 16k, but the agent's fixed
  // parts alone (rules ~3k, tool definitions ~4k, NEXUS.md ~3k, execution record
  // ~1.5k, reply 3k) left ~700 tokens for the conversation, and any message that
  // pulled in connector tools failed with "Instructions and tool definitions
  // exceed this model context". 32k fits in RAM with the box's Ollama set to
  // flash attention + q8_0 KV cache (~4 GB beside the 17 GB weights). This model
  // does NOT reuse the prompt cache between steps (see estimateReadSeconds), so
  // every step re-reads all of it — the turn budget, not the window, is what
  // keeps a long Always On chat from running for hours.
  const ALWAYS_ON_CTX = 32768
  let numCtx = isRunpod ? 65536 : ALWAYS_ON_CTX
  // What is left for the conversation once the answer's budget is set aside.
  const toolTokens = estimateTokens(JSON.stringify(agentTools))
  // Always On re-reads everything it is sent on every step, so what it is sent
  // is capped well below the window: the fixed parts (rules, NEXUS.md, the
  // execution record) always go in, and older conversation is trimmed first.
  // Continuity comes from the record and the files, not from old chat turns.
  const budgetFor = () => Math.min(numCtx - numPredict - toolTokens - 512, isRunpod ? Infinity : ALWAYS_ON_PROMPT_TOKENS)
  let promptBudget = budgetFor()
  // Set when the budget shrinks mid-turn, so the system prompt is re-checked
  // against the new, smaller window on the next step.
  let rewriteSystem = false
  // The pod can die in the middle of a long build. Move the rest of the turn to
  // Always On with that box's limits instead of discarding the work done so far.
  // The wall-clock budget is kept as it was: shrinking it mid-turn would end a
  // turn that was already past 25 minutes on the spot.
  const fallBackToAlwaysOn = () => {
    targetUrl = resolveTargetUrl(model)
    isRunpod = false
    numPredict = 3000
    numCtx = ALWAYS_ON_CTX
    promptBudget = budgetFor()
    rewriteSystem = true
    onProgress({ type: 'text', text: fallbackNote() })
  }
  const system = composeSystem(systemPrompt, skills)
  const beforeFinish = createCompletionCheck(userId, sessionId)
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
  // The request this turn is working on: never dropped when the turn is trimmed.
  const request = lastUser || null
  // Tool-output message -> what produced it, so old outputs can be shrunk to a
  // one-line note instead of disappearing (see compactTurn.js).
  const obsMeta = new WeakMap()
  // read_file calls already answered this turn, and what the last step sent,
  // for the repeat-read guard below.
  const readsDone = new Map()
  let lastSent = new Set()
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
  // Set when a single model request ran into the wall-clock budget and was
  // cancelled. The budget used to be checked only BETWEEN steps, so one step
  // that took 63 minutes on Always On ran straight past a 25-minute budget.
  let timedOut = false
  // The model actually sent (Always On swaps the 27B for ALWAYS_ON_MODEL).
  let usedModel = modelForTarget(model, isRunpod)

  for (let step = 0; step < MAX_STEPS; step++) {
    // The budget check used to live only on the text-answer path, so a model
    // that kept calling tools ran straight past it — one turn went 84 minutes.
    if (Date.now() - requestStart > WALL_CLOCK_BUDGET_MS) break
    // Ollama reuses the prefix of the previous request byte-for-byte; the
    // execution record changes after every tool call, so writing it into the
    // system prompt (message 0) made every step re-read the whole conversation
    // — 83 s per step at 32k tokens on 2x T4, minutes on the CPU box. The
    // system prompt now holds only the stable parts (rules + project notes,
    // read once per turn); the live record rides at the END as its own message.
    const state = await agentStateParts(userId, sessionId)
    const record = { role: 'user', content: state.record }
    const recordTokens = estimateTokens(record)
    if (step === 0 || rewriteSystem) {
      rewriteSystem = false
      messages[0].content = system + state.notes
      // NEXUS.md can be ~3k tokens. If the fixed parts would not fit this
      // window, send a pointer to the file instead of failing the message.
      if (state.notes && estimateTokens(messages[0]) + recordTokens + 256 > promptBudget) {
        messages[0].content = system + NOTES_POINTER
      }
    }
    if (estimateTokens(messages[0]) + recordTokens + 256 > promptBudget) throw new Error('Instructions and tool definitions exceed this model context. Reduce injected notes/connectors or use a larger context.')
    // Re-fitted every round: a long turn keeps appending tool output, so
    // a conversation that fitted at the start need not fit by step 40.
    const fitted = fitTurn(messages, promptBudget - recordTokens, { request, obsMeta }).messages
    lastSent = new Set(fitted)
    const stepMessages = [...fitted, record]
    const promptTokens = stepMessages.reduce((n, m) => n + estimateTokens(m), 0) + estimateTokens(JSON.stringify(agentTools))
    const sendModel = modelForTarget(model, isRunpod)
    usedModel = sendModel
    const readSeconds = readSecondsFor(sendModel, isRunpod, promptTokens)
    const remainingMs = WALL_CLOCK_BUDGET_MS - (Date.now() - requestStart)
    // Don't start a step that cannot even be read in the time left: it would
    // run for up to an hour and then be thrown away. Say why, plainly.
    if (!isRunpod && (readSeconds + ALWAYS_ON_ANSWER_S) * 1000 > remainingMs) {
      const n = toolSteps.length
      finalContent = [
        finalContent.trim(),
        `*(stopped — on Always On this chat is about ${Math.round(promptTokens / 1000)}k tokens, which takes the CPU about ${fmtMinutes(readSeconds)} to read (plus up to ${fmtMinutes(ALWAYS_ON_ANSWER_S)} to answer), ` +
        `and only ${fmtMinutes(Math.max(0, remainingMs / 1000))} of this turn's ${WALL_CLOCK_BUDGET_MS / 60000}-minute limit is left` +
        `${n ? ` (${n} tool action${n === 1 ? '' : 's'} done so far)` : ''}. ` +
        'Switch to Turbo (it reads this in under a minute), or start a new chat with a shorter request.)*',
      ].filter(Boolean).join('\n\n')
      finished = true
      break
    }
    if (readSeconds > 90) {
      onProgress({ type: 'text', text: `(${isRunpod ? 'Turbo' : 'Always On'} is reading about ${Math.round(promptTokens / 1000)}k tokens — roughly ${fmtMinutes(readSeconds)} before it can reply${isRunpod ? '' : '. Turbo reads this in under a minute'}.)` })
    }
    // The budget also bounds the request itself, not only the gap between requests.
    const deadline = AbortSignal.timeout(Math.max(1000, remainingMs))
    // Live status for the chat card: what the model is doing right now. It
    // replaces the previous status rather than piling up in the activity log.
    const target = isRunpod ? 'Turbo' : 'Always On'
    const readStart = Date.now()
    const status = (extra) => onProgress({ type: 'status', target, step: step + 1, promptTokens, ...extra })
    status({ phase: 'reading', startedAt: readStart, estSeconds: readSeconds })
    // Always On: the real read progress from Ollama's own log (see ollamaReadProgress.js).
    const stopWatch = isRunpod ? () => {} : watchReadProgress((p) => {
      status({ phase: 'reading', startedAt: readStart, estSeconds: readSeconds, read: { ...p, at: Date.now() } })
    })
    let writeStart = 0
    let lastStatusAt = 0
    const onChunk = ({ content, thinking, chunks }) => {
      const now = Date.now()
      if (!writeStart) { writeStart = now; stopWatch() }
      if (now - lastStatusAt < 1000) return
      lastStatusAt = now
      const secs = (now - writeStart) / 1000
      status({
        phase: 'writing',
        startedAt: writeStart,
        readSeconds: Math.round((writeStart - readStart) / 1000),
        tokens: chunks,
        tokPerSec: secs > 0.5 ? Math.round((chunks / secs) * 10) / 10 : null,
        thinking: content ? '' : tail(thinking),
        text: tail(content),
      })
    }
    let resp
    let data
    try {
      resp = await postChat(targetUrl, {
        model: sendModel,
        messages: stepMessages,
        tools: agentTools,
        stream: true,
        options: { num_predict: numPredict, num_ctx: numCtx },
      }, signal ? AbortSignal.any([signal, deadline]) : deadline, isRunpod)
      if (resp.ok) data = await readChatResponse(resp, onChunk)
    } catch (e) {
      stopWatch()
      if (signal?.aborted) throw e // client disconnected — stop, don't burn CPU on a dead request
      if (deadline.aborted) { timedOut = true; break }
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
        if (getComputeStatus().mode !== 'turbo') {
          fallBackToAlwaysOn()
          step--
          continue
        }
      }
      const onLlamaServer = !isRunpod && alwaysOnUsesOpenAI()
      const targetDesc = isRunpod ? `Runpod GPU Ollama tunnel at ${targetUrl}` : onLlamaServer ? `the Always On llama-server at ${targetUrl}` : `local Ollama at ${targetUrl}`
      throw new Error(
        `Can't reach ${targetDesc}. ${onLlamaServer ? 'Is the llama-server service running?' : 'Is the SSH tunnel / Ollama active?'} (${e.message}${cause ? ' / ' + cause : ''})`
      )
    }

    stopWatch()
    if (!resp.ok || data?.error) {
      let msg = data?.error ? errorText(data.error) : `Ollama returned ${resp.status}`
      if (!data?.error) {
        try {
          const j = await resp.json()
          if (j.error) msg = errorText(j.error)
        } catch {}
      }
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
          model: sendModel,
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

    learnReadSpeed(sendModel, isRunpod, promptTokens, data)
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
      const verificationRequest = toolSteps.length ? await beforeFinish() : null
      if (verificationRequest && data.done_reason !== 'length') {
        messages.push({ role: 'assistant', content: rawContent || 'Checking completion.' })
        messages.push({ role: 'user', content: verificationRequest })
        continue
      }
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
    const nativeCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
    messages.push({ role: 'assistant', content: rawContent, ...(nativeCalls ? { tool_calls: msg.tool_calls } : {}) })
    let currentArgs = {}
    const observe = (name, content) => {
      const m = nativeCalls ? { role: 'tool', tool_name: name, content: redactToolData(content) } : { role: 'user', content: redactToolData(content) }
      messages.push(m)
      const a = currentArgs || {}
      obsMeta.set(m, {
        name,
        path: a.path || (a.command ? '`' + String(a.command).split('\n')[0].slice(0, 60) + '`' : ''),
        start: a.start,
        limit: a.limit,
        chars: String(m.content || '').length,
      })
      return m
    }

    for (const call of detectedCalls) {
      if (call.name === 'read_file' && !isRunpod && call.args && call.args.limit == null) {
        call.args = { ...call.args, limit: ALWAYS_ON_READ_LINES }
      }
      currentArgs = call.args
      status({ phase: 'tool', tool: call.name, args: Object.fromEntries(Object.entries(call.args || {}).map(([k, v]) => [k, String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 200)])), startedAt: Date.now() })
      const callKey = call.name + ' ' + JSON.stringify(call.args)
      const times = (seenCalls.get(callKey) || 0) + 1
      seenCalls.set(callKey, times)
      // Reads are how the agent recovers from a stale edit. They are bounded
      // by the turn budget, not by a lifetime cap of two reads per file.
      const isRead = ['read_file', 'list_files', 'search_files', 'inspect_execution', 'job_status'].includes(call.name)
      if (times > 2 && !isRead) {
        const step = { tool: call.name, args: call.args, ok: false, exitCode: 1, stderr: 'Refused: this exact call has already run twice in this turn.', target: 'loop-guard' }
        toolSteps.push(step)
        onProgress({ type: 'tool', ...step })
        observe(call.name, `[Tool Execution Refused: ${call.name}] You already ran this call twice. Inspect the current state before changing your approach.`)
        continue
      }
      // The same lines of the same file, read again with nothing changed since:
      // the model lost track of it (see compactTurn.js). Re-reading only
      // pushes something else out, so say where the content is instead.
      const readKey = call.name === 'read_file' ? `${call.args?.path}|${call.args?.start || 1}|${call.args?.limit || 400}` : null
      if (readKey && readsDone.has(readKey)) {
        const visible = lastSent.has(readsDone.get(readKey))
        const why = visible
          ? `Its full content is already above in this conversation — use it and make your change now.`
          : `Its full text was removed from context to save space, and reading the whole file again would push out something else. Use search_files to find the exact lines you need, or read_file with start and limit for a range of at most 80 lines, then make your change.`
        const step = { tool: call.name, args: call.args, ok: false, exitCode: 1, stderr: 'Not re-read: this file was already read this turn and has not changed.', target: 'loop-guard' }
        toolSteps.push(step)
        onProgress({ type: 'tool', ...step })
        observe(call.name, `[read_file not run: you already read ${call.args?.path} (same lines) earlier in this turn and it has not changed since. ${why}]`)
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
          observe(call.name, `[Tool Execution: ${call.name} on connector]\n${res?.content ?? '(no output)'}`)
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
        // Anything that can change files makes earlier reads stale.
        if (['write_file', 'edit_file', 'execute_command'].includes(call.name)) readsDone.clear()
        // Always include stderr: a script can print progress before throwing.
        const obs = observationText(call.name, result) + recovery(call.name, result)
        const observed = observe(call.name, obs)
        if (readKey && result.ok) readsDone.set(readKey, observed)
      } catch (err) {
        const step = { tool: call.name, args: call.args, ok: false, exitCode: 1, stderr: err.message, target: 'error' }
        toolSteps.push(step)
        onProgress({ type: 'tool', ...step })
        observe(call.name, `[Tool Execution Failed: ${call.name}]\nError: ${err.message}`)
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
    const wrapMessages = fitMessages([
      ...messages,
      {
        role: 'user',
        content:
          'This turn has used its whole step budget and must stop NOW. Do not call any tools. ' +
          'In a few short lines tell the user: what you completed (name the files you changed), ' +
          'what you verified and how, and what is still left to do.',
      },
    ], promptBudget).messages
    const wrapTokens = wrapMessages.reduce((n, m) => n + estimateTokens(m), 0)
    // Only when it is quick: on Always On this summary re-read the whole
    // conversation and kept the user waiting another half hour for a note.
    if (readSecondsFor(modelForTarget(model, isRunpod), isRunpod, wrapTokens) <= WRAPUP_MAX_READ_S) {
      try {
        const wrapDeadline = AbortSignal.timeout((WRAPUP_MAX_READ_S + 180) * 1000)
        const r = await postChat(targetUrl, {
          model: modelForTarget(model, isRunpod),
          messages: wrapMessages,
          stream: false,
          options: { num_predict: 1500, num_ctx: numCtx },
        }, signal ? AbortSignal.any([signal, wrapDeadline]) : wrapDeadline, isRunpod)
        if (r.ok) summary = String((await r.json()).message?.content || '').trim()
      } catch {}
    }
    const n = toolSteps.length
    const why = timedOut
      ? `this turn hit its ${WALL_CLOCK_BUDGET_MS / 60000}-minute limit while the model was still ${isRunpod ? 'working' : 'reading/answering on Always On'}`
      : 'the limit for one turn was reached before the work was finished'
    const tip = !isRunpod && timedOut ? ' Switching to Turbo makes each step many times faster.' : ''
    const note = `*(stopped after ${n} tool action${n === 1 ? '' : 's'} — ${why}. Send "continue" and it will pick up from here.${tip})*`
    finalContent = [summary || finalContent.trim(), note].filter(Boolean).join('\n\n')
  }

  const completion = toolSteps.some(s => AGENT_TOOL_NAMES.has(s.tool) && !['web_search', 'read_web_page'].includes(s.tool))
    ? await finishAgentResponse(finalContent, userId, sessionId) : { content: finalContent }
  return {
    ok: true,
    provider: 'ollama',
    type: mediaOut.length ? mediaOut[0].type : 'text',
    content: redactToolData(completion.content),
    verificationStatus: completion.verificationStatus,
    model: usedModel,
    toolSteps: redactToolData(toolSteps),
    ...(mediaOut.length ? { media: mediaOut[0], mediaList: mediaOut } : {}),
  }
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
      if (url === status.hostingerUrl && alwaysOnUsesOpenAI()) {
        models.push(...await openAIModels(url))
        reachable = true
        continue
      }
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

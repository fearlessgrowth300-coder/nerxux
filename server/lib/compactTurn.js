import { fitMessages, estimateTokens, truncateMiddle } from './fitContext.js'

// Always On gets ~14k tokens per step. Three 300-line files fill that, and
// fitMessages then dropped whole messages oldest-first — the file read two
// steps ago, then the user's request itself. The model forgot what it had
// read, read it again (pushing out something else), and one real turn spent
// 50 minutes on ten reads of the same four files without writing a line.
//
// Two changes, applied only when the turn does not fit:
// 1. Older tool outputs are shrunk to a one-line note (the newest few stay
//    whole), so the model still knows WHAT it did, just not every byte of it.
// 2. The request being worked on is never dropped — shortened if it must be.

export const KEEP_RECENT_OBSERVATIONS = 2
// The pinned request may take at most this share of the budget.
const REQUEST_SHARE = 0.3
const PINNED_PREFIX = '[The request you are working on in this turn — kept here because older messages were left out]\n'

export function observationStub(meta) {
  const what = meta.path ? `${meta.name} ${meta.path}` : meta.name
  const range = meta.name === 'read_file' ? ` (lines ${meta.start || 1}-${(meta.start || 1) + (meta.limit || 400) - 1})` : ''
  const hint = meta.name === 'read_file'
    ? ' You already saw this file; do not read the whole file again. If you need exact text to edit, use search_files or read_file with a small start/limit range.'
    : ''
  return `[Earlier ${what}${range}: output (${meta.chars} chars) removed to save space.${hint}]`
}

/**
 * @param {Array} messages  system prompt first, then the conversation and this turn's steps
 * @param {number} budget   token budget for all of it
 * @param {object} opts
 * @param {object} [opts.request]  the message holding the user's request for this turn (by identity)
 * @param {WeakMap} [opts.obsMeta] tool-observation message -> { name, path, start, limit, chars }
 * @returns {{ messages: Array, dropped: number, stubbed: Set }}
 */
export function fitTurn(messages, budget, { request = null, obsMeta = new WeakMap(), keepRecent = KEEP_RECENT_OBSERVATIONS } = {}) {
  const total = (list) => list.reduce((n, m) => n + estimateTokens(m), 0)
  let list = messages
  const stubbed = new Set()

  // Measure what this turn itself needs: the system prompt, the request and
  // the steps after it. Older chat before the request is what fitMessages
  // drops first anyway; counting it here would shrink outputs for nothing.
  const reqAt = request ? list.indexOf(request) : -1
  const turnSize = () => (list[0]?.role === 'system' ? estimateTokens(list[0]) : 0) +
    (reqAt >= 0 ? total(list.slice(reqAt)) : total(list.filter((m) => m.role !== 'system')))
  if (total(list) > budget && turnSize() > budget) {
    const observations = list.filter((m) => obsMeta.has(m))
    list = [...list]
    // Shrink oldest first: down to the newest `keepRecent`, and if the turn
    // still does not fit, down to only the newest one. A note that survives
    // beats a full output that pushes every other note out.
    for (const floor of [keepRecent, 1]) {
      for (const original of observations.slice(0, Math.max(0, observations.length - floor))) {
        if (turnSize() <= budget) break
        if (stubbed.has(original)) continue
        list[list.indexOf(original)] = { ...original, content: observationStub(obsMeta.get(original)) }
        stubbed.add(original)
      }
    }
  }

  let fit = fitMessages(list, budget)
  if (request && list.includes(request) && !fit.messages.includes(request)) {
    const cap = Math.max(200, Math.floor(budget * REQUEST_SHARE))
    const pinned = {
      ...request,
      content: PINNED_PREFIX + (estimateTokens(request) > cap ? truncateMiddle(String(request.content || ''), cap) : request.content),
    }
    fit = fitMessages(list.filter((m) => m !== request), budget - estimateTokens(pinned))
    const at = (fit.messages[0]?.role === 'system' ? 1 : 0) + (fit.dropped > 0 ? 1 : 0)
    fit.messages.splice(at, 0, pinned)
  }
  return { messages: fit.messages, dropped: fit.dropped, stubbed }
}

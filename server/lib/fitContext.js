// A conversation is sent to the model in full on every message, and nothing
// ever trimmed it. So a build chat grew until it crossed the context window and
// then failed permanently:
//
//   request (32789 tokens) exceeds the available context size (32768 tokens)
//
// Twenty-one tokens over, and every further message in that chat was dead.
// Raising the window only moves the cliff; the conversation has to be made to
// fit whatever window it is given.

// Deliberately pessimistic: code and JSON pack fewer characters per token than
// prose, and under-estimating is what puts a request over the edge.
const CHARS_PER_TOKEN = 3.2
// An image is not free — it becomes a block of vision tokens.
const TOKENS_PER_IMAGE = 1300

export function estimateTokens(message) {
  if (typeof message === 'string') return Math.ceil(message.length / CHARS_PER_TOKEN)
  const text = Math.ceil(String(message?.content || '').length / CHARS_PER_TOKEN)
  const images = (message?.images?.length || 0) * TOKENS_PER_IMAGE
  return text + images
}

function truncateMiddle(text, budgetTokens) {
  const max = Math.max(200, budgetTokens * CHARS_PER_TOKEN)
  if (text.length <= max) return text
  const half = Math.floor((max - 80) / 2)
  return text.slice(0, half) + '\n\n… [trimmed to fit the context window] …\n\n' + text.slice(-half)
}

/**
 * Reduce a message list to fit `budget` tokens, keeping the system prompt and
 * the most recent turns — which is where the current task lives.
 * @returns {{ messages: Array, dropped: number, estimated: number }}
 */
export function fitMessages(messages, budget) {
  const system = messages[0]?.role === 'system' ? messages[0] : null
  const rest = system ? messages.slice(1) : messages

  // Reserve room for the notice added below when anything is dropped —
  // budgeting first and appending after is how a fit ends up over budget.
  const NOTICE_TOKENS = 60
  let remaining = budget - (system ? estimateTokens(system) : 0) - NOTICE_TOKENS
  const kept = []

  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokens(rest[i])
    if (cost <= remaining) {
      kept.unshift(rest[i])
      remaining -= cost
      continue
    }
    // The newest message alone overflows — keep it, shortened, rather than
    // sending nothing at all.
    if (!kept.length && remaining > 100) {
      kept.unshift({ ...rest[i], content: truncateMiddle(String(rest[i].content || ''), remaining) })
      remaining = 0
    }
    break
  }

  const dropped = rest.length - kept.length
  const out = system ? [system] : []
  if (dropped > 0) {
    out.push({
      role: 'user',
      content:
        `[${dropped} earlier message${dropped === 1 ? '' : 's'} from this conversation ` +
        'were left out to fit the context window. Work from what follows; ask if you need ' +
        'something from earlier.]',
    })
  }
  const final = [...out, ...kept]
  return { messages: final, dropped, estimated: final.reduce((n, m) => n + estimateTokens(m), 0) }
}

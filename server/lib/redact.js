// Tool output is stored in the conversation and shown in the chat, so anything
// it prints is permanent. A model that runs `env` — a perfectly ordinary thing
// to do while orienting itself — dumped GITHUB_TOKEN and the GIT_CONFIG_*
// rewrite (which embeds the same token) straight into the transcript.
//
// Redaction is not a substitute for not pasting credentials into chat, but it
// stops the harness from re-publishing them on the user's behalf.

const PATTERNS = [
  [/\brpa_[A-Za-z0-9_-]{16,}/g, 'rpa_***'],
  [/\bghp_[A-Za-z0-9]{20,}/g, 'ghp_***'],            // GitHub personal access
  [/\bgho_[A-Za-z0-9]{20,}/g, 'gho_***'],            // GitHub OAuth
  [/\bghs_[A-Za-z0-9]{20,}/g, 'ghs_***'],            // GitHub server-to-server
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'], // GitHub fine-grained
  [/\bvcp_[A-Za-z0-9]{20,}/g, 'vcp_***'],            // Vercel
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***'],    // Anthropic
  [/\bsk-(?:(?:proj|admin|svcacct)-)?[A-Za-z0-9_-]{20,}/g, 'sk-***'], // OpenAI
  [/\bgsk_[A-Za-z0-9]{20,}/g, 'gsk_***'],            // Groq
  [/\bAIza[A-Za-z0-9_-]{30,}/g, 'AIza***'],          // Google
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],   // Slack
  [/\bBSA[A-Za-z0-9_-]{20,}/g, 'BSA***'],            // Brave Search
  // A JWT — Supabase anon/service keys are these.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'eyJ***'],
  // Credentials embedded in a URL: https://user:pass@host
  [/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/g, '$1***:***@'],
  // https://x-access-token:TOKEN@github.com, which the git rewrite uses
  [/(https?:\/\/)[^/@\s]+@/g, '$1***@'],
  // Header dumps, including credentials without a provider-specific prefix.
  [/\b((?:proxy-)?authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s"',;]+/gi, '$1***'],
  [/\b(x-api-key\s*[:=][ \t]*)[^\s"',;]+/gi, '$1***'],
]

const SECRET_FIELD = /^(?:[a-z0-9]+[_-])*(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|service[_-]?role[_-]?key|encryption[_-]?key|private[_-]?key|cookie|set[_-]?cookie)$/i

/**
 * Replaces credential-shaped strings in text destined for the transcript.
 * @param {string} text
 * @param {string[]} extra  exact secrets known to this request (the live token)
 */
export function redactSecrets(text, extra = []) {
  if (!text) return text
  let out = String(text)
  // Known-exact values first: they may not match any pattern.
  for (const secret of extra) {
    if (typeof secret === 'string' && secret.length >= 12) {
      out = out.split(secret).join('***')
    }
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement)
  // Structured config dumps also contain passwords with no recognizable prefix.
  out = out.replace(/(["']([^"']+)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
    (match, prefix, key) => SECRET_FIELD.test(key) ? `${prefix}"***"` : match)
  out = out.replace(/^(\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ENCRYPTION_KEY)[A-Z0-9_]*\s*=).+$/gm, '$1***')
  return out
}

export function redactToolData(value) {
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map(redactToolData)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_FIELD.test(k) ? '***' : redactToolData(v)]))
  return value
}

import { redactSecrets } from './redact.js'

// Only copy diagnostic metadata into operational logs. SDK error objects can
// contain request bodies, prompts, cookies and authorization headers.
const ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR'])

export function errorStatus(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status : 500
}

export function logErrorSummary(event, error, logger = console) {
  const summary = { event, status: errorStatus(error) }
  if (ERROR_CODES.has(error?.code)) summary.code = error.code
  logger.error('[nexus-ai]', summary)
}

export function safeErrorMessage(error, fallback = 'Request failed', env = process.env) {
  // Body parsers may quote only a fragment of a submitted credential, which
  // cannot reliably be recognized by full-key patterns or exact-value matching.
  if (error?.type === 'entity.parse.failed') return 'The request body is not valid JSON.'
  const message = typeof error?.message === 'string' && error.message ? error.message : fallback
  const secrets = Object.entries(env)
    .filter(([key]) => /(?:KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL)/i.test(key))
    .map(([, value]) => value)
  // Redact before limiting length: clipping first can leave a partial secret.
  return redactSecrets(message, secrets).slice(0, 2000)
}

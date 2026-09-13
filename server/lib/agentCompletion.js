import { readAgentState, verificationFooter } from './agentState.js'
import { redactSecrets } from './redact.js'

export async function completionStatus(userId, sessionId) {
  const s = await readAgentState(userId, sessionId)
  const checks = s.checks.filter(c => c.revision === s.revision)
  // Only FILE changes call for a verification record. Counting every command
  // meant "what is in this folder?" -> ls -> the reply came back stamped
  // "Work is not verified complete", which is noise, not rigor.
  const changed = (s.changes || []).length > 0
  const verified = changed && checks.some(c => c.ok) && !checks.some(c => !c.ok) && !s.inFlight && s.gateAfter === null && !(s.jobs || []).some(j => j.status === 'running')
  return { changed, verified, needsVerification: changed && !verified, revision: s.revision }
}

export function createCompletionCheck(userId, sessionId) {
  // Two nudges per REVISION, not per turn. In the live smoke test the model
  // spent its nudges early, then edited its test after a failed check and
  // reported done without re-running it — and the gate had nothing left to
  // say. New edits mean the old checks are stale and a fresh ask is due.
  let requests = 0, revision = null
  return async () => {
    const status = await completionStatus(userId, sessionId)
    if (status.revision !== revision) { revision = status.revision; requests = 0 }
    if (!status.needsVerification || requests++ >= 2) return null
    return 'Before finishing, run verify_work against the actual requirement and inspect its result. ' +
      'There is no current complete verification record, or a failure/background job is unresolved. ' +
      'Use job_status for running work. Do not rewrite source merely to make an assertion pass. ' +
      'If verification is blocked, state the exact blocker and say the work is incomplete; do not claim success or a working public URL.'
  }
}

export async function finishAgentResponse(content, userId, sessionId) {
  const status = await completionStatus(userId, sessionId)
  const heading = status.needsVerification ? '**Work is not verified complete.** The model’s report below has not passed the required checks.\n\n' : ''
  // A read-only turn (orientation, a question answered with ls/cat) changed
  // nothing, so "Deployment is unverified" under it is noise. The footer is
  // for turns that changed files.
  const footer = status.changed ? await verificationFooter(userId, sessionId) : ''
  return { content: redactSecrets(heading + content + footer), verificationStatus: status.verified ? 'checks_passed' : status.changed ? 'unverified' : 'not_applicable' }
}

import os from 'node:os'
import { sandboxJob } from './sandboxJobs.js'
import { redactToolData } from './redact.js'
import path from 'node:path'
import { withAgentState, addEvidence, stateSummary, safeNote, evaluateAssertions } from './agentState.js'

const inspections = new Set(['read_file', 'list_files', 'search_files', 'web_search', 'read_web_page'])
const executions = new Set(['execute_command', 'run_code', 'run_on_pod', 'verify_work', 'restart_service', 'deploy_service', 'expose_site'])
// A shell command that cannot change the project's files must not bump the
// revision: every bump staled every passing check, so a mid-turn `cat`, `curl`
// or `git commit` forced a full re-proof (647 bumps in 1888 steps in one
// session, 30 in 47 in another). Conservative: after dropping harmless
// redirects (2>&1, >/dev/null) and leading VAR=value assignments, every
// &&/||/;/| segment must start with a read-only program (or a git subcommand
// that leaves the working tree alone, or a curl that neither writes nor
// sends a body). Anything unsure counts as a mutation.
const READ_ONLY = new Set(['cat', 'ls', 'pwd', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'stat', 'file', 'du', 'df', 'echo', 'which', 'date', 'ps', 'env', 'printenv', 'cd', 'sleep', 'sort', 'uniq', 'cut', 'tr', 'jq', 'ss', 'journalctl', 'uname', 'whoami', 'test', 'true', 'basename', 'dirname', 'seq', '[', '[['])
const GIT_SAFE = /^git\s+(?:-c\s+\S+\s+)*(status|log|diff|show|add|commit|push|fetch|remote|rev-parse|ls-files)\b/
const CURL_WRITES = /(^|\s)(-X\s*(?!GET\b|HEAD\b)\S+|--request\s+(?!GET\b|HEAD\b)\S+|-d|--data\S*|-F|--form\S*|-T|--upload-file|-O|--remote-name|--output-dir|-o\s+(?!\/dev\/null\b)\S+|--output\s+(?!\/dev\/null\b)\S+)/
export function blockingWord(cmd) {
  const BS = String.fromCharCode(92)
  let raw = String(cmd || '').split(BS + String.fromCharCode(10)).join(' ') // join line continuations
  // An escaped quote breaks the quote pairing below, so a quote could hide a command: unsure.
  if (raw.includes(BS + '"') || raw.includes(BS + "'")) return 'escaped quote'
  // $( ) runs even inside double quotes. Judge each innermost one by what it runs,
  // then replace it with a placeholder. Backticks and $(( )) stay "unsure".
  for (let m; (m = /\$\(([^()]*)\)/.exec(raw));) {
    const inner = blockingWord(m[1])
    if (inner !== null) return '$(' + inner + ')'
    raw = raw.replace(m[0], 'X')
  }
  if (/\$\(|`/.test(raw)) return '$(...)'
  // Quoted text is data: a "|", ";" or ">" inside a regex or a curl format string is not shell syntax.
  const c = raw.replace(/"[^"]*"|'[^']*'/g, '""').replace(/\d?>&\d|\d?>\s*\/dev\/null/g, '')
  if (!c.trim()) return 'empty'
  if (/>|-exec|-delete|\btee\b/.test(c)) return 'redirect/exec'
  for (const part of c.split(/&&|\|\||;|\n|\|/)) {
    let seg = part.trim().replace(/^(?:\w+=\S*\s*)+/, '').replace(/^(?:(?:do|then|else|elif|if|while|until)\b\s*|[({]\s*)+/, '')
    if (!seg || seg.startsWith('#') || /^(done|fi|esac)\b/.test(seg) || /^for\s+\w+\s+in\b/.test(seg)) continue
    const w = seg.split(/\s+/)[0]
    if (w === 'git') { if (!GIT_SAFE.test(seg)) return 'git ' + (seg.split(/\s+/)[1] || '') }
    else if (w === 'curl') { if (CURL_WRITES.test(seg)) return 'curl (writes/sends)' }
    else if (w === 'sed') { if (/(^|\s)(-[a-zA-Z]*i|--in-place)/.test(seg)) return 'sed -i' }
    else if (!READ_ONLY.has(w)) return w
  }
  return null
}
export const isReadOnlyCommand = (cmd) => blockingWord(cmd) === null
const ok = (stdout) => ({ ok: true, exitCode: 0, stdout, stderr: '', durationMs: 0 })
const fail = (stderr) => ({ ok: false, exitCode: 1, stdout: '', stderr, durationMs: 0 })
const normalizePath = (p) => {
  const v = typeof p === 'string' ? p.trim() : p && typeof p.path === 'string' ? p.path.trim() : ''
  if (!v) return null
  if (!v.startsWith('/') || /[\x00-\x1f]/.test(v)) throw new Error('projectPath must be an absolute Linux directory')
  return path.posix.normalize(v)
}

export async function controlledAgentTool(input, execute, transfer) {
  const { userId, sessionId, name, args = {} } = input
  return withAgentState(userId, sessionId, async (s, persist) => {
    const finish = (r) => {
      r = redactToolData(r)
      const event = addEvidence(s, name, args, r)
      return { ...r, evidenceId: event.id, context: { ...stateSummary(s), recentEvidence: undefined, checks: undefined } }
    }
    try {
      if (name === 'inspect_execution') return finish(ok(JSON.stringify(stateSummary(s), null, 2)))
      if (name === 'job_status' || name === 'stop_job') {
        const job = (s.jobs || []).find(j => j.id === args.jobId)
        if (!job) return finish(fail('Unknown job for this conversation. Use inspect_execution to find its job ID.'))
        const result = await sandboxJob({ sessionId, jobId: job.id, stop: name === 'stop_job', offset: args.offset })
        Object.assign(job, result.job)
        return finish(result)
      }
      if (name === 'record_progress') {
        s.nextStep = safeNote(args.nextStep)
        return finish(ok('Next step saved. Completed changes and checks are tracked from actual tool results.'))
      }
      if (name === 'set_execution_context') {
        if (!['sandbox', 'pod'].includes(args.environment) || !String(args.reason || '').trim()) return finish(fail('Specify environment and the reason for changing it.'))
        const project = normalizePath(args.projectPath)
        if (args.environment === 'pod' && !project) return finish(fail('Pod execution requires an absolute working directory. Turbo inference alone does not require pod execution.'))
        const probe = await execute({ ...input, name: 'execute_command', args: { command: 'pwd -P', target: args.environment }, projectPath: project, executionEnvironment: args.environment })
        if (!probe.ok) return finish(probe)
        s.environment = args.environment
        s.projectPath = project
        s.contextSelected = true
        s.projectLocked = true
        s.revision++
        return finish(ok(`Execution context changed explicitly: ${args.environment}, ${project || '/workspace'}. Files have not been moved.`))
      }
      if (name === 'diagnose_failure') {
        // The first version of this gate demanded a precise form: a read_file
        // AND a command flagged purpose="diagnostic", both cited by evidence
        // id. A 27B model does not fill in forms: one turn spent 8 of 46
        // actions submitting the same correct diagnosis and being refused for
        // its shape. What the gate is FOR is "look before you patch again" —
        // so any fresh look (a read, or any command that ran) after the
        // failures is enough, and the ids are optional.
        if (s.gateAfter === null && !s.inFlight) return finish(ok('No diagnostic checkpoint is active; carry on.'))
        const ids = Array.isArray(args.evidenceIds) ? args.evidenceIds : []
        const fresh = s.events.filter(e => e.id > (s.gateAfter ?? 0) && (!ids.length || ids.includes(e.id)))
        const looked = fresh.some(e => (inspections.has(e.tool) && e.ok) || e.diagnostic || executions.has(e.tool))
        if (!looked) {
          return finish(fail('Before diagnosing, look at something fresh: read_file the failing source, or run one execute_command that shows the actual error. Then call diagnose_failure again with the cause.'))
        }
        if (String(args.cause || '').trim().length < 20 || String(args.nextCheck || '').trim().length < 5) {
          return finish(fail('State the observed cause in at least one full sentence (cause) and what you will run to confirm the fix (nextCheck).'))
        }
        s.gateAfter = null
        s.failures = 0
        s.inFlight = null
        s.nextStep = safeNote(args.nextCheck)
        return finish(ok('Diagnostic evidence recorded; one focused repair may proceed. The fix still needs verify_work.'))
      }

      const requestedProject = normalizePath(Object.hasOwn(args, 'projectPath') ? args.projectPath : s.contextSelected ? s.projectPath : s.projectPath || input.projectPath)
      if (Object.hasOwn(args, 'projectPath') || requestedProject) {
        if ((s.projectPath || s.projectLocked) && requestedProject !== s.projectPath) return finish(fail(`Project is locked to ${s.projectPath || '/workspace'}. Use set_execution_context with a reason to change it.`))
        if (!s.projectPath && requestedProject) { s.projectPath = requestedProject; s.revision++ }
      }
      const requestedEnv = name === 'run_on_pod' ? 'pod' : args.target || s.environment
      if (requestedEnv !== s.environment) return finish(fail(`Execution is locked to ${s.environment}. Turbo changes inference, not where project files live. Use set_execution_context explicitly before changing machines.`))
      // During a checkpoint only EDITS are paused. Commands still run and count
      // as the fresh look the checkpoint asks for — refusing them left the model
      // unable to gather the very evidence it was being told to gather.
      const paused = s.gateAfter !== null || s.inFlight
      const diagnostic = name === 'execute_command' && (args.purpose === 'diagnostic' || paused || isReadOnlyCommand(args.command))
      if (paused && ['write_file', 'edit_file', 'transfer_file'].includes(name)) {
        return finish(fail('Diagnostic checkpoint: file changes are paused after repeated failures. Read the failing source or run a command that shows the real error, then call diagnose_failure with the cause and the check you will rerun. Then edit.'))
      }
      // Commands are arbitrary code. Treat ordinary commands as possible edits;
      // diagnostic and verification commands are explicitly scoped read-only.
      const mayMutate = !inspections.has(name) && name !== 'verify_work' && !diagnostic
      if (mayMutate) s.projectLocked = true
      if (mayMutate) s.revision++
      const previousFlight = s.inFlight
      s.inFlight = { tool: name, startedAt: new Date().toISOString() }
      await persist()
      let result
      const runInput = { ...input, projectPath: s.projectPath, executionEnvironment: s.environment, args: { ...args, projectPath: s.projectPath } }
      try {
        if (name === 'transfer_file') {
          if (s.environment !== 'sandbox') throw new Error('transfer_file copies from the current VPS sandbox to a pod; select sandbox first.')
          result = await transfer(runInput)
        } else if (name === 'verify_work') {
          if (!String(args.label || '').trim() || !['test', 'build', 'deployment'].includes(args.kind)) throw new Error('Verification requires a label and kind (test, build, deployment).')
          // Validate the assertion schema before spending time running a command.
          if (!Array.isArray(args.assertions) || !args.assertions.length) throw new Error('Verification requires output assertions, not just exit code zero.')
          if (args.background) throw new Error('Verification must wait for completion. Start long checks with execute_command background:true, then verify_work with jobId.')
          if (args.jobId) {
            const job = (s.jobs || []).find(j => j.id === args.jobId)
            if (!job || job.revision !== s.revision || job.environment !== s.environment) throw new Error('Unknown or stale job: run the check against the current project revision.')
            result = await sandboxJob({ sessionId, jobId: job.id })
            Object.assign(job, result.job)
            if (result.job.status !== 'completed') result = { ...result, ok: false, stderr: 'Job has not completed. Use job_status before verifying.' }
          } else {
            if (!String(args.command || '').trim()) throw new Error('Supply a command or completed jobId.')
            result = await execute({ ...runInput, name: 'execute_command', args: { ...runInput.args, background: false, target: s.environment } })
          }
          if (result.ok) {
            try { evaluateAssertions(result.stdout || '', args.assertions) } catch (e) { result = { ...result, ok: false, exitCode: 1, stderr: `${result.stderr || ''}\nVerification failed: ${e.message}` } }
          }
        } else result = await execute(runInput)
      } catch (e) { result = fail(e.message) }
      if (name === 'execute_command' && result.job) {
        s.jobs = [...(s.jobs || []), { ...result.job, revision: s.revision, environment: s.environment, projectPath: s.projectPath }].slice(-50)
      }
      s.inFlight = previousFlight // a diagnostic must not silently erase a crashed action
      if (executions.has(name) || ['write_file', 'edit_file', 'transfer_file'].includes(name)) {
        // Three failures IN A ROW. Two total tripped it on nearly every real
        // turn (a missing module, then a typo) and each trip cost several
        // actions to clear. A success of any kind means the model is not
        // stuck, so it resets the count.
        if (!result.ok) { s.failures++; if (s.failures >= 3 && s.gateAfter === null) s.gateAfter = s.sequence + 1 }
        else s.failures = 0
      }
      const decorated = finish(result)
      const event = s.events.at(-1)
      if (diagnostic) event.diagnostic = true
      if (name === 'verify_work') {
        // Same check = same label OR same command. Labels are model prose and drift
        // ("built and live" vs "is built and live"), which left the old FAIL alive
        // next to the new PASS and blocked "verified" while the model re-proved it.
        const command = args.command ? safeNote(args.command) : undefined
        s.checks = s.checks.filter(c => !((c.label === safeNote(args.label) || (command && c.command === command && c.kind === args.kind)) && c.environment === s.environment))
        s.checks.push({ id: event.id, label: safeNote(args.label), command, kind: args.kind, revision: s.revision, environment: s.environment, ok: result.ok, assertions: (Array.isArray(args.assertions) ? args.assertions : []).slice(0, 20).map(a => ({ type: a?.type, field: safeNote(a?.field), min: a?.min, value: safeNote(a?.value) })) })
        // A pass of the same kind supersedes earlier failures in this revision. The
        // model refines a flawed check (bad assertion, deploy still propagating)
        // under a new label AND command, so identity cannot be matched: in one
        // real session 3 failed attempts stayed beside the passing one and the
        // reply was stamped "not verified" after the check had passed. A later
        // FAIL still blocks; a fail of a different kind (build vs test) does too.
        if (result.ok) s.checks = s.checks.filter(c => c.ok || c.kind !== args.kind || c.environment !== s.environment || c.revision !== s.revision)
        s.checks = s.checks.slice(-20)
      }
      return { ...decorated, machine: result.host || os.hostname() }
    } catch (e) { return finish(fail(e.message)) }
  })
}

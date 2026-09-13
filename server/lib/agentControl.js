import os from 'node:os'
import { sandboxJob } from './sandboxJobs.js'
import { redactToolData } from './redact.js'
import path from 'node:path'
import { withAgentState, addEvidence, stateSummary, safeNote, evaluateAssertions } from './agentState.js'

const inspections = new Set(['read_file', 'list_files', 'search_files', 'web_search', 'read_web_page'])
const executions = new Set(['execute_command', 'run_code', 'run_on_pod', 'verify_work'])
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
      const diagnostic = name === 'execute_command' && (args.purpose === 'diagnostic' || paused)
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
        s.checks = s.checks.filter(c => !(c.label === safeNote(args.label) && c.environment === s.environment))
        s.checks.push({ id: event.id, label: safeNote(args.label), kind: args.kind, revision: s.revision, environment: s.environment, ok: result.ok, assertions: (Array.isArray(args.assertions) ? args.assertions : []).slice(0, 20).map(a => ({ type: a?.type, field: safeNote(a?.field), min: a?.min, value: safeNote(a?.value) })) })
        s.checks = s.checks.slice(-20)
      }
      return { ...decorated, machine: result.host || os.hostname() }
    } catch (e) { return finish(fail(e.message)) }
  })
}

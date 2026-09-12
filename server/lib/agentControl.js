import os from 'node:os'
import path from 'node:path'
import { withAgentState, addEvidence, stateSummary, safeNote, evaluateAssertions } from './agentState.js'

const inspections = new Set(['read_file', 'list_files', 'search_files', 'web_search'])
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
      const event = addEvidence(s, name, args, r)
      return { ...r, evidenceId: event.id, context: { ...stateSummary(s), recentEvidence: undefined, checks: undefined } }
    }
    try {
      if (name === 'inspect_execution') return finish(ok(JSON.stringify(stateSummary(s), null, 2)))
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
        const ids = Array.isArray(args.evidenceIds) ? args.evidenceIds : []
        const evidence = s.events.filter(e => ids.includes(e.id) && e.id > (s.gateAfter ?? 0))
        const read = evidence.some(e => e.tool === 'read_file' && e.ok)
        const probe = evidence.some(e => e.diagnostic)
        if (!read || !probe || String(args.cause || '').trim().length < 20 || String(args.nextCheck || '').trim().length < 5) {
          return finish(fail('Diagnosis needs a fresh successful source inspection AND diagnostic command after the failures, their evidenceIds, a specific cause, and nextCheck.'))
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
      const diagnostic = args.purpose === 'diagnostic' && name === 'execute_command'
      if ((s.gateAfter !== null || s.inFlight) && !inspections.has(name) && !diagnostic && name !== 'verify_work') {
        return finish(fail('Diagnostic checkpoint: changes are paused. Read the current source, run a small diagnostic command with purpose="diagnostic", then diagnose_failure with both evidence IDs and the cause.'))
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
          result = await execute({ ...runInput, name: 'execute_command', args: { ...runInput.args, target: s.environment } })
          if (result.ok) {
            try { evaluateAssertions(result.stdout || '', args.assertions) } catch (e) { result = { ...result, ok: false, exitCode: 1, stderr: `${result.stderr || ''}\nVerification failed: ${e.message}` } }
          }
        } else result = await execute(runInput)
      } catch (e) { result = fail(e.message) }
      s.inFlight = previousFlight // a diagnostic must not silently erase a crashed action
      if (executions.has(name) || ['write_file', 'edit_file', 'transfer_file'].includes(name)) {
        if (!result.ok) { s.failures++; if (s.failures >= 2 && s.gateAfter === null) s.gateAfter = s.sequence + 1 }
        else if (name === 'verify_work') { s.failures = 0 }
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

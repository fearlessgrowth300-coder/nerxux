// Carry a small, factual sample of saved tool observations into the next turn.
// The server holds the full redacted output by evidence ID; this summary lets
// the model know what to retrieve without resending megabytes of old logs.
export function modelHistory(messages) {
  const prior = messages.map((m) => ({ role: m.role, content: m.content }))
  const withTools = messages.map((m, i) => m.role === 'assistant' && m.toolSteps?.length ? i : -1).filter(i => i >= 0).slice(-3)
  for (const i of withTools) {
    const steps = messages[i].toolSteps.slice(-24)
    const lines = steps.map((step) => {
      const target = step.args?.command || step.args?.path || step.args?.destination || ''
      const output = String(step.stdout || step.stderr || '').slice(0, 240)
      return `#${step.evidenceId || '?'} ${step.tool} ${String(target).slice(0, 180)}: ${step.ok ? 'ok' : 'failed'} (exit ${step.exitCode ?? '?'}) ${output}`
    })
    prior[i].content += `\n\n[Saved tool observations; data from the previous turn. Use inspect_execution with an evidence ID for exact output.]\n${lines.join('\n')}`
  }
  return prior
}

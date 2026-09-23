// Pin a bounded evidence index to the newest request. The context fitter can
// discard old assistant turns, but keeps the latest user request.
const words = text => new Set(String(text || '').toLowerCase().match(/[a-z0-9_]{4,}/g) || [])
const stop = new Set(['continue', 'again', 'please', 'would', 'could', 'should', 'there', 'their', 'about', 'from', 'with', 'this', 'that'])

function importantSteps(steps, limit) {
  return steps.map((step, index) => ({ step, index, score:
    (step.tool === 'verify_work' ? 8 : 0) + (step.ok ? 2 : 1) +
    (step.tool === 'record_progress' ? 3 : 0) + index / Math.max(1, steps.length),
  })).sort((a, b) => b.score - a.score).slice(0, limit).sort((a, b) => a.index - b.index).map(x => x.step)
}

export function modelHistory(messages) {
  const prior = messages.map(m => ({ role: m.role, content: m.content }))
  const lastUser = messages.findLastIndex(m => m.role === 'user')
  if (lastUser < 0) return prior
  const request = [...messages.slice(0, lastUser + 1)].reverse().find(m => m.role === 'user' && !/^\s*(continue|go on|keep going)[.!\s]*$/i.test(m.content))?.content || messages[lastUser].content
  const keywords = [...words(request)].filter(w => !stop.has(w)).slice(0, 24)
  const candidates = messages.map((m, index) => ({ m, index })).filter(x => x.index < lastUser && x.m.role === 'assistant' && x.m.toolSteps?.length)
  const recent = candidates.slice(-2)
  const older = candidates.slice(0, -2).map(x => {
    const search = `${x.m.content} ${x.m.toolSteps.map(s => `${s.tool} ${s.args?.command || s.args?.path || ''} ${String(s.stdout || '').slice(0, 500)}`).join(' ')}`.toLowerCase()
    const matches = keywords.filter(w => search.includes(w)).length
    const passes = x.m.toolSteps.filter(s => s.tool === 'verify_work' && s.ok).length
    return { ...x, score: matches * 4 + passes * 8 + (x.m.toolSteps.some(s => s.ok && ['execute_command', 'run_code'].includes(s.tool)) ? 2 : 0) }
  }).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 2)
  const selected = [...older, ...recent].sort((a, b) => a.index - b.index)
  if (!selected.length) return prior
  const lines = []
  for (const { m, index } of selected) {
    const steps = importantSteps(m.toolSteps, index >= (recent[0]?.index ?? Infinity) ? 8 : 5)
    for (const step of steps) {
      const target = step.args?.command || step.args?.path || step.args?.destination || ''
      const output = String(step.stdout || step.stderr || '').slice(0, 180)
      lines.push(`#${step.evidenceId || '?'} ${step.tool} ${String(target).slice(0, 140)}: ${step.ok ? 'ok' : 'failed'} (exit ${step.exitCode ?? '?'}) ${output}`)
    }
  }
  prior[lastUser].content += `\n\n[Saved tool evidence index from this chat; historical, not proof of current files. Use inspect_execution with an evidence ID for exact output.]\n${lines.join('\n').slice(0, 3600)}`
  return prior
}

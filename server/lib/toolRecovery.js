// One tracker per turn. Reading a file or successfully writing a patch does
// not establish that a failing command now works.
const EXECUTION_TOOLS = new Set(['execute_command', 'run_code', 'run_on_pod'])

export function createToolRecovery() {
  let failedChecks = 0
  return (name, result) => {
    if (!EXECUTION_TOOLS.has(name)) return ''
    if (result.ok) {
      failedChecks = 0
      return ''
    }
    failedChecks++
    if (failedChecks < 2) return ''
    return '\n\n[Diagnostic checkpoint] Multiple execution checks have failed. ' +
      'Before another patch, inspect the full error and the current source, identify the failing line and actual input types, ' +
      'and isolate a minimal reproduction. Explain what new evidence changes your hypothesis. ' +
      'Make one targeted change, check syntax, then rerun the original failing check. ' +
      'Do not guess API fields or endpoints, repeat stale edits, or claim completion while verification fails.'
  }
}

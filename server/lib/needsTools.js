// Should this turn get the agent's hands (sandbox, files, git, run commands)?
//
// Attaching them costs ~1,250 prompt tokens on EVERY message, and — worse —
// tempts the model into a tool call for questions that never needed one, and
// each tool round-trip is another API request. On a free tier measured at 5–20
// requests per day that is the difference between a usable model and one that
// runs out mid-answer.
//
// The bias is deliberate: a false negative (the model can only talk when it
// should have acted) is far more annoying than a false positive (a few wasted
// tokens), so anything that plausibly asks for action gets the tools.

// Verbs that mean "do something to a file / repo / machine".
const ACTION = /\b(build|create|make|write|generate|scaffold|implement|add|set ?up|install|configure|deploy|publish|ship|run|execute|start|launch|compile|fix|debug|repair|patch|refactor|rename|move|copy|delete|remove|update|upgrade|migrate|clone|check ?out|commit|push|pull|merge|rebase|test|lint|format|read|open|list|show me|find|search)\b/i

// Nouns that mean the action lands on a real artefact rather than on prose.
const TARGET = /\b(file|files|folder|directory|dir|path|repo|repository|project|codebase|app|website|site|page|component|script|module|package|function|class|api|endpoint|server|database|schema|migration|branch|commit|pr|pull request|test|tests|bug|error|stack ?trace|log|logs|terminal|command|shell|sandbox|workspace)\b/i

// Things that are only ever tool work, whatever the sentence around them.
const HARD = /\b(git|github|npm|npx|yarn|pnpm|pip|python|node|bash|sh|curl|docker|vite|next\.?js|react|tsx?|jsx?|\.env|package\.json|requirements\.txt|dockerfile|makefile)\b|```|\.(js|ts|jsx|tsx|py|go|rs|java|rb|php|html|css|json|ya?ml|toml|md|sh)\b|(^|\s)[~/.]?\/[\w.-]+\/|[A-Za-z]:\\/i

// Explicit tool names — if someone names one, they want it.
const NAMED = /\b(write_file|read_file|edit_file|list_files|search_files|execute_command|run_code|run_on_pod|web_search|inspect_execution|set_execution_context|diagnose_failure|verify_work|record_progress|transfer_file)\b/i

/**
 * @param {string} text  the latest user message
 * @param {object} opts  { projectPath } — a mounted project means they're working on code
 * @returns {boolean}
 */
export function needsAgentTools(text = '', { projectPath = null } = {}) {
  // Working inside a real project: every turn is potentially tool work.
  if (projectPath) return true
  const t = String(text || '')
  if (!t.trim()) return false
  // A continuation must retain hands even when it does not repeat "project".
  if (/^\s*(continue|resume|carry on|keep going|retry)\b/i.test(t)) return true
  if (NAMED.test(t) || HARD.test(t)) return true
  return ACTION.test(t) && TARGET.test(t)
}

/**
 * Resolves the per-request setting. 'on' / 'off' are the user's explicit
 * choice; 'auto' (the default) asks the heuristic.
 */
export function shouldAttachAgentTools(mode, text, opts) {
  if (mode === 'on' || mode === true) return true
  if (mode === 'off' || mode === false) return false
  return needsAgentTools(text, opts)
}

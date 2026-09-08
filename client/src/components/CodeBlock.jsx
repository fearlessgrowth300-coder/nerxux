import { useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import axios from 'axios'

const RUNNABLE_LANGS = new Set([
  'python', 'py',
  'javascript', 'js',
  'typescript', 'ts',
  'cpp', 'c++', 'c',
  'bash', 'sh',
])

const LANG_LABELS = {
  python: 'Python 3',
  py: 'Python 3',
  javascript: 'Node.js',
  js: 'Node.js',
  typescript: 'TypeScript',
  ts: 'TypeScript',
  cpp: 'C++17',
  'c++': 'C++17',
  c: 'C',
  bash: 'Bash',
  sh: 'Shell',
}

export default function CodeBlock({ language = '', code = '', sessionId = 'default' }) {
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState(null)
  const [profile, setProfile] = useState('none') // 'none' (airgapped) or 'full' (internet)
  const [copied, setCopied] = useState(false)
  const [showConsole, setShowConsole] = useState(false)

  const langKey = (language || '').toLowerCase().trim()
  const isRunnable = RUNNABLE_LANGS.has(langKey)
  const label = LANG_LABELS[langKey] || language.toUpperCase() || 'CODE'

  async function handleRun() {
    setRunning(true)
    setShowConsole(true)
    try {
      const res = await axios.post('/api/sandbox/run', {
        code,
        language: langKey,
        sessionId: sessionId || 'default',
        profile,
      })
      setOutput(res.data)
    } catch (err) {
      setOutput({
        ok: false,
        stderr: err.response?.data?.error || err.message,
        stdout: '',
        exitCode: 1,
        durationMs: 0,
        isolation: 'OS-level (Landlock/Bubblewrap namespaces)',
        profile,
      })
    } finally {
      setRunning(false)
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-nexus-border/80 bg-[#090d16] shadow-xl">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between border-b border-white/5 bg-white/[0.03] px-3.5 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-mono font-semibold text-nexus-accent2">{label}</span>
          {isRunnable && (
            <span
              className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-0.5 text-[10px] text-gray-400"
              title="OS-level kernel isolation using Linux Landlock and namespaces via Bubblewrap"
            >
              🔒 Landlock Sandbox
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isRunnable && (
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-gray-400">Net:</span>
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                className="rounded border border-nexus-border bg-nexus-panel px-1.5 py-0.5 text-[10px] text-gray-300 focus:outline-none"
                title="Configurable network profile"
              >
                <option value="none">Airgapped (None)</option>
                <option value="full">Full (Internet)</option>
              </select>
            </div>
          )}

          <button
            onClick={handleCopy}
            className="rounded px-2 py-1 text-[11px] text-gray-400 transition hover:bg-white/5 hover:text-white"
            title="Copy code"
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>

          {isRunnable && (
            <button
              onClick={handleRun}
              disabled={running}
              className={[
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-medium text-xs shadow-sm transition',
                running
                  ? 'bg-nexus-accent/50 text-white/70 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white',
              ].join(' ')}
              title="Run code in local OS-isolated sandbox"
            >
              {running ? (
                <>
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                  Running...
                </>
              ) : (
                <>
                  <span>▶</span> Run Code
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Code Syntax Highlight */}
      <SyntaxHighlighter
        language={langKey || 'text'}
        style={oneDark}
        customStyle={{
          margin: 0,
          background: 'transparent',
          fontSize: '0.8rem',
          padding: '0.85rem 1rem',
        }}
        PreTag="div"
      >
        {String(code).replace(/\n$/, '')}
      </SyntaxHighlighter>

      {/* Terminal Sandbox Console Output */}
      {showConsole && (
        <div className="border-t border-nexus-border/80 bg-[#05080e] p-3 text-xs">
          <div className="mb-2 flex items-center justify-between text-[11px] text-gray-400">
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold uppercase tracking-wider text-gray-300">
                Console Output
              </span>
              {output && (
                <span
                  className={[
                    'rounded px-1.5 py-0.2 text-[10px] font-mono',
                    output.ok
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : 'bg-rose-500/20 text-rose-400',
                  ].join(' ')}
                >
                  Exit {output.exitCode}
                </span>
              )}
              {output?.durationMs !== undefined && (
                <span className="text-gray-500">{output.durationMs}ms</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500">
                Profile: {profile === 'none' ? 'Airgapped' : 'Internet'} (Persisted session)
              </span>
              <button
                onClick={() => setShowConsole(false)}
                className="text-gray-500 hover:text-gray-300"
                title="Hide output"
              >
                ✕
              </button>
            </div>
          </div>

          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-xs leading-relaxed text-gray-200">
            {running && (
              <span className="text-nexus-accent animate-pulse">
                ⚡ Executing inside OS-level Landlock/bwrap sandbox...
              </span>
            )}
            {!running && output?.stdout && <span>{output.stdout}</span>}
            {!running && output?.stderr && (
              <span className="text-rose-400">{output.stderr}</span>
            )}
            {!running && !output?.stdout && !output?.stderr && (
              <span className="italic text-gray-500">Code executed with no output.</span>
            )}
          </pre>
        </div>
      )}
    </div>
  )
}

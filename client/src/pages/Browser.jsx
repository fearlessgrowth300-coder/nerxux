import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchFrame, getBrowserState, navigateBrowser, sendBrowserInput, startBrowser, stopBrowser } from '../lib/browser'
import { apiError } from '../lib/api'

// The same Chromium the agent drives, live. The point of the takeover is the
// sign-in the agent must never do for you: you click and type here, into the
// same session, and the agent carries on inside it afterwards.
//
// Frames are polled rather than streamed — a screenshot is one request, and at
// a few frames a second it costs less than the machinery a socket would need.
const FPS_ACTIVE = 2
const FPS_IDLE = 0.5

export default function Browser() {
  const [state, setState] = useState({ running: false, url: null, title: '', viewport: { width: 1280, height: 800 } })
  const [frame, setFrame] = useState(null)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Typing goes to the page only while the view has focus, so a stray keystroke
  // meant for this app never lands in someone's login form.
  const [focused, setFocused] = useState(false)
  const imgRef = useRef(null)
  const lastUrl = useRef(null)

  const refreshFrame = useCallback(async () => {
    try {
      const url = await fetchFrame()
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
      lastUrl.current = url
      setFrame(url)
      setError('')
    } catch (err) {
      // A browser that isn't up yet is the normal first state, not an error.
      if (err?.response?.status !== 503) setError(apiError(err).message)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (!alive) return
      await refreshFrame()
      try {
        const s = await getBrowserState()
        if (alive) {
          setState(s)
          setAddress((a) => (document.activeElement?.dataset?.addressBar ? a : s.url || a))
        }
      } catch {}
    }
    tick()
    const hz = focused ? FPS_ACTIVE : FPS_IDLE
    const timer = setInterval(tick, 1000 / hz)
    return () => { alive = false; clearInterval(timer) }
  }, [refreshFrame, focused])

  useEffect(() => () => { if (lastUrl.current) URL.revokeObjectURL(lastUrl.current) }, [])

  async function act(fn) {
    setBusy(true)
    setError('')
    try {
      const s = await fn()
      if (s) setState((prev) => ({ ...prev, ...s }))
      await refreshFrame()
    } catch (err) {
      setError(apiError(err).message)
    } finally {
      setBusy(false)
    }
  }

  // The image is scaled to fit the panel, so a click at CSS pixel (x,y) has to
  // be mapped back to the page's own 1280x800 coordinate space or every click
  // lands somewhere else.
  function handleClick(event) {
    const img = imgRef.current
    if (!img) return
    const rect = img.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * state.viewport.width
    const y = ((event.clientY - rect.top) / rect.height) * state.viewport.height
    act(() => sendBrowserInput({ type: 'click', x, y }))
  }

  function handleKeyDown(event) {
    if (!focused) return
    const named = ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']
    if (named.includes(event.key)) {
      event.preventDefault()
      act(() => sendBrowserInput({ type: 'key', key: event.key }))
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      act(() => sendBrowserInput({ type: 'text', text: event.key }))
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-3 p-4">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-gray-100">Browser</h1>
        <p className="text-xs text-gray-400">
          The agent's browser, live. Click <strong className="text-gray-300">Take over</strong> to drive it yourself — sign in to a
          site here and the agent keeps that session. Logins are saved on the server, so each site only needs doing once.
        </p>
      </header>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          act(() => navigateBrowser(address.startsWith('http') ? address : `https://${address}`))
        }}
      >
        <input
          data-address-bar="true"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="https://example.com"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 outline-none focus:border-nexus-accent2/50"
        />
        <button type="submit" disabled={busy} className="rounded-lg bg-nexus-accent2/20 px-3 py-1.5 text-sm text-nexus-accent2 hover:bg-nexus-accent2/30 disabled:opacity-50">
          Go
        </button>
        <button
          type="button"
          onClick={() => setFocused((f) => !f)}
          className={`rounded-lg px-3 py-1.5 text-sm transition ${
            focused
              ? 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
              : 'border border-transparent bg-white/5 text-gray-400 hover:bg-white/10'
          }`}
          title="While on, your clicks and keystrokes go to the page"
        >
          {focused ? '● You are driving' : 'Take over'}
        </button>
        <button type="button" onClick={() => act(startBrowser)} disabled={busy} className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-gray-400 hover:bg-white/10 disabled:opacity-50">
          Start
        </button>
        <button type="button" onClick={() => act(stopBrowser)} disabled={busy} className="rounded-lg bg-red-500/15 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/25 disabled:opacity-50">
          Close
        </button>
      </form>

      <div className="flex items-center gap-2 text-[11px] text-gray-500">
        <span className={`h-1.5 w-1.5 rounded-full ${state.running ? 'bg-emerald-400' : 'bg-gray-600'}`} />
        <span className="truncate">{state.running ? `${state.title || 'Untitled'} — ${state.url}` : 'Browser not running'}</span>
        {error && <span className="text-red-400">⚠️ {error}</span>}
      </div>

      {/* tabIndex makes the frame focusable so it can receive real keystrokes. */}
      <div
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onWheel={(e) => { if (focused) act(() => sendBrowserInput({ type: 'scroll', deltaY: e.deltaY })) }}
        className={`relative flex-1 overflow-hidden rounded-xl border bg-black/40 outline-none ${
          focused ? 'border-emerald-500/40 ring-1 ring-emerald-500/30' : 'border-white/10'
        }`}
      >
        {frame ? (
          <img
            ref={imgRef}
            src={frame}
            alt="Live browser view"
            onClick={handleClick}
            className={`h-full w-full object-contain ${focused ? 'cursor-crosshair' : 'cursor-default'}`}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-gray-500">
            {state.running ? 'Waiting for the first frame…' : 'Press Start, or give the agent something to look up.'}
          </div>
        )}
      </div>

      <p className="text-[11px] text-gray-500">
        Anything you sign into here stays signed in for the agent too. Never type a password while the agent is mid-task on the
        same site, and use <strong className="text-gray-400">Close</strong> when you want the session idle.
      </p>
    </div>
  )
}

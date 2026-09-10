import { useState, useEffect } from 'react'
import { getComputeStatus, switchComputeMode, setHostingerIp, listPods, selectPod } from '../lib/compute'
import { apiError } from '../lib/api'

export default function ComputeBar() {
  const [status, setStatus] = useState({
    mode: 'always_on',
    details: { label: 'Always On: Hostinger model (KVM 8)', speed: '2–5 tok/s', cost: '$26/mo flat', status: 'ready' },
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ipModal, setIpModal] = useState(false)
  const [hostingerIp, setHostingerIpInput] = useState('')
  const [podModal, setPodModal] = useState(false)
  const [pods, setPods] = useState(null)
  const [stopConfirm, setStopConfirm] = useState(false)

  // The bar used to read the status exactly once, on mount. RunPod exits a pod
  // on its own (out of funds, GPU reclaimed) and nothing told the page, so it
  // sat there claiming Turbo was connected for as long as the tab stayed open.
  // Re-check on a timer and whenever the tab is brought back to the front.
  useEffect(() => {
    let alive = true
    const refresh = () =>
      getComputeStatus()
        .then((s) => {
          if (!alive) return
          setStatus(s)
          if (s.hostingerUrl) setHostingerIpInput(s.hostingerUrl)
        })
        .catch(() => {})
    refresh()
    const timer = setInterval(refresh, 20000)
    const onFocus = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onFocus)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onFocus) }
  }, [])

  async function openPodPicker() {
    setPodModal(true)
    setPods(null)
    try {
      setPods(await listPods())
    } catch (err) {
      setError(apiError(err).message)
      setPods([])
    }
  }

  async function choosePod(id) {
    try {
      await selectPod(id)
      setPodModal(false)
      setStatus(await getComputeStatus())
    } catch (err) {
      setError(apiError(err).message)
    }
  }

  // Switching to Always On used to STOP the pod. Stopping a RunPod pod releases
  // its GPU, and if the host is full you cannot get it back — the pod is stuck
  // needing migration and its /workspace (Ollama + the 17GB model) is gone.
  // Routing chat to Hostinger must never risk that; only the explicit stop
  // button does, and it asks first.
  async function handleSwitch(targetMode, { stopPod = false } = {}) {
    if (loading) return
    setError('')
    setLoading(true)
    try {
      const res = await switchComputeMode(targetMode, stopPod)
      const updated = await getComputeStatus()
      setStatus(updated)
    } catch (err) {
      setError(apiError(err).message)
      try { setStatus(await getComputeStatus()) } catch {}
    } finally {
      setLoading(false)
    }
  }

  async function handleSaveHostinger() {
    try {
      await setHostingerIp(hostingerIp)
      const updated = await getComputeStatus()
      setStatus(updated)
      setIpModal(false)
    } catch (err) {
      setError(err.message)
    }
  }

  const isTurbo = status.mode === 'turbo'

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-2 bg-nexus-panel/80 border-b border-nexus-border/60 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-gray-400 font-medium">Compute:</span>

        {/* Button 1: Always On */}
        <button
          type="button"
          onClick={() => handleSwitch('always_on')}
          disabled={loading}
          className={[
            'flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition cursor-pointer',
            !isTurbo
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm shadow-emerald-500/10 ring-1 ring-emerald-500/30'
              : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200 border border-transparent',
          ].join(' ')}
          title="Hostinger KVM 8: 2–5 tok/s, 24/7 flat $26/mo"
        >
          <span>🐢</span>
          <span>Always On</span>
          <span className="text-[10px] opacity-70 hidden sm:inline">(Hostinger model)</span>
          {!isTurbo && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>}
        </button>

        {/* Button 2: Turbo */}
        <button
          type="button"
          onClick={() => handleSwitch('turbo')}
          disabled={loading}
          className={[
            'flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium transition cursor-pointer',
            isTurbo
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm shadow-amber-500/10 ring-1 ring-amber-500/30'
              : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200 border border-transparent',
          ].join(' ')}
          title="RunPod GPU: 30–65+ tok/s, billed per hour while running"
        >
          <span>🚀</span>
          <span>Turbo</span>
          <span className="text-[10px] opacity-70 hidden sm:inline">(RunPod model)</span>
          {isTurbo && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>}
        </button>

        {/* Stop Turbo / Power Off. Shown when the pod is actually RUNNING —
            this button exists to stop hourly billing, and offering it for a pod
            RunPod already exited just makes the bar look connected when it isn't. */}
        {status.runpodRunning && (
          <button
            type="button"
            onClick={() => setStopConfirm(true)}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg font-medium bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 transition cursor-pointer"
            title="Stop the RunPod pod to halt hourly billing"
          >
            <span>⏹ Stop pod</span>
          </button>
        )}
      </div>

      {/* Live Status indicator */}
      <div className="flex items-center gap-2">
        {loading ? (
          <div className="flex items-center gap-1.5 text-amber-400 animate-pulse">
            <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping" />
            <span>Switching compute infrastructure... (~1–2m)</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-gray-400">
            <span
              className={`h-2 w-2 rounded-full ${
                isTurbo ? 'bg-amber-400' : 'bg-emerald-400'
              }`}
            />
            <span>
              {status.details?.status === 'ready' ? 'Connected' : 'Not connected'}: <strong className="text-gray-200">{status.details?.label}</strong>
              <span className="hidden md:inline text-gray-500">
                {' '}
                · {status.details?.speed} · {status.details?.cost}
              </span>
            </span>

            {/* Why Turbo isn't available, in plain words, instead of a spinner
                that never resolves. */}
            {status.notice && <span className="text-amber-300">{status.notice}</span>}

            {/* A new pod downloading its model. Shows the installer's own last
                line, so "is it stuck?" has an answer without opening RunPod. */}
            {status.provisioning && !status.provisioning.done && (
              <span className="flex items-center gap-1.5 text-amber-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                Setting up your new pod ({status.provisioning.minutes}m):{' '}
                <span className="text-gray-400">{status.provisioning.line || 'starting…'}</span>
              </span>
            )}

            {!isTurbo && status.runpodRunning && (
              <span className="text-amber-300">
                RunPod is still running. Click Always On to stop its billing.
              </span>
            )}

            <button
              type="button"
              onClick={openPodPicker}
              className="text-[11px] text-nexus-accent2 hover:underline"
              title="Choose which RunPod pod Turbo uses"
            >
              ⚙ Pod{status.runpodStatus && status.runpodStatus !== 'UNKNOWN' ? ` (${status.runpodStatus.toLowerCase()})` : ''}
            </button>

            <button
              type="button"
              onClick={() => setIpModal(true)}
              className="text-[11px] text-nexus-accent2 hover:underline ml-1"
              title="Configure Hostinger KVM 8 IP"
            >
              ⚙ IP
            </button>
          </div>
        )}

        {error && <span className="text-red-400 text-[11px] ml-2">⚠️ {error}</span>}
      </div>

      {/* Stopping a pod is not reversible in practice: RunPod hands the GPU to
          someone else, and a full host leaves the pod unstartable — its
          /workspace, Ollama and the 17GB model with it. Say that plainly before
          doing it, because it already happened once. */}
      {stopConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setStopConfirm(false)}>
          <div className="w-full max-w-md space-y-3 rounded-2xl border border-red-500/30 bg-nexus-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-100">Stop the RunPod pod?</h3>
            <p className="text-xs leading-relaxed text-gray-400">
              This halts the hourly charge — but it also gives the GPU back to RunPod. If the
              host is full when you return, the pod cannot start and you would have to create a
              new one and re-download the 17GB model.
            </p>
            <p className="text-xs leading-relaxed text-gray-400">
              To just use the cheaper model, click <strong className="text-gray-200">Always On</strong> instead —
              that leaves the pod running (and still billing).
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setStopConfirm(false)}
                className="rounded-lg border border-nexus-border px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5">Keep it running</button>
              <button type="button"
                onClick={() => { setStopConfirm(false); handleSwitch('always_on', { stopPod: true }) }}
                className="rounded-lg bg-red-500/80 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-500">Stop the pod</button>
            </div>
          </div>
        </div>
      )}

      {/* Pod picker — a replacement pod (after funds run out, or a GPU is
          reclaimed) gets a brand new id. Picking it here beats editing .env on
          the server; Turbo also finds it on its own if this is never opened. */}
      {podModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPodModal(false)}>
          <div className="w-full max-w-md space-y-3 rounded-2xl border border-nexus-border bg-nexus-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-100">RunPod pods on your account</h3>
            <p className="text-xs text-gray-400">
              Turbo picks a running pod automatically. Choose one here only to override it.
            </p>
            {pods === null && <p className="text-xs text-gray-500">Loading…</p>}
            {pods?.length === 0 && (
              <p className="text-xs text-gray-500">No pods found. Create one in RunPod, then reopen this.</p>
            )}
            <div className="max-h-60 space-y-1 overflow-y-auto">
              {pods?.map((p) => (
                <button key={p.id} type="button" onClick={() => choosePod(p.id)}
                  className={[
                    'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-white/5',
                    p.id === status.runpodPodId ? 'ring-1 ring-nexus-accent' : '',
                  ].join(' ')}>
                  <span className="min-w-0">
                    <span className="block truncate text-gray-200">{p.name || p.id}</span>
                    <span className="block truncate text-[10px] text-gray-500">{p.id} · {p.gpu || 'GPU'} · ${p.costPerHr}/hr</span>
                  </span>
                  <span className={p.status === 'RUNNING' ? 'shrink-0 text-emerald-300' : 'shrink-0 text-gray-500'}>
                    {String(p.status || '').toLowerCase()}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={() => setPodModal(false)}
                className="rounded-lg border border-nexus-border px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal for setting KVM 8 IP */}
      {ipModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-nexus-border bg-nexus-panel p-5 shadow-2xl space-y-4">
            <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
              <span>⚙</span> Configure Hostinger KVM 8
            </h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              Enter your Hostinger KVM 8 IP address or hostname running Ollama:
            </p>
            <input
              type="text"
              value={hostingerIp}
              onChange={(e) => setHostingerIpInput(e.target.value)}
              placeholder="e.g. 195.35.20.100 or http://195.35.20.100:11434"
              className="w-full rounded-xl border border-nexus-border bg-nexus-bg px-3 py-2 text-sm text-gray-200 outline-none focus:border-nexus-accent"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIpModal(false)}
                className="px-3 py-1.5 rounded-lg border border-nexus-border text-xs text-gray-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveHostinger}
                className="px-4 py-1.5 rounded-lg bg-nexus-accent text-xs font-medium text-white hover:bg-indigo-500 transition"
              >
                Save & Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

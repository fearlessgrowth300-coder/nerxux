import { useEffect, useState } from 'react'
import Modal from './Modal'
import { apiError } from '../lib/api'
import {
  getComputeStatus, switchComputeMode, listPods, selectPod, terminatePod,
} from '../lib/compute'

// The whole GPU pod lifecycle in one place. Recovering from a lost pod used to
// mean editing the server over SSH; a pod can now be terminated here, and its
// replacement is detected and set up automatically.
export default function GpuPods() {
  const [status, setStatus] = useState(null)
  const [pods, setPods] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [confirmKill, setConfirmKill] = useState(null)

  async function refresh() {
    try {
      const [s, p] = await Promise.all([getComputeStatus(), listPods().catch(() => [])])
      setStatus(s)
      setPods(p)
    } catch (err) {
      setError(apiError(err).message)
    }
  }

  // While a pod installs its model, keep the progress line moving.
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => clearInterval(timer)
  }, [])

  async function act(label, fn) {
    setBusy(label)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(apiError(err).message)
    } finally {
      setBusy('')
      refresh()
    }
  }

  const setup = status?.provisioning
  const activePod = status?.runpodPodId

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold text-gray-100">GPU pods (Turbo)</h2>
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-gray-500">
          Turbo runs your Qwen 27B model on a RunPod GPU. The pod is found automatically —
          create one in RunPod and press Connect Turbo; it installs Ollama and the model itself.
        </p>

        {status && (
          <div className="rounded-xl border border-nexus-border bg-nexus-bg/60 p-3 text-xs">
            <p className="text-gray-300">
              Route: <strong className="text-gray-100">{status.mode === 'turbo' ? 'Turbo (GPU)' : 'Always On (Hostinger)'}</strong>
              {status.runpodStatus && status.runpodStatus !== 'UNKNOWN' && (
                <> · pod is <strong className="text-gray-100">{status.runpodStatus.toLowerCase()}</strong></>
              )}
            </p>
            {status.notice && <p className="mt-1 text-amber-300">{status.notice}</p>}
            {setup && !setup.done && (
              <p className="mt-1 flex items-center gap-1.5 text-amber-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                Installing the model ({setup.minutes}m):{' '}
                <span className="text-gray-400">{setup.line || 'starting…'}</span>
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={() => act('connect', () => switchComputeMode('turbo', false))} disabled={Boolean(busy)}
                className="rounded-lg bg-nexus-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40">
                {busy === 'connect' ? 'Connecting…' : 'Connect Turbo'}
              </button>
              <button onClick={() => act('always', () => switchComputeMode('always_on', false))} disabled={Boolean(busy)}
                className="rounded-lg border border-nexus-border px-3 py-1.5 text-xs text-gray-300 transition hover:bg-white/5 disabled:opacity-40">
                Use Always On
              </button>
              {status.runpodRunning && (
                <button onClick={() => act('stop', () => switchComputeMode('always_on', true))} disabled={Boolean(busy)}
                  className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 transition hover:bg-red-500/20 disabled:opacity-40">
                  {busy === 'stop' ? 'Stopping…' : 'Stop pod (keeps the model)'}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-300">Pods on your RunPod account</span>
            <button onClick={refresh} className="text-xs text-nexus-accent2 hover:underline">Refresh</button>
          </div>
          {pods === null && <p className="text-xs text-gray-500">Loading…</p>}
          {pods?.length === 0 && (
            <p className="text-xs text-gray-500">
              No pods yet. Create one at runpod.io with a 50GB+ volume mounted at /workspace,
              then press Connect Turbo.
            </p>
          )}
          {pods?.map((pod) => (
            <div key={pod.id} className="flex items-center justify-between gap-3 rounded-lg border border-nexus-border/60 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-gray-200">
                  {pod.name || pod.id}
                  {pod.id === activePod && (
                    <span className="ml-2 rounded bg-nexus-accent/20 px-1.5 py-0.5 text-[10px] text-nexus-accent2">in use</span>
                  )}
                </p>
                <p className="truncate text-[10px] text-gray-500">
                  {pod.id} · {pod.gpu || 'GPU'} · ${pod.costPerHr}/hr
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={pod.status === 'RUNNING' ? 'text-xs text-emerald-300' : 'text-xs text-gray-500'}>
                  {String(pod.status || '').toLowerCase()}
                </span>
                {pod.id !== activePod && (
                  <button onClick={() => act('use' + pod.id, () => selectPod(pod.id))} disabled={Boolean(busy)}
                    className="rounded border border-nexus-border px-2 py-1 text-[11px] text-gray-300 transition hover:bg-white/5 disabled:opacity-40">
                    Use
                  </button>
                )}
                <button onClick={() => setConfirmKill(pod)} disabled={Boolean(busy)}
                  className="rounded border border-red-500/30 px-2 py-1 text-[11px] text-red-300 transition hover:bg-red-500/15 disabled:opacity-40">
                  Terminate
                </button>
              </div>
            </div>
          ))}
        </div>

        {error && <p className="text-xs text-red-400">⚠️ {error}</p>}
      </div>

      {/* Terminate destroys the volume the model lives on — never a one-click. */}
      <Modal open={Boolean(confirmKill)} onClose={() => setConfirmKill(null)} title="Terminate this pod?">
        <div className="space-y-3 text-sm">
          <p className="text-gray-300">
            <strong className="text-gray-100">{confirmKill?.name || confirmKill?.id}</strong> will be destroyed
            permanently, along with its /workspace volume — Ollama and the 17GB model with it.
            This cannot be undone.
          </p>
          <p className="text-xs text-gray-500">
            Afterwards, create a new pod in RunPod and press <strong className="text-gray-300">Connect Turbo</strong>.
            It is detected automatically and reinstalls the model on its own.
          </p>
          <p className="text-xs text-gray-500">
            Only want to stop the hourly charge? Use <strong className="text-gray-300">Stop pod</strong> instead —
            that keeps the model.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmKill(null)}
              className="rounded-lg border border-nexus-border px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5">
              Cancel
            </button>
            <button
              onClick={() => {
                const id = confirmKill.id
                setConfirmKill(null)
                act('kill', () => terminatePod(id))
              }}
              className="rounded-lg bg-red-500/80 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-500">
              Terminate permanently
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

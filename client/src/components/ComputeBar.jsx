import { useState, useEffect } from 'react'
import { getComputeStatus, switchComputeMode, setHostingerIp } from '../lib/compute'
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

  useEffect(() => {
    getComputeStatus()
      .then((s) => {
        setStatus(s)
        if (s.hostingerUrl) setHostingerIpInput(s.hostingerUrl)
      })
      .catch(() => {})
  }, [])

  async function handleSwitch(targetMode) {
    if (loading) return
    setError('')
    setLoading(true)
    try {
      const res = await switchComputeMode(targetMode, targetMode === 'always_on')
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
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-nexus-panel/80 border-b border-nexus-border/60 text-xs">
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

        {/* Stop Turbo / Power Off */}
        {isTurbo && (
          <button
            type="button"
            onClick={() => handleSwitch('always_on')}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg font-medium bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 transition cursor-pointer"
            title="Stop RunPod to halt hourly billing"
          >
            <span>⏹ Stop Turbo</span>
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
              {status.details?.status === 'ready' ? 'Connected' : 'Reconnecting'}: <strong className="text-gray-200">{status.details?.label}</strong>
              <span className="hidden md:inline text-gray-500">
                {' '}
                · {status.details?.speed} · {status.details?.cost}
              </span>
            </span>

            {!isTurbo && status.runpodRunning && (
              <span className="text-amber-300">
                RunPod is still running. Click Always On to stop its billing.
              </span>
            )}

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

import { useEffect, useState } from 'react'
import { getComputeStatus } from '../lib/compute'
import { kaggleSessionCountdown, formatDuration } from '../lib/billing'

// Kaggle's ~12h session limit in the top bar, ticking every second, the same
// way BalanceBadge shows RunPod's next-charge countdown. Hidden unless Kaggle
// is the selected mode AND a live tunnel has actually been seen — no session
// timestamp means there's nothing to count down (notebook not connected yet).
export default function KaggleSessionBadge() {
  const [status, setStatus] = useState(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let alive = true
    const load = () =>
      getComputeStatus()
        .then((s) => { if (alive) setStatus(s) })
        .catch(() => {})
    load()
    const refresh = setInterval(load, 20000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { alive = false; clearInterval(refresh); clearInterval(tick) }
  }, [])

  if (status?.mode !== 'kaggle') return null
  const session = status.details?.session
  const countdown = kaggleSessionCountdown(session, now)
  if (!countdown) return null

  const usage = status.details?.usage
  const low = countdown.remainingSeconds < 3600
  const tone = low ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-sky-500/30 bg-sky-500/10 text-sky-200'

  return (
    <span
      title={
        `Approximate — timed from when Nexus first saw the notebook's tunnel connect, ` +
        `not Kaggle's own clock, so the real limit may land a little earlier.` +
        (usage ? ` Weekly quota: ${formatDuration(usage.remainingSeconds)} left of 30h.` : '')
      }
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${tone}`}
    >
      <span>📓</span>
      <span className="font-mono">{formatDuration(countdown.remainingSeconds)}</span>
      <span className="hidden text-gray-400 md:inline">left this session</span>
    </span>
  )
}

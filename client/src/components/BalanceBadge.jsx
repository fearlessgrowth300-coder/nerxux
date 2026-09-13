import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getBilling } from '../lib/compute'
import { projectBilling, chargeCycle, formatMoney, formatDuration } from '../lib/billing'

// RunPod balance in the top bar: always visible, ticking, with the countdown
// to the next charge. Refreshes from the server every 60 s; the seconds in
// between are projected locally. Hidden entirely if billing cannot be read
// (no RunPod key, or the user is not an admin of this deployment).
export default function BalanceBadge() {
  const [billing, setBilling] = useState(null)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const b = await getBilling()
        if (alive) { setBilling(b); setFailed(false) }
      } catch {
        if (alive) setFailed(true)
      }
    }
    load()
    const refresh = setInterval(load, 60000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { alive = false; clearInterval(refresh); clearInterval(tick) }
  }, [])

  if (failed || !billing) return null
  const bill = projectBilling(billing, now)
  const cycle = chargeCycle(billing, now)
  const low = bill.secondsLeft !== null && bill.secondsLeft < 3600
  const tone = low ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-nexus-border bg-nexus-bg/60 text-gray-200'

  return (
    <Link
      to="/settings"
      title={
        bill.running
          ? `Pod running ${formatDuration(bill.uptimeSeconds)} · ${formatMoney(bill.sessionCost, 3)} this session · ${cycle ? `${cycle.chargesSoFar} charge(s) taken so far` : ''}`
          : 'No pod running — the balance is not being charged'
      }
      className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition hover:bg-white/5 ${tone}`}
    >
      <span className="font-semibold">{formatMoney(bill.balanceNow)}</span>
      {bill.running && cycle ? (
        <>
          <span className="hidden text-gray-500 sm:inline">·</span>
          <span className="hidden sm:inline">
            next charge <span className="font-mono">{formatDuration(cycle.secondsToNext)}</span> ({formatMoney(cycle.chargeAmount, 3)})
          </span>
          <span className="hidden text-gray-500 md:inline">·</span>
          <span className="hidden text-gray-400 md:inline">{formatDuration(bill.secondsLeft)} left</span>
        </>
      ) : (
        <span className="hidden text-gray-500 sm:inline">· pod off</span>
      )}
    </Link>
  )
}

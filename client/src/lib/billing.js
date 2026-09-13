// RunPod billing maths, kept pure so it can be tested and so the panel can
// tick every second between server refreshes.
//
// snapshot = { balance, spendPerHr, spendLimit, fetchedAt, pod: { costPerHr, uptimeSeconds, status } | null }

export function projectBilling(snapshot, nowMs = Date.now()) {
  if (!snapshot) return null
  const elapsed = Math.max(0, (nowMs - (snapshot.fetchedAt || nowMs)) / 1000)
  const spendPerHr = Number(snapshot.spendPerHr) || 0
  const balanceNow = Math.max(0, (Number(snapshot.balance) || 0) - (spendPerHr * elapsed) / 3600)
  const pod = snapshot.pod
  const running = Boolean(pod && pod.status === 'RUNNING')
  const uptimeSeconds = running ? (Number(pod.uptimeSeconds) || 0) + elapsed : Number(pod?.uptimeSeconds) || 0
  const costPerHr = Number(pod?.costPerHr) || 0
  const sessionCost = running ? (costPerHr * uptimeSeconds) / 3600 : 0
  // At the current spend, when does the balance reach zero?
  const secondsLeft = spendPerHr > 0 ? (balanceNow / spendPerHr) * 3600 : null
  return { balanceNow, spendPerHr, spendLimit: snapshot.spendLimit ?? null, running, uptimeSeconds, costPerHr, sessionCost, secondsLeft }
}

export function formatMoney(n, digits = 2) {
  if (!Number.isFinite(n)) return '—'
  return '$' + n.toFixed(n < 1 && digits < 3 ? 3 : digits)
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`
  return `${m}m ${String(sec).padStart(2, '0')}s`
}

// RunPod deducts a running pod's cost in chunks rather than per second: the
// balance sat unchanged for minutes at a time while the pod ran. The cycle is
// measured from the pod's start time. Observed to be 10 minutes (the balance
// dropped by exactly ten minutes of spend at once); the server's
// billing.cycleSeconds overrides the default.
export function chargeCycle(snapshot, nowMs = Date.now(), cycleSeconds = 600) {
  const pod = snapshot?.pod
  if (!pod || pod.status !== 'RUNNING' || !pod.startedAt) return null
  const started = Date.parse(pod.startedAt)
  if (!Number.isFinite(started)) return null
  const cycle = Number(snapshot.cycleSeconds) || cycleSeconds
  const running = Math.max(0, (nowMs - started) / 1000)
  const chargesSoFar = Math.floor(running / cycle)
  const secondsToNext = cycle - (running % cycle)
  const chargeAmount = (Number(pod.costPerHr) || 0) * (cycle / 3600)
  return { cycleSeconds: cycle, chargesSoFar, secondsToNext, chargeAmount, nextChargeAt: started + (chargesSoFar + 1) * cycle * 1000 }
}

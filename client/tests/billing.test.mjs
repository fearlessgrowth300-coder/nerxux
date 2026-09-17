import test from 'node:test'
import assert from 'node:assert/strict'
import { projectBilling, formatMoney, formatDuration } from '../src/lib/billing.js'

const snap = { balance: 9.707, spendPerHr: 0.501, spendLimit: 80, fetchedAt: 1_000_000, pod: { costPerHr: 0.49, uptimeSeconds: 1531, status: 'RUNNING' } }

test('balance, session cost and time-left tick forward from the snapshot', () => {
  const b0 = projectBilling(snap, 1_000_000)
  assert.ok(Math.abs(b0.balanceNow - 9.707) < 1e-9)
  assert.equal(b0.uptimeSeconds, 1531)
  assert.ok(Math.abs(b0.sessionCost - (0.49 * 1531) / 3600) < 1e-9)
  assert.ok(Math.abs(b0.secondsLeft - (9.707 / 0.501) * 3600) < 1e-6)
  // one hour later, with no refresh: balance down by one hour of spend, uptime up by 3600 s
  const b1 = projectBilling(snap, 1_000_000 + 3_600_000)
  assert.ok(Math.abs(b1.balanceNow - (9.707 - 0.501)) < 1e-9)
  assert.equal(b1.uptimeSeconds, 1531 + 3600)
  assert.ok(b1.secondsLeft < b0.secondsLeft)
})

test('a stopped pod costs nothing and a zero spend rate has no countdown', () => {
  const b = projectBilling({ ...snap, spendPerHr: 0, pod: { ...snap.pod, status: 'EXITED' } }, 1_000_000 + 60_000)
  assert.equal(b.running, false)
  assert.equal(b.sessionCost, 0)
  assert.equal(b.secondsLeft, null)
  assert.ok(Math.abs(b.balanceNow - 9.707) < 1e-9, 'no spend, no drain')
  assert.equal(projectBilling(null), null)
})

test('formatting', () => {
  assert.equal(formatMoney(9.707), '$9.71')
  assert.equal(formatMoney(0.49), '$0.490')
  assert.equal(formatDuration(1531), '25m 31s')
  assert.equal(formatDuration(69_762), '19h 22m 42s')
  assert.equal(formatDuration(200_000), '2d 7h 33m')
})

import { chargeCycle, kaggleSessionCountdown } from '../src/lib/billing.js'

test('the Kaggle session countdown ticks down from startedAt, capped at zero, using the server-given limit', () => {
  const startedAt = Date.parse('2026-09-17T00:00:00.000Z')
  const session = { startedAt, limitSeconds: 12 * 3600, approximate: true }

  const fresh = kaggleSessionCountdown(session, startedAt)
  assert.equal(fresh.remainingSeconds, 12 * 3600)
  assert.equal(fresh.elapsedSeconds, 0)

  const midway = kaggleSessionCountdown(session, startedAt + 3600 * 1000)
  assert.equal(midway.remainingSeconds, 11 * 3600)
  assert.equal(midway.elapsedSeconds, 3600)

  const overrun = kaggleSessionCountdown(session, startedAt + 20 * 3600 * 1000)
  assert.equal(overrun.remainingSeconds, 0, 'never goes negative once the session should have ended')

  assert.equal(kaggleSessionCountdown(null), null, 'no session (notebook never connected) means nothing to show')
  assert.equal(kaggleSessionCountdown({}), null, 'a session with no startedAt is not a real session')

  // A custom limit from the server (in case KAGGLE_SESSION_LIMIT_S ever changes) is honored.
  const custom = kaggleSessionCountdown({ startedAt, limitSeconds: 3600 }, startedAt + 1800 * 1000)
  assert.equal(custom.remainingSeconds, 1800)
})

test('the charge countdown runs from the pod start in fixed cycles', () => {
  const startedAt = '2026-09-13T13:39:05.944Z'
  const start = Date.parse(startedAt)
  const snap = { pod: { status: 'RUNNING', startedAt, costPerHr: 0.49 } }
  const c = chargeCycle(snap, start + 1531 * 1000)
  assert.equal(c.chargesSoFar, 5, '1531 s in = five 5-minute chunks taken')
  assert.equal(Math.round(c.secondsToNext), 1800 - 1531)
  assert.ok(Math.abs(c.chargeAmount - 0.49 / 12) < 1e-9, 'each chunk is five minutes of the hourly rate')
  const later = chargeCycle(snap, start + (300 * 2 + 5) * 1000)
  assert.equal(later.chargesSoFar, 2)
  assert.equal(Math.round(later.secondsToNext), 295)
  assert.equal(later.nextChargeAt, start + 3 * 300 * 1000)
  // a measured cycle from the server wins over the default
  assert.equal(chargeCycle({ ...snap, cycleSeconds: 3600 }, start + 100_000).cycleSeconds, 3600)
  assert.equal(chargeCycle({ pod: { status: 'EXITED', startedAt } }, start), null)
})

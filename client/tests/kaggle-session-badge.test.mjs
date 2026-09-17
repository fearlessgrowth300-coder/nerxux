import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import React from 'react'
import { create, act } from 'react-test-renderer'

// This is exactly the bug a screenshot caught in production: the badge's OUTER
// element was `hidden sm:flex`, so the whole thing — including the core
// countdown, not just the secondary "left this session" label — never
// rendered on a phone-width viewport at all. react-test-renderer doesn't know
// about CSS breakpoints, so the only way to catch this is to assert directly
// on the className string, the same one a browser would apply the media query to.

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/KaggleSessionBadge.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [{
    name: 'stub-compute',
    setup(b) {
      b.onResolve({ filter: /\.\.\/lib\/compute$/ }, (args) => ({ path: args.path, namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const getComputeStatus = () => globalThis.__kaggleTest.status()',
        loader: 'js',
      }))
    },
  }],
})

function load(statusFn) {
  globalThis.__kaggleTest = { status: statusFn }
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports)
  return mod.exports.default
}

// The real component starts two setInterval timers (a 1s tick, a 20s poll).
// react-test-renderer actually runs effects, so an un-unmounted instance keeps
// them alive — Node's test runner then waits forever for an event loop that
// never empties, hanging with no output. Every mount() must be unmounted.
const mounted = []
async function mount(Badge) {
  let renderer
  await act(async () => { renderer = create(React.createElement(Badge)) })
  mounted.push(renderer)
  return renderer
}
after(() => { for (const r of mounted) r.unmount() })

const words = (node) => (typeof node === 'string' ? node : (node.children || []).map(words).join(''))

test('a connected Kaggle session renders visibly on every screen width, not just desktop', async () => {
  const startedAt = Date.now() - 60_000 // one minute in
  const Badge = load(async () => ({
    mode: 'kaggle',
    details: { session: { startedAt, limitSeconds: 12 * 3600, approximate: true }, usage: { remainingSeconds: 100000, limitSeconds: 108000 } },
  }))
  const r = await mount(Badge)
  const el = r.root.findByType('span')
  // The regression: this used to be "hidden items-center ... sm:flex", which
  // Tailwind/CSS hides below the sm breakpoint (~640px) — any real phone.
  assert.doesNotMatch(el.props.className, /^hidden\b/, 'the badge must not start hidden and only reveal itself above a breakpoint')
  assert.doesNotMatch(el.props.className, /\bsm:flex\b/, 'no breakpoint-gated visibility on the outer element')
  assert.match(el.props.className, /\bflex\b/, 'must actually render as visible, unconditionally')
  assert.match(words(r.toJSON()), /11h 5[89]m/, 'shows the live countdown text (started ~1 min ago, so just under 12h left)')
})

test('renders nothing when Kaggle is not the active mode, or no session has been seen yet', async () => {
  const notKaggle = load(async () => ({ mode: 'always_on', details: {} }))
  assert.equal((await mount(notKaggle)).toJSON(), null)

  const noSession = load(async () => ({ mode: 'kaggle', details: { session: null } }))
  assert.equal((await mount(noSession)).toJSON(), null)
})

test('turns the red/low tone under an hour remaining', async () => {
  const Badge = load(async () => ({
    mode: 'kaggle',
    details: { session: { startedAt: Date.now() - (11.5 * 3600 * 1000), limitSeconds: 12 * 3600 } },
  }))
  const r = await mount(Badge)
  assert.match(r.root.findByType('span').props.className, /red/)
})

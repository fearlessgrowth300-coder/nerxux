import test from 'node:test'
import assert from 'node:assert/strict'

// A model can put anything in a tool argument. Any truthy non-string used to
// skip the bind mount while STILL sending --chdir /workspace/project, so bwrap
// died with "Can't chdir to /workspace/project" before running a command — and
// since the value is remembered for the session, one bad argument broke every
// later command too.
function normalise(projectPath) {
  return typeof projectPath === 'string' ? projectPath.trim()
    : projectPath && typeof projectPath === 'object' && typeof projectPath.path === 'string' ? projectPath.path.trim()
    : ''
}

test('junk arguments resolve to no project, not a broken chdir', () => {
  for (const bad of [true, {}, ['/root/app'], 1, '   ', null, undefined, false]) {
    assert.equal(normalise(bad), '', `${JSON.stringify(bad)} must not become a project path`)
  }
})

test('a real path is kept', () => {
  assert.equal(normalise('/root/viewe-account'), '/root/viewe-account')
  assert.equal(normalise('  /root/app  '), '/root/app')
})

test('the shape models most often send is understood, not discarded', () => {
  assert.equal(normalise({ path: '/root/app' }), '/root/app')
})

// The invariant that actually prevents the bug: the working directory must be
// decided by whether a mount happened, never by the raw argument.
test('the chdir target follows the mount', async () => {
  const src = await import('node:fs').then((fs) => fs.promises.readFile('./lib/sandbox.js', 'utf8'))
  const line = src.split('\n').find((l) => l.includes('const targetDir ='))
  assert.match(line, /projectBindMount/, 'targetDir must key off the mount, not projectPath')
  assert.doesNotMatch(line, /projectPath \?/, 'keying off the raw argument is what caused the bug')
})

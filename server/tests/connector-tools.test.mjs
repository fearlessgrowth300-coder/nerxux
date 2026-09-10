import test from 'node:test'
import assert from 'node:assert/strict'
import { selectConnectorTools, describeMatches, FIND_CONNECTOR_TOOLS } from '../lib/connectorTools.js'

// Shaped like the real Higgsfield connector: 101 tools whose definitions come
// to ~41k tokens, against a model context window of 32,768. Injecting them all
// evicted the conversation — the model never saw the task.
const HIGGSFIELD = [
  { name: 'generate_image', description: 'Generate an image from a text prompt.', input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  { name: 'generate_video', description: 'Generate a video from a prompt or image.', input_schema: { type: 'object', properties: { prompt: { type: 'string' } } } },
  { name: 'generate_audio', description: 'Generate audio or speech.', input_schema: { type: 'object', properties: {} } },
  ...Array.from({ length: 98 }, (_, i) => ({
    name: `unrelated_tool_${i}`,
    description: 'Some marketplace capability. '.repeat(30),
    input_schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
  })),
]

test('a request about images gets the image tools, not all 101', () => {
  const { tools, trimmed } = selectConnectorTools(HIGGSFIELD, 'generate me one image of a jellyfish')
  assert.equal(trimmed, true)
  assert.ok(tools.some((t) => t.name === 'generate_image'), 'the obvious tool must be offered')
  assert.ok(tools.length < 25, `offered ${tools.length}; must be a small set`)
  assert.ok(JSON.stringify(tools).length < 20000, 'the payload must fit alongside the conversation')
})

// The failure the user hit: asking to build and deploy a site dragged in a
// hundred media tools and pushed the task out of context.
test('a request about code drags in no media tools at all', () => {
  const { tools } = selectConnectorTools(HIGGSFIELD, 'create a repo, commit, push and deploy to vercel')
  assert.deepEqual(tools.map((t) => t.name), [], 'nothing media-related should be offered here')
})

test('a small connector is passed through untouched', () => {
  const small = HIGGSFIELD.slice(0, 3)
  const { tools, trimmed } = selectConnectorTools(small, 'anything at all')
  assert.equal(trimmed, false)
  assert.equal(tools.length, 3, 'no reason to filter a connector that already fits')
})

test('what is left out stays reachable', () => {
  const found = describeMatches(HIGGSFIELD, 'video')
  assert.match(found, /generate_video/)
  assert.match(found, /prompt/, 'the arguments must come back too, or it cannot be called')
})

test('a search with no match says so and lists what exists', () => {
  const found = describeMatches(HIGGSFIELD, 'quantum tunnelling')
  assert.match(found, /No connected tool matches/)
  assert.match(found, /generate_image/, 'it should still show what IS available')
})

test('the discovery tool is tiny — that is the point', () => {
  assert.ok(JSON.stringify(FIND_CONNECTOR_TOOLS).length < 800)
})

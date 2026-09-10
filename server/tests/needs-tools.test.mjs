import test from 'node:test'
import assert from 'node:assert/strict'
import { needsAgentTools, shouldAttachAgentTools } from '../lib/needsTools.js'

// The cost of getting this wrong is asymmetric: a missed tool turn means the
// model can only TALK about doing the work, which is far worse than a few
// wasted tokens. So these cases lean towards attaching.
test('real work gets the tools', () => {
  for (const t of [
    'build me a next.js landing page',
    'create a file called notes.txt with my todo list',
    'fix the bug in src/app.js',
    'run the tests and tell me what fails',
    'clone my repo and add a health endpoint',
    'push this to github',
    'npm install express and start the server',
    'read package.json',
    'list the files in the project',
    'what does this stack trace mean, and patch the error',
    'refactor the auth module',
    'set up a dockerfile',
    'search the codebase for TODO',
    'use write_file to save this',
    'debug why my python script crashes',
    'here is my code:\n```js\nconst a = 1\n```\nmake it faster',
  ]) {
    assert.equal(needsAgentTools(t), true, `should attach tools: ${t}`)
  }
})

test('plain conversation does not', () => {
  for (const t of [
    'hi',
    'hello, how are you?',
    'what is the capital of France?',
    'explain how photosynthesis works',
    'write me a poem about the sea',
    'summarise this article for me',
    'what do you think about remote work?',
    'translate this to Yoruba: good morning',
    'give me some marketing ideas for my brand',
    'who won the world cup in 2022?',
    'tell me a joke',
    '',
  ]) {
    assert.equal(needsAgentTools(t), false, `should NOT attach tools: ${t}`)
  }
})

test('a mounted project means every turn can be tool work', () => {
  assert.equal(needsAgentTools('hi', { projectPath: 'C:/Users/me/app' }), true)
  assert.equal(needsAgentTools('hi', { projectPath: null }), false)
})

test('an explicit choice always beats the heuristic', () => {
  assert.equal(shouldAttachAgentTools('off', 'build me an app'), false)
  assert.equal(shouldAttachAgentTools('on', 'hello'), true)
  assert.equal(shouldAttachAgentTools('auto', 'hello'), false)
  assert.equal(shouldAttachAgentTools('auto', 'build me an app'), true)
  // Anything unrecognised behaves as auto rather than silently disabling tools.
  assert.equal(shouldAttachAgentTools(undefined, 'build me an app'), true)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from '../node_modules/jszip/dist/jszip.min.js'
import { parseFrontmatter, readSkillsFromZip } from '../src/lib/skillArchive.js'

test('frontmatter gives the skill its name and description', () => {
  const { meta, body } = parseFrontmatter(
    '---\nname: pdf\ndescription: "Fill in and read PDF forms"\n---\n\n# PDF\nDo the thing.'
  )
  assert.equal(meta.name, 'pdf')
  assert.equal(meta.description, 'Fill in and read PDF forms')
  assert.equal(body, '# PDF\nDo the thing.')
})

test('a file with no frontmatter is still usable content', () => {
  const { meta, body } = parseFrontmatter('# Just markdown\nno frontmatter here')
  assert.deepEqual(meta, {})
  assert.match(body, /Just markdown/)
})

async function zipOf(files) {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) zip.file(path, content)
  return zip.generateAsync({ type: 'nodebuffer' })
}

test('reads one skill, its metadata and its bundled files', async () => {
  const buf = await zipOf({
    'pdf/SKILL.md': '---\nname: pdf\ndescription: Work with PDFs\n---\nInstructions here.',
    'pdf/references/forms.md': '# Forms\nhow to fill them',
    'pdf/scripts/extract.py': 'print("hi")',
  })
  const [skill] = await readSkillsFromZip(buf)
  assert.equal(skill.name, 'pdf')
  assert.equal(skill.description, 'Work with PDFs')
  assert.equal(skill.content, 'Instructions here.')
  assert.deepEqual(Object.keys(skill.resources).sort(), ['references/forms.md', 'scripts/extract.py'])
})

// A library export is one zip of many skill folders — importing only the first
// would silently lose the rest.
test('reads every skill in a multi-skill zip', async () => {
  const buf = await zipOf({
    'skills/pdf/SKILL.md': '---\nname: pdf\n---\nA',
    'skills/imagegen/SKILL.md': '---\nname: imagegen\n---\nB',
    'skills/runpod/SKILL.md': '---\nname: runpod\n---\nC',
  })
  const found = await readSkillsFromZip(buf)
  assert.deepEqual(found.map((s) => s.name).sort(), ['imagegen', 'pdf', 'runpod'])
})

test("a skill's files do not leak into its neighbour", async () => {
  const buf = await zipOf({
    'a/SKILL.md': '---\nname: a\n---\nA',
    'a/notes.md': 'belongs to a',
    'b/SKILL.md': '---\nname: b\n---\nB',
  })
  const found = await readSkillsFromZip(buf)
  const a = found.find((s) => s.name === 'a')
  const b = found.find((s) => s.name === 'b')
  assert.deepEqual(Object.keys(a.resources), ['notes.md'])
  assert.deepEqual(Object.keys(b.resources), [])
})

test('the folder name is the fallback when frontmatter has no name', async () => {
  const buf = await zipOf({ 'deep-research/SKILL.md': '# Research\nno frontmatter' })
  const [skill] = await readSkillsFromZip(buf)
  assert.equal(skill.name, 'deep-research')
})

test('a zip with no SKILL.md says so instead of importing nothing quietly', async () => {
  const buf = await zipOf({ 'notes/readme.md': 'hello' })
  await assert.rejects(() => readSkillsFromZip(buf), /No SKILL\.md/)
})

test('binary and oversized extras are skipped, not stuffed into the row', async () => {
  const buf = await zipOf({
    'x/SKILL.md': '---\nname: x\n---\nX',
    'x/logo.png': 'PNGDATA',
    'x/huge.md': 'a'.repeat(50_000),
  })
  const [skill] = await readSkillsFromZip(buf)
  assert.deepEqual(Object.keys(skill.resources), [])
  assert.equal(skill.skipped.length, 2)
})

// Real skills write their description as a YAML block scalar far more often
// than as a quoted string. Storing the literal ">-" made those skills
// undiscoverable, because the description is the only thing the model sees.
test('folded block scalars become the description', () => {
  const { meta } = parseFrontmatter(
    '---\nname: runpod\ndescription: >-\n  Manage Runpod GPU pods from the CLI.\n  Use when the user asks about pods.\nversion: 1\n---\nbody'
  )
  assert.equal(meta.description, 'Manage Runpod GPU pods from the CLI. Use when the user asks about pods.')
  assert.equal(meta.name, 'runpod')
  assert.equal(meta.version, '1')
})

test('literal block scalars keep their line breaks', () => {
  const { meta } = parseFrontmatter('---\ndescription: |\n  line one\n  line two\n---\nbody')
  assert.equal(meta.description, 'line one\nline two')
})

test('a block scalar does not swallow the key that follows it', () => {
  const { meta, body } = parseFrontmatter(
    '---\ndescription: >-\n  some text\nname: flash\n---\n# Flash'
  )
  assert.equal(meta.description, 'some text')
  assert.equal(meta.name, 'flash')
  assert.equal(body, '# Flash')
})

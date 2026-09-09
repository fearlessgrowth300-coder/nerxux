import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import React from 'react'
import { create, act } from 'react-test-renderer'
import { readWorkspace, editedHistory } from '../src/lib/chatWorkspace.js'

const stubs = {
  '../context/AuthContext': "export const useAuth = () => ({user:{id:'test-user',email:'test@example.com'}})",
  'react-router-dom': 'export const useNavigate = () => () => {}',
  '../lib/conversations': 'export const {listConversations,createConversation,listMessages,saveMessages,deleteConversation} = globalThis.__chatTest',
  '../lib/chat': 'export const {sendChat,resumeChat} = globalThis.__chatTest',
  '../lib/skills': 'export const listSkills = async () => []',
  '../lib/mcp': 'export const getConnectors = async () => []',
  '../lib/systemPrompt': "export const buildSystemPrompt = async () => ''",
  '../lib/upload': "export const uploadFile = async () => ({}); export const analysisToContext = () => ''",
  '../lib/prefs': 'export const getPrefs = () => ({saveHistory:true})',
  '@shared/models': 'export const getModelById = () => ({label:"Test model"})',
  '../components/ModelControls': 'export default () => null',
  '../components/ComputeBar': 'export default () => null',
  '../components/Markdown': 'export default ({children}) => children',
}
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/pages/Chat.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [{name:'chat-boundaries', setup(b) {
    b.onResolve({filter:/.*/}, args => args.path in stubs ? {path:args.path,namespace:'stub'} : undefined)
    b.onLoad({filter:/.*/,namespace:'stub'}, args => ({contents:stubs[args.path],loader:'js'}))
  }}],
})
const key = 'nexus.chat.test-user'
const userMessage = {id:'u1',role:'user',content:'Original message'}
const reply = {id:'a1',role:'assistant',content:'Original answer'}
function fixture(saved, {pending = false} = {}) {
  const entries = new Map(saved === undefined ? [] : [[key,JSON.stringify(saved)]])
  globalThis.localStorage = {
    getItem: k => entries.get(k) ?? null,
    setItem: (k,v) => entries.set(k,v),
    removeItem: k => entries.delete(k),
  }
  globalThis.window = {}
  globalThis.document = {addEventListener(){},removeEventListener(){}}
  const db = new Map([['first',[{id:'f1',role:'user',content:'First chat'}]], ['chosen',[userMessage,reply]]])
  let resolveReply
  const pendingReply = new Promise(resolve => {resolveReply=resolve})
  const calls = {loads:[],sends:[],saves:[]}
  const backend = {
    listConversations: async () => [...db.keys()].map(id => ({id,title:id,updated_at:new Date().toISOString()})),
    createConversation: async title => {const id='new-'+db.size;db.set(id,[]);return {id,title}},
    listMessages: async id => {calls.loads.push(id);return structuredClone(db.get(id)||[])},
    saveMessages: async (id,msgs) => {calls.saves.push({id,msgs});db.set(id,[...db.get(id),...structuredClone(msgs)])},
    deleteConversation: async id => db.delete(id),
    sendChat: async args => {calls.sends.push(args);return pending ? pendingReply : {messages:[{role:'assistant',content:'Edited answer'}]}},
    resumeChat: async () => [],
  }
  globalThis.__chatTest = backend
  const mod = {exports:{}}
  new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports)
  return {Chat:mod.exports.default,db,calls,entries,resolveReply}
}
const snapshot = () => ({version:2,conversationId:'chosen',messages:[userMessage,reply],input:'Unsent draft'})
async function mount(f) {
  let renderer
  await act(async () => {renderer=create(React.createElement(f.Chat))})
  return renderer
}
const words = node => typeof node === 'string' ? node : (node.children || []).map(words).join('')
const button = (r,label) => r.root.findAllByType('button').find(n => words(n).trim() === label)
const composer = r => r.root.findAllByType('textarea').find(n=>n.props.placeholder)
const saved = () => readWorkspace(localStorage,key)

test('reload restores the selected older chat and unsent draft instead of the first chat', async () => {
  const f=fixture(snapshot()); const r=await mount(f)
  assert.deepEqual(f.calls.loads,['chosen'])
  assert.equal(composer(r).props.value,'Unsent draft')
  assert.match(words(r.root),/Original answer/)
  assert.doesNotMatch(words(r.root),/First chat/)
  assert.equal(saved().conversationId,'chosen')
  await act(async()=>r.unmount())
})
test('new empty chat stays empty after reload', async () => {
  const f=fixture(snapshot());let r=await mount(f)
  await act(async()=>button(r,'New chat').props.onClick())
  assert.equal(saved().conversationId,null)
  assert.deepEqual(saved().messages,[])
  await act(async()=>r.unmount())
  r=await mount(f)
  assert.equal(composer(r).props.value,'')
  assert.doesNotMatch(words(r.root),/Original answer/)
  assert.equal(f.calls.loads.length,1)
  await act(async()=>r.unmount())
})
test('a new turn is saved before generation and cannot land in a different chat', async () => {
  const f=fixture({version:2,conversationId:null,messages:[],input:''},{pending:true})
  const r=await mount(f)
  await act(async()=>composer(r).props.onChange({target:{value:'New question'}}))
  let sending
  await act(async()=>{sending=button(r,'Send').props.onClick();await Promise.resolve()})
  assert.equal(f.calls.saves[0].msgs[0].content,'New question')
  assert.equal(saved().conversationId,'new-2')
  assert.equal(button(r,'New chat').props.disabled,true)
  await act(async()=>button(r,'New chat').props.onClick())
  assert.equal(saved().conversationId,'new-2')
  await act(async()=>{f.resolveReply({messages:[{role:'assistant',content:'New answer'}]});await sending})
  assert.equal(f.db.get('new-2')[1].content,'New answer')
  await act(async()=>r.unmount())
  const reloaded=await mount(f)
  assert.match(words(reloaded.root),/New answer/)
  assert.equal(saved().conversationId,'new-2')
  await act(async()=>reloaded.unmount())
})
test('edit and resend keeps the original history and restores the edited branch on reload', async () => {
  const f=fixture(snapshot());let r=await mount(f)
  await act(async()=>button(r,'Edit').props.onClick())
  const edit=r.root.findByProps({'aria-label':'Edit message'})
  await act(async()=>edit.props.onChange({target:{value:'Corrected question'}}))
  await act(async()=>button(r,'Save & resend').props.onClick())
  assert.equal(f.calls.sends[0].history[0].content,'Corrected question')
  assert.equal(f.calls.sends[0].history.length,1)
  assert.deepEqual(f.db.get('chosen'),[userMessage,reply])
  assert.equal(f.db.get('new-2')[0].content,'Corrected question')
  assert.equal(saved().conversationId,'new-2')
  await act(async()=>r.unmount());r=await mount(f)
  assert.match(words(r.root),/Corrected question/)
  assert.match(words(r.root),/Edited answer/)
  await act(async()=>r.unmount())
})
test('legacy local drafts remain readable and edits preserve attachments', () => {
  const f=fixture([userMessage])
  assert.equal(saved().conversationId,null)
  const image={id:'img',kind:'image',base64:'example'}
  const messages=[{...userMessage,attachments:[image]},reply]
  assert.deepEqual(editedHistory(messages,'u1',' revised ')[0].attachments,[image])
  assert.equal(messages[0].content,'Original message')
  assert.throws(()=>editedHistory(messages,'bad','content'))
})


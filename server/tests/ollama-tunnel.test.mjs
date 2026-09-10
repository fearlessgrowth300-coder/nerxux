import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { OllamaTunnel, podSshEndpoint, checkOllama, TURBO_MODEL, START_OLLAMA } from '../lib/ollamaTunnel.js'

test('uses the current pod SSH endpoint and never falls back to a stale port', () => {
  assert.deepEqual(podSshEndpoint({status:'RUNNING',runtime:{ports:[{private:22,public:40084,ip:'213.192.2.75'}]}}),
    {host:'213.192.2.75',port:40084})
  assert.equal(podSshEndpoint({status:'RUNNING'}),null)
  assert.equal(podSshEndpoint({status:'STOPPED',ssh:{direct:{host:'old',port:22}}}),null)
})
test('readiness requires HTTP 200 and the actual model, not just an open port', async () => {
  let status=200, body=JSON.stringify({models:[{name:TURBO_MODEL}]})
  const server=http.createServer((req,res)=>{res.writeHead(status);res.end(body)})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url='http://127.0.0.1:'+server.address().port
  try {
    assert.equal(await checkOllama(url),true)
    status=401;assert.equal(await checkOllama(url),false)
    status=200;body='not JSON';assert.equal(await checkOllama(url),false)
    body=JSON.stringify({models:[]});assert.equal(await checkOllama(url),false)
  } finally {await new Promise(resolve=>server.close(resolve))}
})
function fixture({missing=false,notReady=false}={}) {
  let time=0, runs=0
  const children=[],commands=[]
  const tunnel=new OllamaTunnel('/test/key',{
    now:()=>time,sleep:async ms=>{time+=ms},
    run:async(file,args)=>{
      commands.push(args);runs++
      if(missing)throw Object.assign(new Error('missing'),{code:42,stderr:'Persistent Ollama installation is missing on RunPod'})
      if(runs===1)throw new Error('Connection refused')
    },
    spawn:(file,args)=>{
      const child=new EventEmitter()
      child.stderr=new EventEmitter();child.args=args
      child.kill=()=>{child.emit('close',0);return true}
      children.push(child);return child
    },
    probe:async()=>!notReady,
  })
  return {tunnel,children,commands,get runs(){return runs}}
}
test('waits through SSH startup and launches persistent Ollama with strict forwarding', async () => {
  const f=fixture()
  assert.equal(await f.tunnel.start('current-host',40084),true)
  assert.equal(f.runs,2)
  assert.equal(f.commands[1].at(-1),START_OLLAMA)
  assert.match(START_OLLAMA,/OLLAMA_MODELS=\/workspace\/nerxux-ollama\/models/)
  assert.ok(f.children[0].args.includes('ExitOnForwardFailure=yes'))
  assert.ok(f.children[0].args.includes('127.0.0.1:11435:127.0.0.1:11434'))
  await f.tunnel.start('current-host',40084)
  assert.equal(f.children.length,1,'repeat click reuses a healthy tunnel')
  await f.tunnel.stop()
  assert.equal(f.tunnel.ready,false)
})
test('a late close from the old SSH process cannot clear the new connection', async () => {
  const f=fixture()
  await f.tunnel.start('host',1000)
  const old=f.children[0]
  await f.tunnel.start('host',1001)
  old.emit('close',0)
  assert.equal(f.tunnel.child,f.children[1])
  assert.equal(f.tunnel.ready,true)
  await f.tunnel.stop()
})
// A pod with nothing installed is the NORMAL state of a freshly created pod,
// not an error to hand back. Rather than telling the user Ollama is missing and
// leaving them to work out what to paste into RunPod's web terminal, the pod
// installs itself and the message says what is happening.
function freshPodTunnel({ tail = '' } = {}) {
  const sent = []
  const tunnel = new OllamaTunnel('/test/key', {
    now: () => 0, sleep: async () => {},
    run: async (file, args) => {
      const command = args[args.length - 1]
      sent.push(command)
      if (command === START_OLLAMA) throw Object.assign(new Error('missing'), { code: 42, stderr: 'not installed' })
      if (command.startsWith('tail ')) return { stdout: tail }
      return { stdout: '' }
    },
    spawn: () => { throw new Error('must not open a tunnel to an unprovisioned pod') },
  })
  return { tunnel, sent }
}

test('a pod with nothing installed provisions itself instead of just failing', async () => {
  const f = freshPodTunnel()
  await assert.rejects(() => f.tunnel.start('host', 1000), /installing Ollama and downloading/)
  assert.ok(f.sent.some((c) => c.includes('ollama-linux-amd64.tgz')), 'the install must actually be sent to the pod')
  assert.ok(f.sent.some((c) => c.includes(TURBO_MODEL)), 'it must pull the model Turbo needs')
  assert.equal(f.tunnel.ready, false)
})

test('a setup already running reports its progress rather than starting a second 17GB download', async () => {
  const f = freshPodTunnel({ tail: '[3/3] pulling the model (~17GB, this is the slow part)...' })
  await assert.rejects(() => f.tunnel.start('host', 1000), /this is the slow part/)
  assert.ok(!f.sent.some((c) => c.includes('ollama-linux-amd64.tgz')), 'must not re-run the installer')
})

test('a finished setup that is not answering yet says so, instead of claiming Turbo is live', async () => {
  const f = freshPodTunnel({ tail: 'PROVISION_DONE' })
  await assert.rejects(() => f.tunnel.start('host', 1000), /not answering yet/)
  assert.equal(f.tunnel.ready, false)
})
test('failed model readiness closes the tunnel rather than leaving an orphan listener', async () => {
  const f=fixture({notReady:true})
  await assert.rejects(()=>f.tunnel.start('host',1000),/did not load the required model/)
  assert.equal(f.tunnel.child,null)
  assert.equal(f.tunnel.ready,false)
})


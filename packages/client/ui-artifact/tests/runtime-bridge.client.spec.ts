// @vitest-environment jsdom
import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ArtifactRuntimeId, ArtifactRuntimeIdentity } from '@agentrans/artifact-runtime/types'
import type { ArtifactId } from '@agentrans/artifact/types'
import { createArtifactDocument } from '../src/client/document.ts'
import { ARTIFACT_RUNTIME_FAILURE_MAX_BYTES, parseArtifactRuntimeMessage } from '../src/client/runtime-messages.ts'

const identity: ArtifactRuntimeIdentity = {
  artifactId: 'runtime-source' as ArtifactId, revision: 1, runtimeId: 'runtime-a' as ArtifactRuntimeId, renderer: 'html',
}

function program(source = '<p>Not initialized</p>', current = identity) {
  const posts: unknown[] = []
  const virtualConsole = new VirtualConsole()
  const dom = new JSDOM(createArtifactDocument(source, current), {
    runScripts: 'dangerously', virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'TextEncoder', { value: TextEncoder })
      Object.defineProperty(window, 'postMessage', { value: (value: unknown) => { posts.push(JSON.parse(JSON.stringify(value))) } })
    },
  })
  onTestFinished(() => { dom.window.close() })
  const messages = () => posts.flatMap((value) => {
    const parsed = parseArtifactRuntimeMessage(value, current)
    return parsed === null ? [] : [parsed]
  })
  const reports = () => messages().flatMap(message => message.kind === 'artifact-runtime-report' ? [message.report] : [])
  const results = () => messages().flatMap(message => message.kind === 'artifact-runtime-command-result' ? [message.result] : [])
  const states = () => messages().flatMap(message => message.kind === 'artifact-runtime-state' ? [message.state] : [])
  const send = (data: unknown, fromParent = true): void => {
    const event = new dom.window.MessageEvent('message', { data })
    Object.defineProperty(event, 'source', { value: fromParent ? dom.window : null })
    dom.window.dispatchEvent(event)
  }
  const command = (name: string, requestId = 'command-a', addressed = current): void => {
    send({ kind: 'artifact-runtime-command', identity: addressed, requestId, command: name })
  }
  return { dom, posts, messages, reports, results, states, send, command }
}

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe('injected Artifact runtime bridge', () => {
  it('stays starting after load and replays its actual status on a matching query', () => {
    const probe = program()
    expect(probe.reports()).toEqual([{ status: 'starting' }])
    probe.dom.window.dispatchEvent(new probe.dom.window.Event('load'))
    expect(probe.reports()).toEqual([{ status: 'starting' }])
    probe.send({ kind: 'artifact-runtime-request-status', identity })
    expect(probe.reports()).toEqual([{ status: 'starting' }, { status: 'starting' }])
  })

  it('installs before authored scripts and derives only implemented capabilities', () => {
    const probe = program('<script>window.artifactRuntime.ready({state:()=>({count:0}),commands:{step:()=>{}}})</script>')
    expect(probe.reports()).toEqual([
      { status: 'starting' }, { status: 'ready', capabilities: { state: true, commands: ['step'] } },
    ])
    expect(probe.states()).toEqual([{ count: 0 }])
    probe.send({ kind: 'artifact-runtime-request-status', identity })
    expect(probe.reports().at(-1)).toEqual({ status: 'ready', capabilities: { state: true, commands: ['step'] } })
    expect(probe.states()).toEqual([{ count: 0 }, { count: 0 }])
    probe.dom.window.eval('window.artifactRuntime.ready({commands:{play:true}})')
    expect(probe.reports().at(-1)).toMatchObject({ status: 'error', error: { code: 'INVALID_CAPABILITIES' } })
  })

  it('waits for the actual command callback and samples its resulting state', async () => {
    const probe = program(`<script>
      let count=0;
      window.artifactRuntime.ready({state:()=>({count}),commands:{step:()=>new Promise(resolve=>{
        window.finishStep=()=>{count++;resolve()}
      })}});
    </script>`)
    probe.command('step')
    await settle()
    expect(probe.results()).toEqual([])
    probe.dom.window.eval('window.finishStep()')
    await settle()
    expect(probe.results()).toEqual([{ ok: true }])
    expect(probe.states()).toEqual([{ count: 0 }, { count: 1 }])
    probe.command('play', 'unsupported')
    await settle()
    expect(probe.results().at(-1)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_COMMAND' } })
  })

  it('rejects stale identities and messages outside its actual parent', async () => {
    const probe = program('<script>window.artifactRuntime.ready({commands:{step:()=>{document.body.dataset.changed=\'yes\'}}})</script>')
    for (const changed of [{ runtimeId: 'old' }, { revision: 0 }, { artifactId: 'old' }, { renderer: 'native' }]) {
      probe.send({ kind: 'artifact-runtime-command', identity: { ...identity, ...changed }, requestId: 'stale', command: 'step' })
    }
    probe.send({ kind: 'artifact-runtime-command', identity, requestId: 'foreign', command: 'step' }, false)
    await settle()
    expect(probe.results()).toEqual([])
    expect(probe.dom.window.document.body.dataset.changed).toBeUndefined()
    probe.command('step')
    await settle()
    expect(probe.dom.window.document.body.dataset.changed).toBe('yes')
    expect(probe.results()).toEqual([{ ok: true }])
  })

  it('reports callback failure until explicit recovery and keeps a new revision independent', async () => {
    const failed = program('<script>window.artifactRuntime.ready({commands:{step:()=>{throw new Error(\'Variant step failed\')}}})</script>')
    failed.command('step')
    await settle()
    expect(failed.reports().at(-1)).toEqual({ status: 'error', error: { code: 'COMMAND_FAILED', message: 'Variant step failed' } })
    expect(failed.results()).toEqual([{ ok: false, error: { code: 'COMMAND_FAILED', message: 'Variant step failed' } }])
    failed.send({ kind: 'artifact-runtime-request-status', identity })
    expect(failed.reports().at(-1)).toMatchObject({ status: 'error' })
    failed.command('step', 'after-error')
    await settle()
    expect(failed.results().at(-1)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_COMMAND' } })
    failed.dom.window.eval('window.artifactRuntime.ready({commands:{step:()=>{}}})')
    expect(failed.reports().at(-1)).toMatchObject({ status: 'ready' })

    const replacement = program('<script>window.artifactRuntime.ready({commands:{step:()=>{}}})</script>', {
      ...identity, revision: 2, runtimeId: 'runtime-b' as ArtifactRuntimeId,
    })
    replacement.command('step', 'stale', identity)
    await settle()
    expect(replacement.results()).toEqual([])
    expect(replacement.reports().at(-1)).toMatchObject({ status: 'ready' })
    expect(failed.reports().at(-1)).toMatchObject({ status: 'ready' })
  })

  it('bounds complete errors including escaped Unicode and reports script and promise failures', () => {
    const probe = program('<script>throw new Error(\'Startup failed\')</script>')
    expect(probe.reports().at(-1)).toEqual({ status: 'error', error: { code: 'SCRIPT_ERROR', message: 'Startup failed' } })
    probe.dom.window.eval('window.artifactRuntime.error((\'😀\u0000\').repeat(2000))')
    const latest = probe.reports().at(-1)
    expect(latest?.status).toBe('error')
    if (latest?.status !== 'error') throw new Error('Expected bounded runtime failure')
    expect(new TextEncoder().encode(JSON.stringify(latest.error)).byteLength).toBeLessThanOrEqual(ARTIFACT_RUNTIME_FAILURE_MAX_BYTES)
    expect(latest.error.message).not.toBe('')
    const rejection = new probe.dom.window.Event('unhandledrejection')
    Object.defineProperty(rejection, 'reason', { value: 'Promise failed' })
    probe.dom.window.dispatchEvent(rejection)
    expect(probe.reports().at(-1)).toEqual({ status: 'error', error: { code: 'UNHANDLED_REJECTION', message: 'Promise failed' } })
  })

  it('sends no state without an implemented reader and rejects unsupported or unbounded JSON', () => {
    const probe = program(`<script>
      window.artifactRuntime.ready({}); window.artifactRuntime.reportState({ignored:true});
    </script>`)
    expect(probe.states()).toEqual([])
    probe.dom.window.eval('window.artifactRuntime.ready({state:()=>({value:NaN})})')
    expect(probe.reports().at(-1)).toMatchObject({ status: 'error', error: { code: 'INVALID_STATE' } })
    probe.dom.window.eval('window.artifactRuntime.ready({state:()=>({value:\'😀\'.repeat(5000)})})')
    expect(probe.reports().at(-1)).toMatchObject({ status: 'error', error: { code: 'INVALID_STATE' } })
    probe.dom.window.eval('window.artifactRuntime.ready({state:()=>{throw new Error(\'State failed\')}})')
    expect(probe.reports().at(-1)).toMatchObject({ status: 'error', error: { code: 'STATE_FAILED' } })
  })

  it.each([
    '({value:-0})', '[1,,2]', '({value:undefined})', 'Object.assign([1],{extra:2})',
    'Object.defineProperty({},"hidden",{value:1})', '({[Symbol("key")]:1})', 'Object.create({inherited:1})',
  ])('rejects non-lossless initial data without announcing ready or forwarding normalized state: %s', (expression) => {
    const probe = program(`<script>window.artifactRuntime.ready({state:()=>(${expression})})</script>`)
    expect(probe.reports().map(report => report.status)).toEqual(['starting', 'error'])
    expect(probe.reports().at(-1)).toMatchObject({ status: 'error', error: { code: 'INVALID_STATE' } })
    expect(probe.states()).toEqual([])
  })

  it('rejects initial accessors without evaluating them during validation or sending', () => {
    const probe = program(`<body><script>
      window.artifactRuntime.ready({state:()=>Object.defineProperty({},'value',{
        enumerable:true,get:()=>{document.body.dataset.getterRead='yes';return 1}
      })});
    </script></body>`)
    expect(probe.reports().map(report => report.status)).toEqual(['starting', 'error'])
    expect(probe.dom.window.document.body.dataset.getterRead).toBeUndefined()
    expect(probe.states()).toEqual([])
  })

  it('explains a later non-lossless report without forwarding changed data', () => {
    const probe = program('<script>window.artifactRuntime.ready({state:()=>({count:1})})</script>')
    probe.dom.window.eval('window.artifactRuntime.reportState({count:-0})')
    expect(probe.reports().at(-1)).toEqual({ status: 'error', error: {
      code: 'INVALID_STATE', message: 'State must be bounded lossless plain-data JSON',
    } })
    expect(probe.states()).toEqual([{ count: 1 }])
  })

  it('escapes identity data inside the injected script', () => {
    const value: ArtifactRuntimeIdentity = { ...identity, runtimeId: '</script><p id="injected">bad</p>' as ArtifactRuntimeId }
    const probe = program('<p id="authored">Safe</p>', value)
    expect(probe.dom.window.document.getElementById('injected')).toBeNull()
    expect(probe.dom.window.document.getElementById('authored')?.textContent).toBe('Safe')
    expect(probe.reports()).toEqual([{ status: 'starting' }])
  })
})

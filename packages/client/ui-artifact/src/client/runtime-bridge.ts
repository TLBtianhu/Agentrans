/** Self-contained program API injected before authored HTML scripts in one opaque iframe. */
import type { ArtifactRuntimeCommand, ArtifactRuntimeFailure, ArtifactRuntimeIdentity, RuntimeReport } from '@agentrans/artifact-runtime/types'
import { isBoundedArtifactJson } from '@agentrans/artifact/runtime-values'
import { ARTIFACT_ACTION_MAX_BYTES, ARTIFACT_ACTION_MAX_DEPTH, ARTIFACT_ACTION_MAX_NODES } from './messages.ts'
import { ARTIFACT_RUNTIME_FAILURE_MAX_BYTES } from './runtime-messages.ts'

interface BridgeLimits {
  readonly messageBytes: number
  readonly failureBytes: number
  readonly depth: number
  readonly nodes: number
}

function installArtifactRuntime(
  identity: ArtifactRuntimeIdentity,
  limits: BridgeLimits,
  isJson: typeof isBoundedArtifactJson,
): void {
  const commands: readonly ArtifactRuntimeCommand[] = ['play', 'pause', 'step', 'reset']
  let report: RuntimeReport = { status: 'starting' }
  let stateReader: (() => unknown) | undefined
  let handlers: Partial<Record<ArtifactRuntimeCommand, () => unknown>> = {}

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
  function callback(value: unknown): value is () => unknown { return typeof value === 'function' }
  function matches(value: unknown): boolean {
    return isRecord(value) && Object.keys(value).length === 4
      && value.artifactId === identity.artifactId && value.revision === identity.revision
      && value.runtimeId === identity.runtimeId && value.renderer === identity.renderer
  }
  function valid(value: unknown): boolean {
    return isJson(value, limits.depth, limits.nodes)
      && new TextEncoder().encode(JSON.stringify(value)).byteLength <= limits.messageBytes
  }
  function send(value: unknown): boolean {
    if (!valid(value)) return false
    window.parent.postMessage(value, '*')
    return true
  }
  function diagnostic(code: string, value: unknown): ArtifactRuntimeFailure {
    const text = (typeof value === 'string' ? value : value instanceof Error ? value.message : 'Artifact program failed').slice(0, limits.failureBytes)
    let low = 0
    let high = text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (new TextEncoder().encode(JSON.stringify({ code, message: text.slice(0, middle) })).byteLength <= limits.failureBytes) low = middle
      else high = middle - 1
    }
    if (low > 0 && /[\uD800-\uDBFF]/.test(text.charAt(low - 1))) low -= 1
    return { code, message: text.slice(0, low) }
  }
  function publish(): void { send({ kind: 'artifact-runtime-report', identity, report }) }
  function fail(code: string, value: unknown): ArtifactRuntimeFailure {
    const error = diagnostic(code, value)
    report = { status: 'error', error }
    stateReader = undefined
    handlers = {}
    publish()
    return error
  }
  function reportState(state: unknown): void {
    if (report.status !== 'ready' || stateReader === undefined) return
    if (!send({ kind: 'artifact-runtime-state', identity, state })) fail('INVALID_STATE', 'State must be bounded lossless plain-data JSON')
  }
  function sampleState(): void {
    if (report.status !== 'ready' || stateReader === undefined) return
    let state: unknown
    try { state = stateReader() }
    catch (error) { fail('STATE_FAILED', error); return }
    reportState(state)
  }
  function ready(options: unknown = {}): void {
    if (!isRecord(options) || Object.keys(options).some(key => key !== 'state' && key !== 'commands')
      || (options.state !== undefined && !callback(options.state))
      || (options.commands !== undefined && !isRecord(options.commands))) {
      fail('INVALID_CAPABILITIES', 'Declare state and commands as implemented callbacks')
      return
    }
    const declared = options.commands ?? {}
    if (!isRecord(declared)
      || Object.keys(declared).some(key => !commands.includes(key as ArtifactRuntimeCommand) || !callback(declared[key]))) {
      fail('INVALID_CAPABILITIES', 'Only implemented play, pause, step and reset callbacks may be declared')
      return
    }
    const nextHandlers: Partial<Record<ArtifactRuntimeCommand, () => unknown>> = {}
    for (const command of commands) {
      if (Object.hasOwn(declared, command) && callback(declared[command])) nextHandlers[command] = declared[command]
    }
    handlers = nextHandlers
    stateReader = callback(options.state) ? options.state : undefined
    let initial: unknown
    if (stateReader !== undefined) {
      try { initial = stateReader() }
      catch (error) { fail('STATE_FAILED', error); return }
      if (!valid({ kind: 'artifact-runtime-state', identity, state: initial })) {
        fail('INVALID_STATE', 'State must be bounded lossless plain-data JSON')
        return
      }
    }
    report = { status: 'ready', capabilities: { state: stateReader !== undefined, commands: commands.filter(command => handlers[command] !== undefined) } }
    publish()
    if (stateReader !== undefined) reportState(initial)
  }
  async function receive(event: MessageEvent): Promise<void> {
    if (event.source !== window.parent || !isRecord(event.data) || !matches(event.data.identity)) return
    const data = event.data
    if (data.kind === 'artifact-runtime-request-status' && Object.keys(data).length === 2) {
      publish()
      sampleState()
      return
    }
    if (data.kind !== 'artifact-runtime-command' || Object.keys(data).length !== 4
      || typeof data.requestId !== 'string' || data.requestId.length === 0
      || new TextEncoder().encode(data.requestId).byteLength > 128
      || !commands.includes(data.command as ArtifactRuntimeCommand)) return
    const handler = report.status === 'ready' ? handlers[data.command as ArtifactRuntimeCommand] : undefined
    const result = handler === undefined
      ? { ok: false, error: diagnostic('UNSUPPORTED_COMMAND', 'The current runtime has no ready handler for this command') }
      : await (async () => {
        try { await handler() }
        catch (error) { return { ok: false, error: fail('COMMAND_FAILED', error) } }
        sampleState()
        return { ok: true }
      })()
    send({ kind: 'artifact-runtime-command-result', identity, requestId: data.requestId, result })
  }
  Object.defineProperty(window, 'artifactRuntime', {
    value: Object.freeze({ ready, reportState, error: (message: unknown) => { fail('PROGRAM_ERROR', message) } }),
    configurable: false, writable: false,
  })
  window.addEventListener('message', (event) => { void receive(event) })
  window.addEventListener('error', (event) => { fail('SCRIPT_ERROR', event.message) })
  window.addEventListener('unhandledrejection', (event) => { fail('UNHANDLED_REJECTION', event.reason) })
  publish()
}

/**
 * Build the isolated program API; only explicit ready and completed callbacks produce acknowledgements.
 * @param identity - Current source revision and unique physical iframe identity.
 * @returns Self-contained script text with safely encoded identity and fixed protocol bounds.
 */
export function buildArtifactRuntimeBridge(identity: ArtifactRuntimeIdentity): string {
  const limits: BridgeLimits = {
    messageBytes: ARTIFACT_ACTION_MAX_BYTES, failureBytes: ARTIFACT_RUNTIME_FAILURE_MAX_BYTES,
    depth: ARTIFACT_ACTION_MAX_DEPTH, nodes: ARTIFACT_ACTION_MAX_NODES,
  }
  const json = JSON.stringify({ identity, limits }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `;(${installArtifactRuntime.toString()})(${json}.identity,${json}.limits,(${isBoundedArtifactJson.toString()}));`
}

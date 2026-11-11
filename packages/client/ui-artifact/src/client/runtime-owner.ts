/** Session-bound ownership of actual renderer reports, live Host registration, and command acknowledgements. */
import { randomUUID } from '@agentrans/util-crypto'
import { deepEqualJson, type JsonValue } from '@agentrans/util-values'
import type { ObservableSnapshot } from '@agentrans/client-store'
import type { ArtifactRuntimeCommand, ArtifactRuntimeIdentity, RuntimeAck, RuntimeReport } from '@agentrans/artifact-runtime/types'
import type { BrowserArtifactRuntimeMessage } from './runtime-messages.ts'

/** The report stream owned by one mounted renderer. */
export interface RuntimeChannel extends AsyncIterable<RuntimeAck> {
  send(report: RuntimeReport): void
  dispose(): void
}

/** Actual renderer reports and independently acknowledged Host delivery. */
export interface ArtifactRuntimeSnapshot {
  readonly identity: ArtifactRuntimeIdentity
  readonly report: RuntimeReport
  readonly host: 'connecting' | 'pending' | 'accepted' | 'unavailable' | 'denied'
  readonly state?: JsonValue | undefined
  readonly command: 'idle' | 'pending' | 'failed'
}

/** Narrow callbacks shared by the card and comparison surface. */
export interface ArtifactRuntimeActions {
  readonly mount: (key: string, identity: ArtifactRuntimeIdentity,
    dispatch?: (requestId: string, command: ArtifactRuntimeCommand) => void) => () => void
  readonly report: (key: string, identity: ArtifactRuntimeIdentity, report: RuntimeReport) => void
  readonly state: (key: string, identity: ArtifactRuntimeIdentity, state: JsonValue) => void
  readonly message: (key: string, identity: ArtifactRuntimeIdentity, message: BrowserArtifactRuntimeMessage) => void
  readonly command: (key: string, command: ArtifactRuntimeCommand) => Promise<void>
}

type RuntimeLease = {
  readonly identity: ArtifactRuntimeIdentity
  readonly abort: AbortController
  readonly channel: RuntimeChannel
  readonly dispatch?: (requestId: string, command: ArtifactRuntimeCommand) => void
  attached: boolean
  sequence: number
  pending: Map<string, {
    readonly resolve: () => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>
}

class RuntimeSource implements ObservableSnapshot<ArtifactRuntimeSnapshot | undefined> {
  private value: ArtifactRuntimeSnapshot | undefined
  private lease: RuntimeLease | undefined
  private readonly listeners = new Set<() => void>()

  constructor(private readonly open: (identity: ArtifactRuntimeIdentity, signal: AbortSignal) => RuntimeChannel,
    private readonly commandTimeoutMs: number) {}

  readonly getSnapshot = (): ArtifactRuntimeSnapshot | undefined => this.value
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  mount(identity: ArtifactRuntimeIdentity, dispatch?: (requestId: string, command: ArtifactRuntimeCommand) => void): () => void {
    this.release()
    const abort = new AbortController()
    this.value = { identity, report: { status: 'starting' }, host: 'connecting', command: 'idle' }
    this.publish()
    let channel: RuntimeChannel
    try { channel = this.open(identity, abort.signal) } catch (error) {
      this.fail(error)
      return () => { if (this.value?.identity.runtimeId === identity.runtimeId) this.release() }
    }
    const lease: RuntimeLease = { identity, abort, channel, ...dispatch === undefined ? {} : { dispatch },
      attached: false, sequence: 0, pending: new Map() }
    this.lease = lease
    void this.follow(lease)
    return () => { if (this.value?.identity.runtimeId === identity.runtimeId) this.release() }
  }

  report(identity: ArtifactRuntimeIdentity, report: RuntimeReport): void {
    const lease = this.current(identity)
    if (lease === undefined || this.value === undefined || deepEqualJson(this.value.report, report)) return
    this.value = { ...this.value, report, ...report.status === 'ready' && report.capabilities.state ? {} : { state: undefined } }
    if (lease.attached) this.send(lease, report)
    this.publish()
  }

  state(identity: ArtifactRuntimeIdentity, state: JsonValue): void {
    if (this.current(identity) === undefined || this.value?.report.status !== 'ready' || !this.value.report.capabilities.state) return
    if (deepEqualJson(this.value.state, state)) return
    this.value = { ...this.value, state }
    this.publish()
  }

  message(identity: ArtifactRuntimeIdentity, message: BrowserArtifactRuntimeMessage): void {
    if (this.current(identity) === undefined) return
    switch (message.kind) {
      case 'artifact-runtime-report': this.report(identity, message.report); return
      case 'artifact-runtime-state': this.state(identity, message.state); return
      case 'artifact-runtime-command-result': {
        const lease = this.current(identity)
        const pending = lease?.pending.get(message.requestId)
        if (pending === undefined || lease === undefined) return
        lease.pending.delete(message.requestId)
        clearTimeout(pending.timer)
        if (message.result.ok) pending.resolve()
        else pending.reject(new Error(message.result.error.message))
        return
      }
    }
  }

  async command(command: ArtifactRuntimeCommand): Promise<void> {
    const lease = this.lease
    if (lease?.dispatch === undefined || this.value?.host !== 'accepted' || this.value.report.status !== 'ready'
      || !this.value.report.capabilities.commands.includes(command) || lease.pending.size !== 0) throw new Error('Artifact command is unavailable')
    const requestId = randomUUID()
    const completed = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      lease.pending.delete(requestId)
      completed.reject(new Error('Artifact command acknowledgement timed out'))
    }, this.commandTimeoutMs)
    lease.pending.set(requestId, { resolve: () => { completed.resolve() }, reject: completed.reject, timer })
    this.value = { ...this.value, command: 'pending' }
    this.publish()
    try {
      lease.dispatch(requestId, command)
      await completed.promise
      const current = this.activeSnapshot(lease)
      if (current !== undefined) this.value = { ...current, command: 'idle' }
    } catch (error) {
      const current = this.activeSnapshot(lease)
      if (current !== undefined) this.value = { ...current, command: 'failed' }
      throw error
    } finally {
      clearTimeout(timer)
      lease.pending.delete(requestId)
      this.publish()
    }
  }

  release(): void {
    const lease = this.lease
    this.lease = undefined
    this.value = undefined
    lease?.abort.abort()
    lease?.channel.dispose()
    if (lease !== undefined) this.rejectCommands(lease)
    this.publish()
  }

  private current(identity: ArtifactRuntimeIdentity): RuntimeLease | undefined {
    return this.lease?.identity.runtimeId === identity.runtimeId && this.lease.identity.artifactId === identity.artifactId
      && this.lease.identity.revision === identity.revision ? this.lease : undefined
  }

  private activeSnapshot(lease: RuntimeLease): ArtifactRuntimeSnapshot | undefined {
    return this.lease === lease ? this.value : undefined
  }

  private async follow(lease: RuntimeLease): Promise<void> {
    try {
      for await (const ack of lease.channel) {
        if (this.lease !== lease || this.value === undefined) return
        if (ack.kind === 'attached') {
          lease.attached = true
          this.send(lease, this.value.report)
        } else if (ack.sequence === lease.sequence) this.value = { ...this.value, host: 'accepted' }
        this.publish()
      }
      if (this.lease === lease) this.fail(new Error('Artifact runtime stream ended'))
    } catch (error) {
      if (this.lease === lease) this.fail(error)
    }
  }

  private send(lease: RuntimeLease, report: RuntimeReport): void {
    if (this.value === undefined) return
    try {
      lease.sequence += 1
      lease.channel.send(report)
      this.value = { ...this.value, host: 'pending' }
    } catch (error) { this.fail(error) }
  }

  private fail(error: unknown): void {
    if (this.value === undefined) return
    const denied = typeof error === 'object' && error !== null && 'code' in error
      && (error.code === 'remote-access/denied' || error.code === 'gateway/access-denied')
    this.value = { ...this.value, report: { status: 'starting' }, state: undefined, host: denied ? 'denied' : 'unavailable',
      command: this.value.command === 'pending' ? 'failed' : this.value.command }
    const lease = this.lease
    this.lease = undefined
    lease?.abort.abort()
    lease?.channel.dispose()
    if (lease !== undefined) this.rejectCommands(lease)
    this.publish()
  }

  private rejectCommands(lease: RuntimeLease): void {
    for (const pending of lease.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Artifact runtime was released'))
    }
    lease.pending.clear()
  }

  private publish(): void { for (const listener of this.listeners) listener() }
}

/** One report and command owner per live Session binding; it never records or wakes model input. */
export class ArtifactRuntimeOwner {
  private readonly sources = new Map<string, RuntimeSource>()
  private disposed = false
  private readonly inactive: ObservableSnapshot<ArtifactRuntimeSnapshot | undefined> = {
    getSnapshot: () => undefined, subscribe: () => () => {},
  }
  /**
   * @param open - The serving Host's live duplex registration.
   * @param commandTimeoutMs - Maximum wait for actual program acknowledgement.
   */
  constructor(private readonly open: (identity: ArtifactRuntimeIdentity, signal: AbortSignal) => RuntimeChannel,
    private readonly commandTimeoutMs: number) {}
  /**
   * Read the stable source for one preview's framework keyed hook.
   * @param key - Node/Artifact identity.
   * @returns Stable source for framework keyed hooks.
   */
  source(key: string): ObservableSnapshot<ArtifactRuntimeSnapshot | undefined> { return this.disposed ? this.inactive : this.get(key) }
  /** Narrow mutation callbacks; no component receives the owner. */
  readonly actions: ArtifactRuntimeActions = {
    mount: (key, identity, dispatch) => this.disposed ? () => {} : this.get(key).mount(identity, dispatch),
    report: (key, identity, report) => { if (!this.disposed) this.get(key).report(identity, report) },
    state: (key, identity, state) => { if (!this.disposed) this.get(key).state(identity, state) },
    message: (key, identity, message) => { if (!this.disposed) this.get(key).message(identity, message) },
    command: (key, command) => this.disposed ? Promise.reject(new Error('Artifact runtime owner was released')) : this.get(key).command(command),
  }
  /** Release streams and pending commands with the Session binding. */
  dispose(): void {
    this.disposed = true
    for (const source of this.sources.values()) source.release()
    this.sources.clear()
  }
  private get(key: string): RuntimeSource {
    let source = this.sources.get(key)
    if (source === undefined) { source = new RuntimeSource(this.open, this.commandTimeoutMs); this.sources.set(key, source) }
    return source
  }
}

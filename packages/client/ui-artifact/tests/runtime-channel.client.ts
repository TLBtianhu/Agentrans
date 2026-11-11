/** In-memory duplex carrier for exercising the real browser runtime owner. */
import type { RuntimeAck } from '@agentrans/artifact-runtime/types'
import type { RuntimeChannel } from '../src/client/runtime-owner.ts'

/** @returns A controllable channel with real asynchronous Host-style acceptance. */
export function runtimeChannel(): RuntimeChannel & { readonly push: (ack: RuntimeAck) => void } {
  const queue: RuntimeAck[] = [{ kind: 'attached' }]
  let sequence = 0
  let closed = false
  let changed = Promise.withResolvers<undefined>()
  const push = (ack: RuntimeAck): void => { queue.push(ack); changed.resolve(undefined) }
  return {
    push,
    send: () => { push({ kind: 'accepted', sequence: ++sequence }) },
    dispose: () => { closed = true; changed.resolve(undefined) },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        const ack = queue.shift()
        if (ack !== undefined) { yield ack; continue }
        await changed.promise
        changed = Promise.withResolvers<undefined>()
      }
    },
  }
}

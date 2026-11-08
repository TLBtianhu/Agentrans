/** Bounded lossless plain-data JSON shared by Host admission, browser parsers, and isolated program bridges. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Maximum nested protocol values, including the root. */
export const ARTIFACT_JSON_MAX_DEPTH = 32
/** Maximum visited protocol values, including repeated references. */
export const ARTIFACT_JSON_MAX_NODES = 2048
/** Maximum UTF-8 bytes of one complete JSON-encoded program diagnostic. */
export const ARTIFACT_RUNTIME_FAILURE_MAX_BYTES = 1024

/**
 * Validate bounded JSON without invoking accessors, normalizing data, or depending on outer runtime values.
 * @param value - Candidate program report or message.
 * @param maxDepth - Positive maximum nesting depth, including the root.
 * @param maxNodes - Positive maximum visited-value count, including repeated references.
 * @returns Whether the plain-data subset round-trips without discarded values, keys, or signed zero;
 * accessors are rejected rather than evaluated as in a general JSON snapshot.
 */
export function isBoundedArtifactJson(value: unknown, maxDepth: number, maxNodes: number): value is JsonValue {
  function intrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
    const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
    return typeof constructor === 'function' && constructor.name === name && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === 'Array' ? Array : Object)
  }
  function objectPrototype(value: object): boolean {
    return Object.getPrototypeOf(value) === null && intrinsicConstructor(value, 'Object')
  }
  const ancestors = new WeakSet<object>()
  const pending: Array<{ readonly value: unknown; readonly depth: number; readonly exit: boolean }> = [{ value, depth: 1, exit: false }]
  let nodes = 0
  try {
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      if (current.exit) {
        ancestors.delete(current.value as object)
        continue
      }
      nodes += 1
      if (nodes > maxNodes || current.depth > maxDepth) return false
      const item = current.value
      if (item === null || typeof item === 'string' || typeof item === 'boolean') continue
      if (typeof item === 'number') {
        if (Number.isFinite(item) && !Object.is(item, -0)) continue
        return false
      }
      if (typeof item !== 'object' || ancestors.has(item)) return false
      const prototype: unknown = Object.getPrototypeOf(item)
      if (Array.isArray(item)) {
        if (!Array.isArray(prototype) || !intrinsicConstructor(prototype, 'Array')) return false
        const base: unknown = Object.getPrototypeOf(prototype)
        if (typeof base !== 'object' || base === null || !objectPrototype(base)
          || item.length > maxNodes - nodes || Reflect.ownKeys(item).length !== item.length + 1) return false
      } else if (prototype !== null && (typeof prototype !== 'object' || !objectPrototype(prototype))) return false
      ancestors.add(item)
      pending.push({ value: item, depth: current.depth, exit: true })
      const keys = Array.isArray(item) ? Array.from({ length: item.length }, (_unused, index) => String(index)) : Reflect.ownKeys(item)
      for (const key of keys) {
        if (typeof key !== 'string') return false
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false
        pending.push({ value: descriptor.value, depth: current.depth + 1, exit: false })
      }
    }
    return true
  } catch (_error) {
    // Values whose reflection traps fail are not an inspectable JSON report.
    return false
  }
}

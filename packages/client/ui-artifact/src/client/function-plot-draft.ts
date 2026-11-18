/** Browser-tab recovery for one confirmed native function plot per Session. */
import type { ArtifactPromptContextSelection } from '@agentrans/artifact-followup/types'
import type { ArtifactId } from '@agentrans/artifact/types'
import type { SessionId } from '@agentrans/session/types'

/** The exact native source address and reviewed plot inputs. */
export interface FunctionPlotDraft {
  readonly key: string
  readonly sourceSeq: number
  readonly request: Extract<ArtifactPromptContextSelection, { kind: 'current-function-plot' }>
}

const storageKey = (sessionId: SessionId): string => `dsh.artifact.function-plot-draft.v1.${sessionId}`

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDraft(value: unknown): FunctionPlotDraft | undefined {
  if (!record(value)) return undefined
  const { key, sourceSeq, request } = value
  if (typeof key !== 'string' || typeof sourceSeq !== 'number' || !Number.isSafeInteger(sourceSeq) || sourceSeq < 0
    || !record(request) || request.kind !== 'current-function-plot') return undefined
  const { artifactId, revision, functionId, x, parameters } = request
  if (typeof artifactId !== 'string' || artifactId === '' || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
    || typeof functionId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(functionId)
    || typeof x !== 'number' || !Number.isFinite(x) || !record(parameters)) return undefined
  const node: unknown = JSON.parse(key)
  if (!Array.isArray(node) || node.length !== 2 || typeof node[0] !== 'string' || node[0] === '' || node[1] !== artifactId) return undefined
  const values: Record<string, number> = {}
  for (const [name, parameter] of Object.entries(parameters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || name === '__proto__' || typeof parameter !== 'number' || !Number.isFinite(parameter)) {
      return undefined
    }
    values[name] = parameter
  }
  return { key, sourceSeq,
    request: { kind: request.kind, artifactId: artifactId as ArtifactId, revision, functionId, x, parameters: values } }
}

/**
 * Read this tab's saved native choice, if present and well formed.
 * @param sessionId - Owning Session.
 * @returns The recoverable pending selection.
 */
export function readFunctionPlotDraft(sessionId: SessionId): FunctionPlotDraft | undefined {
  try {
    const raw = globalThis.sessionStorage.getItem(storageKey(sessionId))
    return raw === null ? undefined : parseDraft(JSON.parse(raw))
  } catch (_error) {
    // Browser storage can be unavailable or contain a malformed record.
    return undefined
  }
}

/**
 * Save or remove a native choice without affecting other tabs or Sessions.
 * @param sessionId - Owning Session.
 * @param draft - Exact confirmed inputs, or undefined to remove them.
 */
export function writeFunctionPlotDraft(sessionId: SessionId, draft?: FunctionPlotDraft): void {
  try {
    if (draft === undefined) globalThis.sessionStorage.removeItem(storageKey(sessionId))
    else globalThis.sessionStorage.setItem(storageKey(sessionId), JSON.stringify(draft))
  } catch (_error) {
    // Live selection remains available when browser storage is disabled or full.
  }
}

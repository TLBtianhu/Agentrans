/** Wire formats for portable CSV comparisons, return cards, and ordered explanations. */
import { Buffer } from 'node:buffer'
import { isPortableCsvComparisonExplanation, isPortableCsvComparisonPage, isPortableCsvReturnedComparison } from '@agentrans/artifact-followup'
import type { ArtifactCsvComparisonPage, ArtifactCsvComparisonReturnCards } from '@agentrans/artifact-followup/types'
import { RemoteError } from '@agentrans/typert-protocol'

const comparisonFormat = 'agentrans-csv-comparison'
const explanationFormat = 'agentrans-csv-comparison-explanation'
const returnedComparisonFormat = 'agentrans-csv-return-comparison'
const version = 1
const maxSnapshotBytes = 65_536

type PortableCsvSnapshot = {
  readonly format: typeof comparisonFormat
  readonly version: typeof version
  readonly comparison: ArtifactCsvComparisonPage
} | {
  readonly format: typeof explanationFormat
  readonly version: typeof version
  readonly aggregation: ArtifactCsvComparisonPage
  readonly filtering: ArtifactCsvComparisonPage
} | {
  readonly format: typeof returnedComparisonFormat
  readonly version: typeof version
  readonly comparison: ArtifactCsvComparisonPage
  readonly returnCards: ArtifactCsvComparisonReturnCards
}

/**
 * Report a file or context limit without including user data in diagnostics.
 * @param reason - Invalid portable data, portable file size, or serialized prompt budget.
 * @returns Never returns.
 */
export function csvComparisonImportInvalid(reason: 'INVALID_SNAPSHOT' | 'SNAPSHOT_TOO_LARGE' | 'PROMPT_LIMIT'): never {
  throw new RemoteError('artifact-branch/csv-comparison-import-invalid', 'The selected CSV comparison file cannot be imported', { reason })
}

/**
 * Validate a versioned portable envelope and its recorded evidence.
 * @param json - UTF-8 JSON file content decoded by the Client.
 * @returns The validated portable object with its exact reviewed pages.
 */
export function readCsvComparisonSnapshot(json: string): PortableCsvSnapshot {
  if (Buffer.byteLength(json, 'utf8') > maxSnapshotBytes) return csvComparisonImportInvalid('SNAPSHOT_TOO_LARGE')
  let snapshot: unknown
  try {
    snapshot = JSON.parse(json)
  } catch { return csvComparisonImportInvalid('INVALID_SNAPSHOT') }
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot) || !('format' in snapshot)
    || !('version' in snapshot) || snapshot.version !== version) return csvComparisonImportInvalid('INVALID_SNAPSHOT')
  const keys = Object.keys(snapshot).length
  if (snapshot.format === comparisonFormat && keys === 3 && 'comparison' in snapshot && isPortableCsvComparisonPage(snapshot.comparison)) {
    return { format: comparisonFormat, version, comparison: snapshot.comparison }
  }
  if (snapshot.format === explanationFormat && keys === 4 && 'aggregation' in snapshot && 'filtering' in snapshot) {
    const pages = { aggregation: snapshot.aggregation, filtering: snapshot.filtering }
    if (isPortableCsvComparisonExplanation(pages)) return { format: explanationFormat, version, ...pages }
  }
  if (snapshot.format === returnedComparisonFormat && keys === 4 && 'comparison' in snapshot && 'returnCards' in snapshot) {
    const returned = { comparison: snapshot.comparison, returnCards: snapshot.returnCards }
    if (isPortableCsvReturnedComparison(returned)) return { format: returnedComparisonFormat, version, ...returned }
  }
  return csvComparisonImportInvalid('INVALID_SNAPSHOT')
}

function encodeSnapshot(snapshot: PortableCsvSnapshot, valid: boolean): Uint8Array {
  if (!valid) {
    throw new RemoteError('artifact-branch/csv-comparison-export-unavailable', 'The saved CSV comparison cannot be exported as JSON',
      { reason: 'INVALID_SNAPSHOT' })
  }
  const json = JSON.stringify(snapshot)
  if (Buffer.byteLength(json, 'utf8') > maxSnapshotBytes) {
    throw new RemoteError('artifact-branch/csv-comparison-export-unavailable', 'The saved CSV comparison exceeds the portable JSON size limit',
      { reason: 'SNAPSHOT_TOO_LARGE' })
  }
  return new TextEncoder().encode(json)
}

/**
 * Encode the exact reviewed pages without Session, message, Artifact, or attachment identities.
 * @param comparison - The witnessed single comparison, or the filtered page of an explanation.
 * @param aggregation - The unfiltered page of an explanation, when applicable.
 * @returns The bounded portable JSON file as UTF-8 bytes.
 */
export function encodeCsvComparisonSnapshot(comparison: ArtifactCsvComparisonPage, aggregation?: ArtifactCsvComparisonPage): Uint8Array {
  const snapshot: PortableCsvSnapshot = aggregation === undefined
    ? { format: comparisonFormat, version, comparison }
    : { format: explanationFormat, version, aggregation, filtering: comparison }
  const valid = snapshot.format === comparisonFormat ? isPortableCsvComparisonPage(snapshot.comparison)
    : isPortableCsvComparisonExplanation({ aggregation: snapshot.aggregation, filtering: snapshot.filtering })
  return encodeSnapshot(snapshot, valid)
}

/**
 * Encode a locked comparison and its two return cards without local addresses.
 * @param comparison - The exact reviewed page from the sent comparison.
 * @param returnCards - Both original returns in the comparison's order.
 * @returns The bounded portable JSON file as UTF-8 bytes.
 */
export function encodeCsvReturnedComparisonSnapshot(
  comparison: ArtifactCsvComparisonPage, returnCards: ArtifactCsvComparisonReturnCards,
): Uint8Array {
  const saved = { comparison, returnCards }
  return encodeSnapshot({ format: returnedComparisonFormat, version, ...saved }, isPortableCsvReturnedComparison(saved))
}

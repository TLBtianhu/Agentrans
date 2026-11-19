/** One architecture's update metadata file entry. */
export interface MacMetadataFile {
  readonly url: string
  readonly sha512?: string
  readonly size?: number
}

/** One architecture's update metadata document. */
export interface MacMetadataDocument {
  readonly version: string
  readonly releaseDate?: string
  readonly files: readonly MacMetadataFile[]
  readonly path?: string
  readonly sha512?: string
}

/**
 * Combine metadata documents into one document listing every architecture's files.
 * @param documents - One document per architecture.
 * @returns The merged document.
 */
export function mergeMacMetadataDocuments(documents: readonly MacMetadataDocument[]): MacMetadataDocument & { path: string }

/**
 * Read one feed per architecture and merge the records for the common feed filename.
 * @param inputs - Directories, one per built architecture.
 * @returns Merged feed name and document.
 */
export function mergeMacReleaseMetadata(inputs: readonly string[]): { name: string; document: MacMetadataDocument & { path: string } }

/**
 * Copy every architecture's artifacts into one directory and write the merged metadata beside them.
 * @param inputs - Directories, one per built architecture.
 * @param output - Directory the release uploads from.
 * @returns Written metadata path and artifact count.
 */
export function assembleMacRelease(inputs: readonly string[], output: string): { metadata: string; copied: number }

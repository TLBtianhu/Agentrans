/**
 * Assemble one macOS release directory from per-architecture builds.
 *
 * electron-builder writes one `<channel>-mac.yml` beside each architecture's artifacts, so packaging
 * both architectures into one release would overwrite the first file with the second. The updater
 * filters a single file's `files` list by architecture — it prefers an `arm64` entry on Apple
 * Silicon and excludes it elsewhere — so one merged file serves both architectures.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as yaml from 'js-yaml'

/** Suffix every macOS channel metadata file carries. */
const METADATA_SUFFIX = '-mac.yml'

/**
 * Read the channel metadata file of one build directory.
 * @param {string} directory - Directory holding one architecture's artifacts.
 * @returns {{ name: string, document: { version: string, releaseDate?: string, files: { url: string, sha512?: string, size?: number }[], path?: string, sha512?: string } }} File name and parsed metadata.
 */
function readMetadata(directory) {
  const names = readdirSync(directory).filter(name => name.endsWith(METADATA_SUFFIX))
  if (names.length !== 1) {
    throw new Error(`merge-mac-metadata: ${directory} carries ${String(names.length)} ${METADATA_SUFFIX} files; expected one`)
  }
  const name = names[0]
  if (name === undefined) throw new Error(`merge-mac-metadata: ${directory} carries no metadata`)
  const parsed = yaml.load(readFileSync(join(directory, name), 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`merge-mac-metadata: ${join(directory, name)} is not a metadata document`)
  }
  const document = parsed
  if (typeof document.version !== 'string' || !Array.isArray(document.files)) {
    throw new Error(`merge-mac-metadata: ${join(directory, name)} carries no version or files`)
  }
  return { name, document }
}

/**
 * Combine metadata documents into one document listing every architecture's files.
 * @param {{ version: string, releaseDate?: string, files: { url: string, sha512?: string, size?: number }[], path?: string, sha512?: string }[]} documents - One document per architecture.
 * @returns {{ version: string, files: { url: string, sha512?: string, size?: number }[], path: string, sha512?: string, releaseDate?: string }} The merged document.
 */
export function mergeMacMetadataDocuments(documents) {
  const first = documents[0]
  if (first === undefined) throw new Error('merge-mac-metadata: at least one document is required')
  const versions = new Set(documents.map(document => document.version))
  if (versions.size !== 1) {
    throw new Error(`merge-mac-metadata: metadata versions disagree: ${[...versions].join(', ')}`)
  }
  const files = new Map()
  for (const document of documents) {
    for (const file of document.files) {
      if (typeof file.url !== 'string' || file.url.length === 0) {
        throw new Error('merge-mac-metadata: a file entry names no url')
      }
      const known = files.get(file.url)
      if (known !== undefined && known.sha512 !== file.sha512) {
        throw new Error(`merge-mac-metadata: ${file.url} appears twice with different digests`)
      }
      files.set(file.url, file)
    }
  }
  const ordered = [...files.values()].sort((left, right) => left.url.localeCompare(right.url))
  const merged = { version: first.version, files: ordered, path: ordered[0]?.url ?? '' }
  const digest = ordered.find(file => file.url === merged.path)?.sha512
  if (digest !== undefined) merged.sha512 = digest
  const dates = documents.flatMap(document => (typeof document.releaseDate === 'string' ? [document.releaseDate] : []))
  if (dates.length > 0) merged.releaseDate = dates.sort().at(-1)
  return merged
}

/**
 * Copy every architecture's artifacts into one directory and write the merged metadata beside them.
 * @param {string[]} inputs - Directories, one per built architecture.
 * @param {string} output - Directory the release uploads from.
 * @returns {{ metadata: string, copied: number }} Written metadata path and artifact count.
 */
export function assembleMacRelease(inputs, output) {
  if (inputs.length === 0) throw new Error('merge-mac-metadata: at least one input directory is required')
  const reads = inputs.map(directory => readMetadata(directory))
  const names = new Set(reads.map(read => read.name))
  if (names.size !== 1) {
    throw new Error(`merge-mac-metadata: metadata names disagree: ${[...names].join(', ')}`)
  }
  const merged = mergeMacMetadataDocuments(reads.map(read => read.document))
  mkdirSync(output, { recursive: true })
  let copied = 0
  for (const directory of inputs) {
    for (const entry of readdirSync(directory)) {
      const source = join(directory, entry)
      if (!statSync(source).isFile()) continue
      if (entry.endsWith(METADATA_SUFFIX)) continue
      copyFileSync(source, join(output, basename(entry)))
      copied += 1
    }
  }
  const name = [...names][0]
  if (name === undefined) throw new Error('merge-mac-metadata: metadata name is missing')
  const metadata = join(output, name)
  writeFileSync(metadata, yaml.dump(merged, { lineWidth: -1 }))
  return { metadata, copied }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2)
  if (args.length < 2) {
    throw new Error('merge-mac-metadata: usage: merge-mac-metadata.mjs <input-directory> [<input-directory> …] <output-directory>')
  }
  const output = args.at(-1)
  const inputs = args.slice(0, -1)
  const result = assembleMacRelease(inputs, output)
  console.log(`merge-mac-metadata: wrote ${result.metadata} over ${String(result.copied)} artifact(s)`)
}

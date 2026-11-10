/**
 * Verify a downloaded update against the signature published beside it.
 *
 * electron-updater checks a downloaded file against the SHA-512 the channel
 * metadata lists, which proves the bytes match that metadata; it cannot prove
 * who wrote either. The release therefore ships a detached Ed25519 signature per
 * artifact, and this module checks the installer against the public key pinned in
 * the application before the update is allowed to install.
 *
 * The signature lives beside its artifact in the same GitHub release, so the URL
 * derives from the release tag the updater already resolved plus the asset name.
 */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { publicKeyFromBase64, signatureAssetName, verifyFileDigest } from './update-signature.ts'

/** Repository that publishes the release a build reads. */
export interface UpdateReleaseCoordinates {
  readonly owner: string
  readonly repo: string
}

/**
 * Read the feed coordinates electron-builder embedded for this build.
 *
 * `app-update.yml` is generated from the packaging configuration and is the same
 * file the updater reads for its provider, so the signature URL and the feed
 * cannot disagree about which repository a build follows.
 * @param resourcesPath - Electron resources directory of the running application.
 * @returns the owner and repository named by the embedded feed.
 * @throws Error when the file carries no owner or repository.
 */
export async function readUpdateReleaseCoordinates(resourcesPath: string): Promise<UpdateReleaseCoordinates> {
  const text = await readFile(join(resourcesPath, 'app-update.yml'), 'utf8')
  const field = (name: string): string | undefined => new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'mu').exec(text)?.[1]
  const owner = field('owner')
  const repo = field('repo')
  if (owner === undefined || repo === undefined) {
    throw new Error('desktop update: the embedded update feed names no owner and repository')
  }
  return { owner, repo }
}

/**
 * Build the URL of the signature published beside one release asset.
 * @param coordinates - Repository that published the release.
 * @param tag - Release tag the updater resolved.
 * @param artifactName - Asset file name.
 * @returns the download URL of its detached signature.
 */
export function releaseSignatureUrl(coordinates: UpdateReleaseCoordinates, tag: string, artifactName: string): string {
  return `https://github.com/${coordinates.owner}/${coordinates.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(signatureAssetName(artifactName))}`
}

/** What a downloaded update must satisfy before it may install. */
export interface DownloadedUpdateVerification {
  /**
   * Verify every downloaded artifact against its published signature.
   * @param files - Paths electron-updater reports as prepared.
   * @param tag - Release tag the update was resolved from.
   * @returns completion once every artifact verifies.
   * @throws Error when a signature is missing or does not match.
   */
  verify: (files: readonly string[], tag: string | undefined) => Promise<void>
}

/** Suffixes that carry no installed payload of their own. */
const DERIVED_SUFFIXES = ['.sig', '.blockmap', '.yml']

/**
 * Verify a downloaded update against a pinned public key and the GitHub release it came from.
 * @param options - Embedded resources path, pinned key, and an overridable fetch.
 * @returns a verification step the update coordinator runs before allowing installation.
 */
export function createGitHubUpdateVerification(options: {
  resourcesPath: string
  publicKeyBase64: string
  fetchText?: (url: string) => Promise<string>
}): DownloadedUpdateVerification {
  const fetchText = options.fetchText ?? (async (url: string): Promise<string> => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`desktop update: fetching the update signature failed with ${String(response.status)}`)
    return await response.text()
  })
  return {
    async verify(files, tag) {
      if (tag === undefined || tag === '') throw new Error('desktop update: the resolved release carries no tag to verify against')
      const artifacts = files.filter(file => !DERIVED_SUFFIXES.some(suffix => file.endsWith(suffix)))
      if (artifacts.length === 0) throw new Error('desktop update: no downloaded artifact to verify')
      const coordinates = await readUpdateReleaseCoordinates(options.resourcesPath)
      const publicKey = publicKeyFromBase64(options.publicKeyBase64)
      for (const file of artifacts) {
        const name = basename(file)
        let signature: string
        try {
          signature = await fetchText(releaseSignatureUrl(coordinates, tag, name))
        } catch (cause) {
          throw new Error(`desktop update: ${name} has no published signature (${String(cause)})`)
        }
        if (!await verifyFileDigest(file, signature, publicKey)) {
          throw new Error(`desktop update: ${name} does not match its published signature`)
        }
      }
    },
  }
}

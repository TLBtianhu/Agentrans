/** Signed release manifests with content and key-identity verification. */
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'

/** A signed release description; signature covers every other field in canonical order. */
export interface ReleaseManifest {
  readonly algorithm: 'ed25519'
  readonly fileName: string
  readonly keyId: string
  readonly sha256: string
  readonly size: number
  readonly version: string
  readonly signature: string
}

/** Size and SHA-256 digest of one release file. */
export interface ReleaseDigest {
  readonly size: number
  readonly sha256: string
}

/** Inputs for signing one release file with a caller-owned private key. */
export interface ReleaseSignOptions {
  readonly version: string
}

/** Successful release verification, including the digest recomputed from file bytes. */
export interface ReleaseVerification {
  readonly manifest: ReleaseManifest
  readonly digest: ReleaseDigest
}

/** Failure category for release verification. */
export type ReleaseVerificationErrorCode =
  | 'RELEASE_INVALID_MANIFEST'
  | 'RELEASE_UNSUPPORTED_ALGORITHM'
  | 'RELEASE_KEY_MISMATCH'
  | 'RELEASE_SIGNATURE_INVALID'
  | 'RELEASE_CONTENT_MISMATCH'

/** Raised when a manifest, signature, key, or file does not match the release. */
export class ReleaseVerificationError extends Error {
  constructor(readonly code: ReleaseVerificationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ReleaseVerificationError'
  }
}

/**
 * Return the SHA-256 fingerprint of an Ed25519 public key.
 * @param publicKey - Public key to fingerprint.
 * @returns The `ed25519-sha256-*` key identifier.
 */
export function fingerprintPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return `ed25519-sha256-${createHash('sha256').update(der).digest('hex')}`
}

/**
 * Serialize all signed fields in a stable order, excluding the signature itself.
 * @param manifest - Unsigned release fields.
 * @returns Canonical UTF-8 JSON used for signing and verification.
 */
export function canonicalReleaseContent(manifest: Omit<ReleaseManifest, 'signature'>): string {
  return JSON.stringify({
    algorithm: manifest.algorithm,
    fileName: manifest.fileName,
    keyId: manifest.keyId,
    sha256: manifest.sha256,
    size: manifest.size,
    version: manifest.version,
  })
}

/**
 * Compute a release file's byte size and SHA-256 without loading the whole file into memory.
 * @param filePath - Release file to digest.
 * @returns The file's size and SHA-256 digest.
 */
export async function computeReleaseDigest(filePath: string): Promise<ReleaseDigest> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer
    hash.update(bytes)
    size += bytes.length
  }
  return { size, sha256: hash.digest('hex') }
}

function assertManifest(manifest: ReleaseManifest): void {
  // The manifest arrives from a file, so the declared literal is the value being checked.
  const algorithm: string = manifest.algorithm
  if (algorithm !== 'ed25519') throw new ReleaseVerificationError('RELEASE_UNSUPPORTED_ALGORITHM', 'Release algorithm must be ed25519')
  if (typeof manifest.fileName !== 'string' || manifest.fileName.length === 0 || manifest.fileName.includes('/') || manifest.fileName.includes('\\')) {
    throw new ReleaseVerificationError('RELEASE_INVALID_MANIFEST', 'Release fileName must be a plain filename')
  }
  if (!/^ed25519-sha256-[a-f0-9]{64}$/.test(manifest.keyId)) {
    throw new ReleaseVerificationError('RELEASE_INVALID_MANIFEST', 'Release keyId must be an Ed25519 SHA-256 fingerprint')
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new ReleaseVerificationError('RELEASE_INVALID_MANIFEST', 'Release sha256 must be 64 lowercase hexadecimal characters')
  }
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 0) {
    throw new ReleaseVerificationError('RELEASE_INVALID_MANIFEST', 'Release size must be a non-negative safe integer')
  }
  if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
    throw new ReleaseVerificationError('RELEASE_INVALID_MANIFEST', 'Release version must be non-empty')
  }
  if (typeof manifest.signature !== 'string' || manifest.signature.length === 0) {
    throw new ReleaseVerificationError('RELEASE_INVALID_MANIFEST', 'Release signature must be non-empty base64')
  }
}

/**
 * Sign a release file using a caller-owned Ed25519 private key.
 * @param filePath - Release file to hash and sign.
 * @param privateKey - Private key supplied by the machine-owned credential store.
 * @param options - Release version.
 * @returns A manifest with key identity, digest, size, and signature.
 */
export async function signReleaseManifest(filePath: string, privateKey: KeyObject, options: ReleaseSignOptions): Promise<ReleaseManifest> {
  if (options.version.trim().length === 0) throw new TypeError('Release version must be non-empty')
  const digest = await computeReleaseDigest(filePath)
  const unsigned: Omit<ReleaseManifest, 'signature'> = {
    algorithm: 'ed25519',
    fileName: basename(filePath),
    keyId: fingerprintPublicKey(createPublicKey(privateKey)),
    sha256: digest.sha256,
    size: digest.size,
    version: options.version,
  }
  const signature = sign(null, Buffer.from(canonicalReleaseContent(unsigned), 'utf8'), privateKey).toString('base64')
  return { ...unsigned, signature }
}

/**
 * Verify manifest structure, key identity, signature, and actual release bytes.
 * @param filePath - Release file expected to match the manifest.
 * @param manifest - Signed release manifest to verify.
 * @param publicKey - Trusted public key; its fingerprint must match manifest.keyId.
 * @returns The verified manifest and recomputed digest.
 * @throws {ReleaseVerificationError} When any verification step fails.
 */
export async function verifyReleaseManifest(
  filePath: string,
  manifest: ReleaseManifest,
  publicKey: KeyObject,
): Promise<ReleaseVerification> {
  assertManifest(manifest)
  if (fingerprintPublicKey(publicKey) !== manifest.keyId) {
    throw new ReleaseVerificationError('RELEASE_KEY_MISMATCH', 'Release keyId does not match the trusted public key')
  }
  const { signature, ...unsigned } = manifest
  const valid = verify(null, Buffer.from(canonicalReleaseContent(unsigned), 'utf8'), publicKey, Buffer.from(signature, 'base64'))
  if (!valid) throw new ReleaseVerificationError('RELEASE_SIGNATURE_INVALID', 'Release signature is invalid')
  const digest = await computeReleaseDigest(filePath)
  if (manifest.fileName !== basename(filePath) || manifest.size !== digest.size || manifest.sha256 !== digest.sha256) {
    throw new ReleaseVerificationError('RELEASE_CONTENT_MISMATCH', 'Release file does not match the signed manifest')
  }
  return { manifest, digest }
}

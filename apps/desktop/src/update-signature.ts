/**
 * Detached Ed25519 signatures over a downloaded update artifact.
 *
 * The signature covers the artifact's SHA-256 digest rather than the file, so a
 * 150 MB installer is verified by streaming it once and only the 32-byte digest
 * is handed to the signature primitive. Ed25519 hashes its message internally,
 * so signing a digest is a second, independent hash and stays collision-safe.
 *
 * Keys travel as base64-encoded DER: the public half is an SPKI structure that a
 * build pins in source, and the private half is a PKCS#8 structure that exists
 * only in the release environment.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * Read a public key from its pinned base64 DER form.
 * @param base64 - DER SPKI structure, base64 encoded.
 * @returns The key object used for verification.
 * @throws Error when the value is not a usable public key.
 */
export function publicKeyFromBase64(base64: string): KeyObject {
  try {
    return createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' })
  } catch (cause) {
    throw new Error(`update signature: the pinned public key is not a DER SPKI Ed25519 key (${String(cause)})`)
  }
}

/**
 * Read a signing key from its release-environment base64 DER form.
 * @param base64 - DER PKCS#8 structure, base64 encoded.
 * @returns The key object used for signing.
 * @throws Error when the value is not a usable private key.
 */
export function privateKeyFromBase64(base64: string): KeyObject {
  try {
    return createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' })
  } catch (cause) {
    throw new Error(`update signature: the signing key is not a DER PKCS#8 Ed25519 key (${String(cause)})`)
  }
}

/**
 * Digest one artifact without loading it into memory.
 * @param path - File to hash.
 * @returns Lowercase hex SHA-256.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Sign one artifact's digest.
 * @param path - File to sign.
 * @param privateKey - Signing key from the release environment.
 * @returns Base64 signature over the file's SHA-256 digest.
 */
export async function signFileDigest(path: string, privateKey: KeyObject): Promise<string> {
  const digest = Buffer.from(await sha256File(path), 'hex')
  return sign(null, digest, privateKey).toString('base64')
}

/**
 * Verify one artifact against its detached signature.
 * @param path - Downloaded file.
 * @param signatureBase64 - Signature published beside the artifact.
 * @param publicKey - The pinned verification key.
 * @returns whether the signature matches this file's digest.
 */
export async function verifyFileDigest(path: string, signatureBase64: string, publicKey: KeyObject): Promise<boolean> {
  const digest = Buffer.from(await sha256File(path), 'hex')
  try {
    return verify(null, digest, publicKey, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/**
 * Name the signature published beside an artifact.
 * @param artifactName - Release asset file name.
 * @returns the asset name of its signature.
 */
export function signatureAssetName(artifactName: string): string {
  return `${artifactName}.sig`
}

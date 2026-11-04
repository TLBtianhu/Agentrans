import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  fingerprintPublicKey,
  canonicalReleaseContent,
  signReleaseManifest,
  verifyReleaseManifest,
  type ReleaseManifest,
} from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const { privateKey, publicKey } = generateKeyPairSync('ed25519')

async function releaseFile(contents = 'Agentrans release payload\n'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentrans-release-'))
  roots.push(root)
  const file = join(root, 'agentrans.zip')
  await writeFile(file, contents, 'utf8')
  return file
}

describe('ReleaseManifest signing and verification', () => {
  it('signs canonical content and verifies the key, signature, and file bytes', async () => {
    const file = await releaseFile()
    const manifest = await signReleaseManifest(file, privateKey, { version: '0.1.0' })
    expect(manifest.algorithm).toBe('ed25519')
    expect(manifest.keyId).toBe(fingerprintPublicKey(publicKey))
    expect(manifest.fileName).toBe('agentrans.zip')
    expect(manifest.signature.length).toBeGreaterThan(0)
    const result = await verifyReleaseManifest(file, manifest, publicKey)
    expect(result.manifest).toEqual(manifest)
    expect(result.digest.sha256).toBe(manifest.sha256)
    expect(result.digest.size).toBe(manifest.size)
  })

  it('rejects a modified manifest even when the file is unchanged', async () => {
    const file = await releaseFile()
    const manifest = await signReleaseManifest(file, privateKey, { version: '0.1.0' })
    const changed: ReleaseManifest = { ...manifest, version: '0.2.0' }
    await expect(verifyReleaseManifest(file, changed, publicKey)).rejects.toMatchObject({ code: 'RELEASE_SIGNATURE_INVALID' })
  })

  it('rejects modified release bytes even with a valid manifest signature', async () => {
    const file = await releaseFile()
    const manifest = await signReleaseManifest(file, privateKey, { version: '0.1.0' })
    await writeFile(file, 'tampered payload', 'utf8')
    await expect(verifyReleaseManifest(file, manifest, publicKey)).rejects.toMatchObject({ code: 'RELEASE_CONTENT_MISMATCH' })
  })

  it('rejects a manifest signed for another filename', async () => {
    const file = await releaseFile()
    const manifest = await signReleaseManifest(file, privateKey, { version: '0.1.0' })
    const changed = { ...manifest, fileName: 'other.zip' }
    const resigned = await signReleaseManifest(file, privateKey, { version: '0.1.0' })
    const forged = { ...resigned, fileName: changed.fileName }
    const signature = sign(null, Buffer.from(canonicalReleaseContent(forged)), privateKey).toString('base64')
    await expect(verifyReleaseManifest(file, { ...forged, signature }, publicKey)).rejects.toMatchObject({ code: 'RELEASE_CONTENT_MISMATCH' })
  })

  it('rejects a different public key and malformed manifests', async () => {
    const file = await releaseFile()
    const manifest = await signReleaseManifest(file, privateKey, { version: '0.1.0' })
    const other = generateKeyPairSync('ed25519')
    await expect(verifyReleaseManifest(file, manifest, other.publicKey)).rejects.toMatchObject({ code: 'RELEASE_KEY_MISMATCH' })
    await expect(verifyReleaseManifest(file, { ...manifest, signature: '' }, publicKey)).rejects.toMatchObject({ code: 'RELEASE_INVALID_MANIFEST' })
    await expect(verifyReleaseManifest(file, { ...manifest, algorithm: 'rsa' as never }, publicKey)).rejects.toMatchObject({ code: 'RELEASE_UNSUPPORTED_ALGORITHM' })
  })
})

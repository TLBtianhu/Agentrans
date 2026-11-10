import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  privateKeyFromBase64,
  publicKeyFromBase64,
  sha256File,
  signFileDigest,
  signatureAssetName,
  verifyFileDigest,
} from '../src/update-signature.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** @returns one artifact file and the keys that sign it. */
async function fixture(): Promise<{ path: string; publicKey: string; privateKey: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'update-signature-'))
  directories.push(directory)
  const path = join(directory, 'Agentrans-1.2.3-win-x64.exe')
  await writeFile(path, 'installer bytes')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    path,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
}

describe('update artifact signatures', () => {
  it('accepts a signature over the file it was made for', async () => {
    const { path, publicKey, privateKey } = await fixture()
    const signature = await signFileDigest(path, privateKeyFromBase64(privateKey))
    await expect(verifyFileDigest(path, signature, publicKeyFromBase64(publicKey))).resolves.toBe(true)
  })

  it('rejects a file that changed after signing', async () => {
    const { path, publicKey, privateKey } = await fixture()
    const signature = await signFileDigest(path, privateKeyFromBase64(privateKey))
    await writeFile(path, 'installer bytes with a payload')
    await expect(verifyFileDigest(path, signature, publicKeyFromBase64(publicKey))).resolves.toBe(false)
  })

  it('rejects a signature made by another key', async () => {
    const { path, publicKey } = await fixture()
    const other = generateKeyPairSync('ed25519').privateKey
    const signature = await signFileDigest(path, other)
    await expect(verifyFileDigest(path, signature, publicKeyFromBase64(publicKey))).resolves.toBe(false)
  })

  it('rejects a malformed signature instead of throwing', async () => {
    const { path, publicKey } = await fixture()
    await expect(verifyFileDigest(path, 'not a signature', publicKeyFromBase64(publicKey))).resolves.toBe(false)
  })

  it('names the signature beside the artifact', () => {
    expect(signatureAssetName('Agentrans-1.2.3-win-x64.exe')).toBe('Agentrans-1.2.3-win-x64.exe.sig')
  })

  it('rejects key material that is not an Ed25519 key', () => {
    expect(() => publicKeyFromBase64('AAAA')).toThrow(/pinned public key/u)
    expect(() => privateKeyFromBase64('AAAA')).toThrow(/signing key/u)
  })

  it('digests the file bytes', async () => {
    const { path } = await fixture()
    await expect(sha256File(path)).resolves.toMatch(/^[0-9a-f]{64}$/u)
  })
})

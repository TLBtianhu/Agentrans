import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitHubUpdateVerification, readUpdateReleaseCoordinates, releaseSignatureUrl } from '../src/update-verification.ts'
import { privateKeyFromBase64, signFileDigest } from '../src/update-signature.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const FEED = ['provider: github', 'owner: TLBtianhu', 'repo: Agentrans', 'channel: latest', 'releaseType: release', ''].join('\n')

/** @returns a resources directory carrying an embedded feed. */
async function resources(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'update-verification-'))
  directories.push(directory)
  await writeFile(join(directory, 'app-update.yml'), FEED)
  return directory
}

describe('downloaded update verification', () => {
  it('reads the owner and repository the build embedded', async () => {
    await expect(readUpdateReleaseCoordinates(await resources())).resolves.toEqual({ owner: 'TLBtianhu', repo: 'Agentrans' })
  })

  it('refuses a feed that names no repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'update-verification-'))
    directories.push(directory)
    await writeFile(join(directory, 'app-update.yml'), 'provider: github\n')
    await expect(readUpdateReleaseCoordinates(directory)).rejects.toThrow(/names no owner and repository/u)
  })

  it('builds the signature URL beside the artifact in the same release', () => {
    expect(releaseSignatureUrl({ owner: 'TLBtianhu', repo: 'Agentrans' }, 'desktop-v1.2.3', 'Agentrans-1.2.3-win-x64.exe'))
      .toBe('https://github.com/TLBtianhu/Agentrans/releases/download/desktop-v1.2.3/Agentrans-1.2.3-win-x64.exe.sig')
  })

  it('accepts a download whose signature matches and skips derived artifacts', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const directory = await resources()
    const installer = join(directory, 'Agentrans-1.2.3-win-x64.exe')
    await writeFile(installer, 'installer bytes')
    const signature = await signFileDigest(installer, privateKeyFromBase64(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')))
    const requested: string[] = []
    const verification = createGitHubUpdateVerification({
      resourcesPath: directory,
      publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      fetchText: async (url) => { requested.push(url); return signature },
    })
    await expect(verification.verify([installer, `${installer}.blockmap`], 'desktop-v1.2.3')).resolves.toBeUndefined()
    expect(requested).toEqual([releaseSignatureUrl({ owner: 'TLBtianhu', repo: 'Agentrans' }, 'desktop-v1.2.3', 'Agentrans-1.2.3-win-x64.exe')])
  })

  it('refuses a download whose bytes do not match the published signature', async () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const directory = await resources()
    const installer = join(directory, 'Agentrans-1.2.3-win-x64.exe')
    await writeFile(installer, 'installer bytes')
    const other = generateKeyPairSync('ed25519').privateKey
    const signature = await signFileDigest(installer, other)
    const verification = createGitHubUpdateVerification({
      resourcesPath: directory,
      publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      fetchText: async () => signature,
    })
    await expect(verification.verify([installer], 'desktop-v1.2.3')).rejects.toThrow(/does not match its published signature/u)
  })

  it('refuses an artifact with no published signature', async () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const directory = await resources()
    const installer = join(directory, 'Agentrans-1.2.3-win-x64.exe')
    await writeFile(installer, 'installer bytes')
    const verification = createGitHubUpdateVerification({
      resourcesPath: directory,
      publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      fetchText: async () => { throw new Error('404') },
    })
    await expect(verification.verify([installer], 'desktop-v1.2.3')).rejects.toThrow(/has no published signature/u)
  })

  it('refuses a release that carries no tag', async () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const verification = createGitHubUpdateVerification({
      resourcesPath: await resources(),
      publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    })
    await expect(verification.verify(['/tmp/installer.exe'], undefined)).rejects.toThrow(/carries no tag/u)
  })
})

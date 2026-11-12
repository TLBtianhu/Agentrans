import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../src/update-signing-key.ts'

/** The pinned key and the distribution PEM must stay one key, or verification depends on which copy you read. */
describe('update signing public key', () => {
  it('pins a DER SPKI Ed25519 key', () => {
    const key = createPublicKey({ key: Buffer.from(UPDATE_SIGNING_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' })
    expect(key.asymmetricKeyType).toBe('ed25519')
  })

  it('ships the same key in distribution/keys', () => {
    const pem = readFileSync(join(import.meta.dirname, '../../../distribution/keys/agentrans-update-ed25519-public.pem'), 'utf8')
    const shipped = createPublicKey(pem).export({ format: 'der', type: 'spki' }).toString('base64')
    expect(shipped).toBe(UPDATE_SIGNING_PUBLIC_KEY)
  })
})

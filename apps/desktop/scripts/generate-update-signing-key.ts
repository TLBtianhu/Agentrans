/**
 * Create the Ed25519 key pair that signs published updates.
 *
 * The private half belongs in the `DSH_UPDATE_SIGNING_KEY` repository secret and
 * nowhere else, so this prints only the public half and writes the private half
 * to the file named on the command line. Rotation follows the same procedure:
 * generate, publish one build carrying the new public key, then replace the
 * secret, because a build only trusts a key that shipped inside it.
 *
 * Usage: node --import tsx apps/desktop/scripts/generate-update-signing-key.ts <private-key-out>
 */
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: generate-update-signing-key <private-key-out>')
  process.exitCode = 1
} else {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(target, privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
  console.log('public key for apps/desktop/src/update-signing-key.ts:')
  console.log(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'))
  console.log(`private key written to ${target}; store it as DSH_UPDATE_SIGNING_KEY and delete the file`)
}

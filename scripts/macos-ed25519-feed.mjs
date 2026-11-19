/** Deliver the retained .5 macOS ZIP and its detached signature to the isolated updater check. */
import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { copyFile, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../apps/desktop/src/update-signing-key.ts'
import { publicKeyFromBase64, verifyFileDigest } from '../apps/desktop/src/update-signature.ts'

const releases = '/TLBtianhu/Agentrans/releases'
const baseline = '0.1.0-test.20261118.4'
const candidate = '0.1.0-test.20261118.5'

async function digests(path) {
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk)
    sha512.update(chunk)
  }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

async function changeOneByte(path, size) {
  const offset = Math.floor(size / 2)
  const handle = await open(path, 'r+')
  try {
    const bytes = Buffer.alloc(1)
    if ((await handle.read(bytes, 0, 1, offset)).bytesRead !== 1) throw new Error('Could not read fixture byte')
    bytes[0] ^= 1
    if ((await handle.write(bytes, 0, 1, offset)).bytesWritten !== 1) throw new Error('Could not change fixture byte')
  } finally { await handle.close() }
}

/**
 * Serve the exact retained ZIP or a separately mutated copy with matching transport metadata.
 * @param {object} options - Pinned versions and paths, case selection, and loopback TLS configuration.
 * @returns {Promise<object>} Feed evidence and awaited teardown.
 */
export async function startMacEd25519Fixture({
  oldVersion, newVersion, zipPath, signaturePath, mode, tls, host = '127.0.0.1', port = 443,
}) {
  const name = basename(zipPath)
  if (host !== '127.0.0.1' || oldVersion !== baseline || newVersion !== candidate
    || !['arm64', 'x64'].some(arch => name === `agentrans-${candidate}-mac-${arch}-unsigned.zip`)
    || resolve(signaturePath) !== `${resolve(zipPath)}.sig` || !['valid', 'tampered'].includes(mode)) {
    throw new Error('The macOS fixture requires the pinned .4 and .5 packages and a loopback listener')
  }
  const [original, signature, file] = await Promise.all([digests(zipPath), readFile(signaturePath, 'utf8'), stat(zipPath)])
  const publicKey = publicKeyFromBase64(UPDATE_SIGNING_PUBLIC_KEY)
  if (!file.isFile() || file.size < 2 || !/^[A-Za-z0-9+/]{86}==$/u.test(signature.trim())
    || !await verifyFileDigest(zipPath, signature.trim(), publicKey)) {
    throw new Error('The retained macOS ZIP did not verify with the pinned Ed25519 key')
  }

  let temp
  let deliveredFile = zipPath
  let delivered = original
  try {
    if (mode === 'tampered') {
      temp = await mkdtemp(join(tmpdir(), 'agentrans-macos-ed25519-'))
      deliveredFile = join(temp, name)
      await copyFile(zipPath, deliveredFile, constants.COPYFILE_EXCL)
      await changeOneByte(deliveredFile, file.size)
      delivered = await digests(deliveredFile)
      if (delivered.sha256 === original.sha256 || (await stat(deliveredFile)).size !== file.size) {
        throw new Error('The copied fixture was not changed in place')
      }
    }

    const path = `${releases}/download/v${newVersion}`
    const metadata = [
      `version: ${newVersion}`, 'files:', `  - url: ${name}`, `    sha512: ${delivered.sha512}`, `    size: ${file.size}`,
      `path: ${name}`, `sha512: ${delivered.sha512}`, '',
    ].join('\n')
    const catalog = JSON.stringify([{
      tag_name: `v${newVersion}`, draft: false, prerelease: true, name: `Agentrans ${newVersion}`,
      body: 'Isolated macOS update qualification',
    }])
    const atom = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">'
      + `<entry><title>Agentrans ${newVersion}</title><link href="https://github.com${releases}/tag/v${newVersion}"/>`
      + '<content type="html">Isolated macOS update qualification</content></entry></feed>'
    const assets = new Map([
      [`${releases}.atom`, { kind: 'atom', type: 'application/atom+xml', body: atom }],
      [`${path}/test-mac.yml`, { kind: 'metadata', type: 'application/yaml', body: metadata }],
      [`${path}/${name}.sig`, { kind: 'signature', type: 'text/plain', body: signature }],
    ])
    const requests = []
    const transfers = new Set()
    const server = createServer(tls, (request, response) => {
      const hostName = request.headers.host?.toLowerCase().split(':', 1)[0]
      const [pathname, query] = (request.url ?? '').split('?', 2)
      const asset = hostName === 'github.com' ? assets.get(pathname) : undefined
      const isCatalog = hostName === 'api.github.com' && pathname === `/repos${releases}`
      const isPayload = hostName === 'github.com' && pathname === `${path}/${name}`
      const report = { method: request.method, path: pathname, kind: asset?.kind ?? (isPayload ? 'payload' : 'unrecognized'),
        range: request.headers.range ?? null, status: 0, bytes: 0, completed: false }
      if (isCatalog) report.kind = 'release-catalog'
      requests.push(report)
      response.once('finish', () => { report.completed = true })
      const send = (status, type, body = '') => {
        const length = Buffer.byteLength(body)
        report.status = status
        report.bytes = request.method === 'HEAD' ? 0 : length
        response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': length })
        response.end(request.method === 'HEAD' ? undefined : body)
      }
      if (hostName !== 'github.com' && hostName !== 'api.github.com') { send(421, 'text/plain'); return }
      if (request.method !== 'GET' && request.method !== 'HEAD') { send(405, 'text/plain'); return }
      if (isCatalog) {
        const parameters = new URLSearchParams(query)
        if (parameters.get('page') !== '1' || parameters.get('per_page') !== '100') { send(404, 'text/plain'); return }
        send(200, 'application/json', catalog)
        return
      }
      if (asset) { send(200, asset.type, asset.body); return }
      // Missing blockmaps make the updater use the full ZIP in both cases.
      if (!isPayload) { send(404, 'text/plain'); return }
      report.status = 200
      report.bytes = request.method === 'HEAD' ? 0 : file.size
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'Content-Length': file.size })
      if (request.method === 'HEAD') { response.end(); return }
      const transfer = pipeline(createReadStream(deliveredFile), response).catch(() => { report.completed = false })
        .finally(() => transfers.delete(transfer))
      transfers.add(transfer)
    })
    server.requestTimeout = 120_000
    const inheritedDescriptor = mode === 'tampered' ? process.env.QA_FIRST_LISTENER_FD : process.env.QA_SECOND_LISTENER_FD
    const listener = port === 443 && inheritedDescriptor !== undefined ? { fd: Number(inheritedDescriptor) } : { port, host }
    await new Promise((finish, reject) => {
      server.once('error', reject)
      server.listen(listener, () => { server.off('error', reject); finish() })
    })
    let closing
    return {
      origin: `https://${host}:${server.address().port}`,
      snapshot() {
        const successful = requests.filter(request => request.method === 'GET' && request.status === 200 && request.completed)
        const count = kind => successful.filter(request => request.kind === kind).length
        const deliveredBytes = successful.filter(request => request.kind === 'payload').reduce((sum, request) => sum + request.bytes, 0)
        return {
          mode, artifactName: name, originalSha256: original.sha256, deliveredSha256: delivered.sha256, deliveredSha512: delivered.sha512,
          packageBytes: file.size, deliveredBytes,
          signatureRequests: count('signature'), releaseCatalogRequests: count('release-catalog'), metadataRequests: count('metadata'),
          requests: requests.map(request => ({ ...request })),
        }
      },
      close() {
        closing ??= (async () => {
          const closed = new Promise((finish, reject) => server.close(error => error ? reject(error) : finish()))
          server.closeAllConnections()
          try { await Promise.all([closed, ...transfers]) }
          finally { if (temp !== undefined) await rm(temp, { recursive: true, force: true }) }
        })()
        return closing
      },
    }
  } catch (error) {
    if (temp !== undefined) await rm(temp, { recursive: true, force: true })
    throw error
  }
}

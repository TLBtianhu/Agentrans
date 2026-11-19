/** Local HTTPS delivery of the unchanged, signed macOS candidate ZIP and index. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:https'
import { basename, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../../src/update-signing-key.ts'
import { publicKeyFromBase64, verifyBytesDigest, verifyFileDigest } from '../../src/update-signature.ts'

const releases = '/TLBtianhu/Agentrans/releases'
const version = '0.1.0-test.20261120.1'
const tag = `v${version}`
const indexName = 'test-mac.yml'

async function installerHashes(file) {
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk)
    sha512.update(chunk)
  }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

function signatureText(bytes) {
  const text = bytes.toString('utf8')
  if (bytes.length !== 88 || !/^[A-Za-z0-9+/]{86}==$/u.test(text)) {
    throw new Error('Expected the exact published Ed25519 signature encoding')
  }
  return text
}

/**
 * Serve a single architecture from authenticated, unchanged Actions artifacts.
 * @param {object} options - Target architecture, ZIP/index paths and sidecars, archive SHA-256, and loopback TLS.
 * @returns {Promise<object>} Request evidence, a gate that stops further ZIP delivery, and awaited teardown.
 */
export async function startMacCandidateFeed({
  arch, zipPath, metadataPath, signaturePath = `${zipPath}.sig`, metadataSignaturePath = `${metadataPath}.sig`,
  expectedZipSha256, tls, host = '127.0.0.1', port = 443,
}) {
  const name = `agentrans-${version}-mac-${arch}-unsigned.zip`
  if (host !== '127.0.0.1' || !['arm64', 'x64'].includes(arch) || basename(zipPath) !== name
    || basename(metadataPath) !== indexName || resolve(signaturePath) !== `${resolve(zipPath)}.sig`
    || resolve(metadataSignaturePath) !== `${resolve(metadataPath)}.sig`) {
    throw new Error('Expected an architecture-specific candidate ZIP and index beside their signatures on loopback')
  }
  const [file, hashes, metadata, signature, metadataSignature] = await Promise.all([
    stat(zipPath), installerHashes(zipPath), readFile(metadataPath), readFile(signaturePath), readFile(metadataSignaturePath),
  ])
  if (!file.isFile() || file.size === 0 || (expectedZipSha256 !== undefined && hashes.sha256 !== expectedZipSha256)) {
    throw new Error('The candidate ZIP does not match the Actions input')
  }
  const publicKey = publicKeyFromBase64(UPDATE_SIGNING_PUBLIC_KEY)
  if (!verifyBytesDigest(metadata, signatureText(metadataSignature), publicKey)
    || !await verifyFileDigest(zipPath, signatureText(signature), publicKey)) {
    throw new Error('The candidate index and ZIP must verify with the pinned Ed25519 key')
  }
  const lines = metadata.toString('utf8').split(/\r?\n/u)
  const entry = lines.indexOf(`  - url: ${name}`)
  if (entry < 0 || !lines.includes(`version: ${version}`) || !lines.includes(`path: ${name}`)
    || !lines.includes(`sha512: ${hashes.sha512}`) || lines[entry + 1] !== `    sha512: ${hashes.sha512}`
    || lines[entry + 2] !== `    size: ${file.size}`) {
    throw new Error('The candidate index does not identify the selected architecture ZIP bytes')
  }

  const title = `Agentrans ${version}`
  const description = 'Isolated macOS update qualification'
  const path = `${releases}/download/${tag}`
  const payloadPath = `${path}/${name}`
  const catalogPath = `/repos${releases}`
  const assets = new Map([
    [indexName, { kind: 'metadata', type: 'application/yaml', body: metadata }],
    [`${indexName}.sig`, { kind: 'metadata-signature', type: 'text/plain', body: metadataSignature }],
    [`${name}.sig`, { kind: 'signature', type: 'text/plain', body: signature }],
  ])
  const releaseAssets = [{ name, state: 'uploaded', size: file.size },
    ...Array.from(assets, ([assetName, { body }]) => ({ name: assetName, state: 'uploaded', size: body.length }))]
  const catalog = Buffer.from(JSON.stringify([{
    tag_name: tag, draft: false, prerelease: true, name: title, body: description, assets: releaseAssets,
  }]))
  const atom = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">'
    + `<entry><title>${title}</title><link href="https://github.com${releases}/tag/${tag}"/>`
    + `<content type="html">${description}</content></entry></feed>`)
  const routes = new Map(Array.from(assets, ([assetName, asset]) => [`${path}/${assetName}`, asset]))
  routes.set(`${releases}.atom`, { kind: 'atom', type: 'application/atom+xml', body: atom })
  const requests = []
  const transfers = new Set()
  let servePayload = true
  const server = createServer(tls, (request, response) => {
    const [pathname, query] = (request.url ?? '').split('?', 2)
    const authority = request.headers.host?.toLowerCase()
    const isGitHub = authority === 'github.com' || authority === `github.com:${server.address().port}`
    const isApi = authority === 'api.github.com' || authority === `api.github.com:${server.address().port}`
    const asset = isGitHub ? routes.get(pathname) : undefined
    const isCatalog = isApi && pathname === catalogPath
    const isPayload = isGitHub && pathname === payloadPath
    const kind = isCatalog ? 'release-catalog' : asset?.kind ?? (isPayload ? 'payload' : 'unrecognized')
    const report = { method: request.method, path: pathname, kind, range: request.headers.range ?? null,
      status: 0, bytes: 0, completed: false }
    requests.push(report)
    response.once('finish', () => { report.completed = true })
    const send = (status, type = 'text/plain', body = Buffer.alloc(0)) => {
      report.status = status
      report.bytes = request.method === 'HEAD' ? 0 : body.length
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': body.length })
      response.end(request.method === 'HEAD' ? undefined : body)
    }
    if (!isGitHub && !isApi) { send(421); return }
    if (request.method !== 'GET' && request.method !== 'HEAD') { send(405); return }
    if (isCatalog) {
      const parameters = new URLSearchParams(query)
      if (parameters.get('page') !== '1' || parameters.get('per_page') !== '100') { send(404); return }
      send(200, 'application/json', catalog)
      return
    }
    if (asset) { send(200, asset.type, asset.body); return }
    if (!isPayload || !servePayload) { send(isPayload ? 503 : 404); return }
    // A fresh DMG install has no old ZIP cache. Missing blockmaps leave electron-updater's full ZIP path in control.
    report.status = 200
    report.bytes = request.method === 'HEAD' ? 0 : file.size
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'Content-Length': file.size })
    if (request.method === 'HEAD') { response.end(); return }
    const transfer = pipeline(createReadStream(zipPath), response)
      .catch(() => { report.completed = false })
      .finally(() => transfers.delete(transfer))
    transfers.add(transfer)
  })
  server.requestTimeout = 120_000
  const descriptor = process.env.QA_LISTENER_FD
  const listener = port === 443 && descriptor !== undefined ? { fd: Number(descriptor) } : { port, host }
  if ('fd' in listener && (!Number.isSafeInteger(listener.fd) || listener.fd < 3)) throw new Error('Invalid inherited loopback descriptor')
  await new Promise((finish, reject) => {
    server.once('error', reject)
    server.listen(listener, () => { server.off('error', reject); finish() })
  })
  let closing
  return {
    origin: `https://${host}:${server.address().port}`,
    stopServingPayload() { servePayload = false },
    snapshot() {
      const successful = requests.filter(request => request.method === 'GET' && request.status === 200 && request.completed)
      const count = kind => successful.filter(request => request.kind === kind).length
      return {
        artifactName: name, originalSha256: hashes.sha256, deliveredSha256: hashes.sha256, deliveredSha512: hashes.sha512,
        packageBytes: file.size, deliveredBytes: successful.filter(request => request.kind === 'payload').reduce((sum, request) => sum + request.bytes, 0),
        payloadRequests: count('payload'), signatureRequests: count('signature'), metadataSignatureRequests: count('metadata-signature'),
        releaseCatalogRequests: count('release-catalog'), metadataRequests: count('metadata'),
        blockedPayloadRequests: requests.filter(request => request.kind === 'payload' && request.status === 503).length,
        requests: requests.map(request => ({ ...request })),
      }
    },
    close() {
      closing ??= new Promise((finish, reject) => {
        server.close(error => error ? reject(error) : finish())
        server.closeAllConnections()
      }).then(() => Promise.all([...transfers]))
      return closing
    },
  }
}

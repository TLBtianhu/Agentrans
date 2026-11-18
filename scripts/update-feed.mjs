/** Loopback HTTPS fixture for installed electron-updater's GitHub NSIS path. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:https'
import { basename } from 'node:path'
import { pipeline } from 'node:stream'

const repository = '/TLBtianhu/Agentrans'
const releases = `${repository}/releases`
const releaseCatalog = `/repos${releases}`
const oldVersion = '0.1.0-test.20261118.2'
const newVersion = '0.1.0-test.20261118.3'
const fileName = version => `agentrans-${version}-win-x64-unsigned.exe`
const assetPath = (version, name) => `${releases}/download/v${version}/${name}`

function parseRange(header, size) {
  const match = /^bytes=(\d+)-(\d+)$/u.exec(header)
  if (!match) return undefined
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= size) return undefined
  return { start, end }
}

async function requiredFile(path) {
  const file = await stat(path)
  if (!file.isFile() || file.size === 0) throw new Error(`Missing or empty update fixture file ${basename(path)}`)
  return file.size
}

async function hashInstaller(path) {
  const hash = createHash('sha512')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('base64')
}

/**
 * Serve pinned GitHub release metadata and byte ranges on an ephemeral runner's loopback interface.
 * @param {object} options - TLS credentials and already verified update artifacts.
 * @returns {Promise<object>} The public URL, request evidence, and server teardown.
 */
export async function startUpgradeFeed({
  tls, oldInstallerPath, newInstallerPath, metadataPath, signaturePath,
  oldBlockMapPath = `${oldInstallerPath}.blockmap`, newBlockMapPath = `${newInstallerPath}.blockmap`,
  host = '127.0.0.1', port = 443,
}) {
  if (host !== '127.0.0.1') throw new Error('The update fixture must listen on IPv4 loopback')
  if (basename(oldInstallerPath) !== fileName(oldVersion) || basename(newInstallerPath) !== fileName(newVersion)) {
    throw new Error('Unexpected fixture installer name')
  }
  const [installerSize, , metadata, signature, oldBlockMap, newBlockMap, sha512] = await Promise.all([
    requiredFile(newInstallerPath), requiredFile(oldInstallerPath), readFile(metadataPath), readFile(signaturePath),
    readFile(oldBlockMapPath), readFile(newBlockMapPath), hashInstaller(newInstallerPath),
  ])
  if (oldBlockMap.length === 0 || newBlockMap.length === 0 || !/^[A-Za-z0-9+/]{86}==$/u.test(signature.toString().trim())) {
    throw new Error('Invalid fixture blockmap or Ed25519 signature')
  }
  const lines = metadata.toString('utf8').split(/\r?\n/u)
  if (!lines.includes(`version: ${newVersion}`)
    || !lines.includes(`  - url: ${fileName(newVersion)}`)
    || !lines.includes(`path: ${fileName(newVersion)}`)
    || !lines.includes(`sha512: ${sha512}`)
    || !lines.includes(`    sha512: ${sha512}`)
    || !lines.includes(`    size: ${installerSize}`)) {
    throw new Error('The retained electron-builder metadata does not identify the candidate bytes')
  }

  const entry = `<entry><title>Agentrans ${newVersion}</title><link href="https://github.com${releases}/tag/v${newVersion}"/>`
    + '<content type="html">Isolated Windows upgrade qualification</content></entry>'
  const feed = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entry}</feed>`)
  const catalog = Buffer.from(JSON.stringify([{
    tag_name: `v${newVersion}`, draft: false, prerelease: true,
    name: `Agentrans ${newVersion}`, body: 'Isolated Windows upgrade qualification',
  }]))
  const assets = new Map([
    [`${releases}.atom`, { kind: 'feed', type: 'application/atom+xml; charset=utf-8', body: feed }],
    [assetPath(newVersion, 'test.yml'), { kind: 'metadata', type: 'application/yaml; charset=utf-8', body: metadata }],
    [assetPath(oldVersion, `${fileName(oldVersion)}.blockmap`), { kind: 'old-blockmap', type: 'application/octet-stream', body: oldBlockMap }],
    [assetPath(newVersion, `${fileName(newVersion)}.blockmap`), { kind: 'new-blockmap', type: 'application/octet-stream', body: newBlockMap }],
    [assetPath(newVersion, `${fileName(newVersion)}.sig`), { kind: 'signature', type: 'text/plain; charset=utf-8', body: signature }],
  ])
  const requests = []
  const installerPath = assetPath(newVersion, fileName(newVersion))
  const server = createServer(tls, (request, response) => {
    const hostHeader = request.headers.host?.toLowerCase() ?? ''
    const portSuffix = `:${server.address().port}`
    const isGitHub = hostHeader === 'github.com' || hostHeader === `github.com${portSuffix}`
    const isApi = hostHeader === 'api.github.com' || hostHeader === `api.github.com${portSuffix}`
    // Query strings are not retained in evidence, and paths never become filesystem paths.
    const [path, query] = (request.url ?? '').split('?', 2)
    const asset = isGitHub ? assets.get(path) : undefined
    const isInstaller = isGitHub && path === installerPath
    const isCatalog = isApi && path === releaseCatalog
    const report = { method: request.method, path, kind: asset?.kind ?? (isInstaller ? 'installer' : 'unrecognized'),
      range: request.headers.range ?? null, status: 0, bytes: 0, completed: false }
    if (isCatalog) report.kind = 'release-catalog'
    requests.push(report)
    response.once('finish', () => { report.completed = true })
    const send = (status, headers, body) => {
      report.status = status
      report.bytes = request.method === 'HEAD' ? 0 : body.length
      response.writeHead(status, { 'Content-Length': body.length, 'Cache-Control': 'no-store', ...headers })
      response.end(request.method === 'HEAD' ? undefined : body)
    }
    if (!isGitHub && !isApi) {
      send(421, {}, Buffer.alloc(0))
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(405, { Allow: 'GET, HEAD' }, Buffer.alloc(0))
      return
    }
    if (isCatalog) {
      const parameters = new URLSearchParams(query)
      if (parameters.get('page') === '1' && parameters.get('per_page') === '100') {
        send(200, { 'Content-Type': 'application/json; charset=utf-8' }, catalog)
      } else {
        send(404, {}, Buffer.alloc(0))
      }
      return
    }
    if (asset) {
      send(200, { 'Content-Type': asset.type }, asset.body)
      return
    }
    if (!isInstaller) {
      send(404, {}, Buffer.alloc(0))
      return
    }
    const range = request.headers.range === undefined ? null : parseRange(request.headers.range, installerSize)
    if (range === undefined) {
      send(416, { 'Content-Range': `bytes */${installerSize}`, 'Accept-Ranges': 'bytes' }, Buffer.alloc(0))
      return
    }
    const start = range?.start ?? 0
    const end = range?.end ?? installerSize - 1
    const length = end - start + 1
    report.status = range === null ? 200 : 206
    report.bytes = request.method === 'HEAD' ? 0 : length
    response.writeHead(report.status, {
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'Content-Length': length,
      ...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${installerSize}` }),
    })
    if (request.method === 'HEAD') response.end()
    else pipeline(createReadStream(newInstallerPath, { start, end }), response, error => {
      if (error && !response.destroyed) response.destroy()
    })
  })
  server.requestTimeout = 120_000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  const boundPort = server.address().port
  let closing
  return {
    origin: `https://github.com${boundPort === 443 ? '' : `:${boundPort}`}`,
    snapshot() {
      const successful = requests.filter(request => request.method === 'GET' && request.completed)
      const ranges = successful.filter(request => request.kind === 'installer' && request.status === 206)
      const rangeBytes = ranges.reduce((sum, request) => sum + request.bytes, 0)
      const installerGets = requests.filter(request => request.method === 'GET' && request.kind === 'installer')
      const fullInstallerRequests = installerGets.filter(request => request.status === 200).length
      const count = kind => successful.filter(request => request.kind === kind && request.status === 200).length
      const oldBlockmapRequests = count('old-blockmap')
      const newBlockmapRequests = count('new-blockmap')
      return { installerSize, rangeRequests: ranges.length, rangeBytes, fullInstallerRequests, oldBlockmapRequests, newBlockmapRequests,
        signatureRequests: count('signature'), releaseCatalogRequests: count('release-catalog'),
        requests: requests.map(request => ({ ...request })),
        differentialObserved: oldBlockmapRequests > 0 && newBlockmapRequests > 0 && rangeBytes > 0
          && rangeBytes < installerSize && fullInstallerRequests === 0,
      }
    },
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
      return closing
    },
  }
}

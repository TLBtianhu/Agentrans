/** Test-process backstop: replay may use local fixtures, never external provider HTTP. */

import { appendFileSync } from 'node:fs'
import { Socket } from 'node:net'

const auditFile = process.env.AGENTRANS_SNAPSHOT_NETWORK_AUDIT_FILE
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function audit(event) {
  if (auditFile) appendFileSync(auditFile, `${JSON.stringify({ ...event, pid: process.pid })}\n`)
}

function refused(transport, destination) {
  const error = new Error(`snapshot replay blocked external ${transport} before sending: ${destination}`)
  const frames = error.stack.split('\n').slice(1, 8).filter(frame => !frame.includes('data:'))
  audit({ kind: 'blocked', transport, destination, frames })
  error.code = 'SNAPSHOT_EXTERNAL_NETWORK'
  throw error
}

const fetch = globalThis.fetch
globalThis.fetch = async function (input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !loopbackHosts.has(url.hostname)) {
    refused('fetch', url.origin)
  }
  return fetch(input, options)
}

const connect = Socket.prototype.connect
Socket.prototype.connect = function (...args) {
  const parameters = Array.isArray(args[0]) ? args[0] : args
  const first = parameters[0]
  // Pipe paths have no network destination; numeric ports and TCP options do.
  if (typeof first === 'number' || typeof first === 'string' && /^\d+$/u.test(first)
    || typeof first === 'object' && first !== null && !first.path) {
    const host = typeof first === 'number' || typeof first === 'string'
      ? typeof parameters[1] === 'string' ? parameters[1] : 'localhost'
      : first.host ?? 'localhost'
    if (!loopbackHosts.has(host)) refused('socket', host)
  }
  return connect.apply(this, args)
}

audit({ kind: 'installed' })

// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import { BrowserFileActions } from '../../ui-file-actions/src/client/files.ts'
import { downloadArtifactExport } from '../src/client/protocol.ts'
import type { ArtifactHtmlExportRecord } from '@agentrans/artifact-export/types'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('downloads verified Artifact bytes through the actual fileActions provider in a Cordis context', async () => {
  vi.stubGlobal('Blob', NodeBlob)
  const createObjectURL = vi.fn<(blob: Blob | MediaSource) => string>(() => 'blob:verified-export')
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = createObjectURL
    static override revokeObjectURL = vi.fn()
  })
  const clicked: HTMLAnchorElement[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this) })
  const actions = new BrowserFileActions(undefined)
  const ctx = new Context()
  ctx.provide('fileActions', actions)
  const bytes = new TextEncoder().encode('<!doctype html><p>Frozen A</p>')
  const read = vi.fn(async () => ({ ok: true, value: bytes }))
  ctx.provide('remote', { artifactExports: { read } } as never)
  const record: ArtifactHtmlExportRecord & { status: 'ready' } = {
    request: { exportId: 'export-A' as never, format: 'html', source: { kind: 'current', artifactId: 'A' as never, revision: 1 } },
    frozen: { sessionId: 'session-A' as never, artifact: { artifactId: 'A' as never, revision: 1, format: 'scene', title: 'A',
      presentation: 'inline', spec: { kind: 'flowchart', nodes: [], edges: [] } }, exporterVersion: 1, parameters: 'source-defaults' },
    status: 'ready', file: { attachmentId: 'sha256:abc' as never, bytes: bytes.length, name: 'frozen-A.html' },
  }
  try {
    await expect(downloadArtifactExport(ctx, 'session-A' as never, record)).resolves.toEqual({ status: 'requested' })
    expect(read).toHaveBeenCalledExactlyOnceWith('session-A', 'export-A')
    expect(clicked).toHaveLength(1)
    expect(clicked[0]?.download).toBe('frozen-A.html')
    const blob = createObjectURL.mock.calls[0]?.[0]
    if (!(blob instanceof NodeBlob)) throw new Error('Expected the actual verified HTML Blob')
    expect(await blob.text()).toBe('<!doctype html><p>Frozen A</p>')
  } finally { actions.dispose(); await ctx.fiber.dispose() }
})

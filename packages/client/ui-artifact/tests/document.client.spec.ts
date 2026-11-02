// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ARTIFACT_CSP, createArtifactDocument } from '../src/client/document.ts'

describe('createArtifactDocument', () => {
  it('places a restrictive policy before authored content without stripping inline code', () => {
    const html = createArtifactDocument(`<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=https://example.invalid">
      <meta http-equiv="Content-Security-Policy" content="default-src *">
      <script src="https://example.invalid/app.js"></script><link rel="stylesheet" href="https://example.invalid/app.css">
      <style>body { color: red }</style></head><body><script>window.ready = true</script>
      <img src="data:image/png;base64,AA=="><img src="blob:preview"><img src="https://example.invalid/pixel"></body></html>`)
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    const policies = parsed.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')
    expect(parsed.head.firstElementChild).toBe(policies[0])
    expect(policies).toHaveLength(2)
    expect(policies[0]?.getAttribute('content')).toBe(ARTIFACT_CSP)
    expect(ARTIFACT_CSP).toContain("default-src 'none'")
    expect(ARTIFACT_CSP).toContain("script-src 'unsafe-inline'")
    expect(ARTIFACT_CSP).toContain("style-src 'unsafe-inline'")
    expect(ARTIFACT_CSP).toContain('img-src data: blob:')
    expect(ARTIFACT_CSP).toContain("connect-src 'none'")
    expect(ARTIFACT_CSP).toContain("form-action 'none'")
    expect(ARTIFACT_CSP).toContain("object-src 'none'")
    expect(ARTIFACT_CSP).toContain("frame-src 'none'")
    expect(ARTIFACT_CSP).toContain("base-uri 'none'")
    expect(ARTIFACT_CSP).toContain("navigate-to 'none'")
    expect(ARTIFACT_CSP).not.toContain('unsafe-eval')
    expect(ARTIFACT_CSP).not.toContain('https:')
    expect(parsed.querySelector('meta[http-equiv="refresh" i]')).toBeNull()
    expect(parsed.querySelector('body script')?.textContent).toContain('window.ready = true')
    expect(parsed.querySelector('style')?.textContent).toContain('color: red')
  })
})

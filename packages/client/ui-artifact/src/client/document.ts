/** Restricted srcDoc assembly for executable, opaque-origin Artifact previews. */

/** Network-independent policy; inline code and styles cannot load remote dependencies. */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
].join('; ')

/**
 * Place the restrictive policy before any authored document content without mounting it in the parent.
 * @param source - complete authored HTML.
 * @returns srcDoc HTML with the policy first and meta refresh removed.
 */
export function createArtifactDocument(source: string): string {
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  for (const refresh of parsed.querySelectorAll('meta[http-equiv="refresh" i]')) refresh.remove()
  const policy = parsed.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', ARTIFACT_CSP)
  parsed.head.prepend(policy)
  return `<!doctype html>${parsed.documentElement.outerHTML}`
}

/**
 * Generate absent scene export programs once before the unit suite runs.
 *
 * The Artifact scene bindings are gitignored build output, and the scene
 * exporter imports them, so a clean checkout (and every CI test lane, which
 * builds only the native addon first) would fail those suites on the missing
 * files rather than on their behavior. Present files stay untouched; stale
 * output remains the `verify-scene-bundles` gate's concern.
 */
import { fileURLToPath } from 'node:url'
import { ensureSceneBundles } from './generate-scene-bundles.ts'

/** Vitest global setup: runs once in the main process before any test file. */
export default function setup(): void {
  ensureSceneBundles(fileURLToPath(new URL('..', import.meta.url)))
}

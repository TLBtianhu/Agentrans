/**
 * The shipped desktop product identity, read from the manifest that declares it.
 *
 * electron-builder, the macOS `.app` lookups, the installer configuration and the
 * post-package smoke all need the same name. Reading `apps/desktop/package.json`
 * once keeps those call sites from drifting into their own copy, which is how the
 * upstream name survived a rename in the protocol registration and the macOS path.
 * @module desktop-product-identity
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

if (typeof manifest.productName !== 'string' || manifest.productName.trim() === '') {
  throw new Error('desktop package.json must declare a non-empty productName')
}

/**
 * Name electron-builder stamps into the bundle, executable, installer and protocol
 * registration. Every script that spells a product path or product-owned string uses it.
 */
export const DESKTOP_PRODUCT_NAME = manifest.productName

/**
 * Lowercase artifact-name slug for the same product (`Agentrans` → `agentrans`).
 * Release file names are lowercase by convention; the suffix each build appends
 * (`-unsigned`, `-unnotarized`) stays with the build configuration.
 */
export const DESKTOP_ARTIFACT_SLUG = DESKTOP_PRODUCT_NAME.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '')

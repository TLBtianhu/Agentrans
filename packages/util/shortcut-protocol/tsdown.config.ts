import { defineConfig } from 'tsdown'

/**
 * Bundle the shared helpers into this package's own output.
 *
 * The Desktop main bundle inlines its workspace dependencies from their `lib/`
 * output, and it refuses a bare import that the packaged application does not
 * ship. Inlining the three helpers here keeps this package self-contained, so a
 * consumer never has to resolve them itself.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  noExternal: [/^@deepseek-ai\/dsh-(?:brand|util-crypto|util-values)$/u],
})

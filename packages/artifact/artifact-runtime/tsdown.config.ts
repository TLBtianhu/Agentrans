import { defineConfig } from 'tsdown'

/** Build the package entries as bundles; workspace dependencies stay external. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/tool.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  outputOptions: { chunkFileNames: 'shared-[hash].js' },
})

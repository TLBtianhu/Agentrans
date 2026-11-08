import { defineConfig } from 'tsdown'

export default defineConfig(['index', 'launch-context'].map(name => ({
  entry: ['lib/types/' + name + '.js'],
  outputOptions: { codeSplitting: false },
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})))

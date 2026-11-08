import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/tool.js', 'lib/types/scene.js', 'lib/types/scene-tool.js', 'lib/types/particle-runtime.js', 'lib/types/capabilities.js', 'lib/types/runtime-values.js', 'lib/types/observation-comparison.js', 'lib/types/scene-export.js', 'lib/types/scene-renderers.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

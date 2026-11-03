import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('./', import.meta.url)
const theme = await readFile(new URL('theme.css', root), 'utf8')
const motion = await readFile(new URL('motion.js', root), 'utf8')

for (const name of ['prediction-lab', 'parameter-explorer']) {
  const source = await readFile(new URL(`src/${name}.html`, root), 'utf8')
  if (!source.includes('<!-- @artifact-theme -->') || !source.includes('<!-- @artifact-motion -->')) {
    throw new Error(`${name}: template placeholders are missing`)
  }
  const output = source
    .replace('<!-- @artifact-theme -->', () => `<style>\n${theme}\n</style>`)
    .replace('<!-- @artifact-motion -->', () => `<script>\n${motion}\n</script>`)
  await writeFile(new URL(`${name}.html`, root), output, 'utf8')
  console.log(`Built references/${name}.html`)
}

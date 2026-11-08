/** Establish Desktop state before the main entry imports its application modules. */
import { app } from 'electron'
import { fileURLToPath } from 'node:url'
import { configureDesktopProduct } from './product-context.ts'

/** Process-lifetime immutable product paths; workspace changes never replace them. */
export const desktopLaunchContext = configureDesktopProduct(
  app, process.resourcesPath, fileURLToPath(new URL('../../..', import.meta.url)), process.env,
)

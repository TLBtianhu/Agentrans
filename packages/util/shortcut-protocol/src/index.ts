/**
 * Physical-key and versioned preference protocol shared by the Client and the
 * Desktop main process.
 *
 * Both sides read and write the same shortcut document, so its types, parsing,
 * and storage shape live here rather than inside either side's package. This
 * package carries no Client UI and no process access.
 */
export * from './binding.ts'
export * from './configuration.ts'
export * from './persistence.ts'
export * from './native.ts'

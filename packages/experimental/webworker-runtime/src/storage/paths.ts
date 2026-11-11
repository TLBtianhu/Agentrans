/**
 * Virtual root of the worker host's in-memory filesystem. Kept
 * in one module so the process shim, the path/os shims, and the VFS image
 * collector cannot drift apart.
 */

/** Virtual filesystem root; `process.cwd()` and every absolute path start here. */
export const AGENTRANS_ROOT = '/dsh'

/** `$AGENTRANS_HOME`: durable-state directory inside the image. */
export const AGENTRANS_HOME = `${AGENTRANS_ROOT}/home`

/** Flat, symlink-free package tree resolved by the worker module loader. */
export const AGENTRANS_NODE_MODULES = `${AGENTRANS_ROOT}/node_modules`

/** Image configuration directory: the VFS manifest and the shipped agent presets. */
export const AGENTRANS_CONFIG = `${AGENTRANS_ROOT}/config`

/** Default (empty) workspace directory. */
export const AGENTRANS_WORKSPACE = `${AGENTRANS_ROOT}/workspace`

/** Temporary directory reported by `os.tmpdir()`. */
export const AGENTRANS_TMP = `${AGENTRANS_ROOT}/tmp`

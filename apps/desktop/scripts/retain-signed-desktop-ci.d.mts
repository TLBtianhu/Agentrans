/**
 * Preserve qualified packages before the workflow uploads its Actions artifact.
 * @param target - Exact target selected by the trusted workflow step.
 * @param env - Actions settings, selected source checkout, and production config directory.
 * @returns Fresh directory containing release files and their production build record.
 */
export function retainSignedDesktopCi(target: string | undefined, env: NodeJS.ProcessEnv): Promise<string>

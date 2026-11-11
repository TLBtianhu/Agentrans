/** Validation at export request, event, and checkpoint boundaries. */
import { z } from 'zod'
import { brandString } from '@agentrans/brand'
import type { ArtifactId, ArtifactObservationId } from '@agentrans/artifact/types'
import { normalizeSceneSpec } from '@agentrans/artifact/scene'
import { restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import { AttachmentId } from '@agentrans/attachment'
import { SessionId } from '@agentrans/session'
import type { ArtifactExportId, ArtifactHtmlExportInput, ArtifactHtmlExportRecord, ArtifactHtmlExportRequest, ArtifactHtmlExports } from './types.ts'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
/** Export identities accepted at request and result-read boundaries. */
export const exportIdSchema = identity.transform(value => brandString<ArtifactExportId>(value))
const artifactId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).transform(value => brandString<ArtifactId>(value))
const observationId = identity.transform(value => brandString<ArtifactObservationId>(value))
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const checkpoint = z.object({ runtimeVersion: z.literal(1), stepCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()

/** Normalize the immutable reference-only request before checking retry identity. */
export const requestSchema: z.ZodType<ArtifactHtmlExportRequest> = z.object({
  exportId: exportIdSchema,
  format: z.literal('html'),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('current'), artifactId, revision, checkpoint: checkpoint.optional() }).strict(),
    z.object({ kind: z.literal('observation'), artifactId, observationId }).strict(),
  ]),
}).strict().transform((value): ArtifactHtmlExportRequest => ({
  exportId: value.exportId, format: value.format,
  source: value.source.kind === 'observation' ? value.source : {
    kind: value.source.kind, artifactId: value.source.artifactId, revision: value.source.revision,
    ...(value.source.checkpoint === undefined ? {} : { checkpoint: value.source.checkpoint }),
  },
}))

const spec = z.unknown().transform((value, context) => {
  try { return normalizeSceneSpec(value) } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid Scene source' })
    return z.NEVER
  }
})

const frozen = z.object({
  sessionId: z.string().min(1).transform(SessionId),
  artifact: z.object({
    artifactId, revision, format: z.literal('scene'), title: z.string().trim().min(1).max(120),
    presentation: z.enum(['inline', 'focus']),
    comparison: z.object({ group: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), role: z.enum(['control', 'variant']) }).optional(),
    spec,
  }),
  checkpoint: checkpoint.optional(), observationId: observationId.optional(),
  exporterVersion: z.literal(1), parameters: z.enum(['source-defaults', 'particle-checkpoint']),
}).transform((value): ArtifactHtmlExportInput => ({
  sessionId: value.sessionId,
  artifact: {
    artifactId: value.artifact.artifactId, revision: value.artifact.revision, format: value.artifact.format,
    title: value.artifact.title, presentation: value.artifact.presentation, spec: value.artifact.spec,
    ...(value.artifact.comparison === undefined ? {} : { comparison: value.artifact.comparison }),
  },
  exporterVersion: value.exporterVersion, parameters: value.parameters,
  ...(value.checkpoint === undefined ? {} : { checkpoint: value.checkpoint }),
  ...(value.observationId === undefined ? {} : { observationId: value.observationId }),
})).superRefine((value, context) => {
  if (value.artifact.spec.kind === 'particle-system') {
    if (value.parameters !== 'particle-checkpoint') context.addIssue({ code: 'custom', message: 'Particle export conditions are required' })
    try { restoreParticleCheckpoint(value.artifact.spec, value.checkpoint) } catch (error) {
      context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid particle checkpoint' })
    }
  } else if (value.checkpoint !== undefined || value.observationId !== undefined || value.parameters !== 'source-defaults') {
    context.addIssue({ code: 'custom', message: 'Non-particle exports use source default conditions' })
  }
})

const file = z.object({
  attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/).transform(AttachmentId),
  name: z.string().min(1).refine(value => !/[\\/]/.test(value) && value !== '.' && value !== '..'),
  bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
})

/** Validate complete durable export facts and their source/checkpoint identity. */
export const recordSchema: z.ZodType<ArtifactHtmlExportRecord> = z.intersection(
  z.object({ request: requestSchema, frozen }),
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('pending') }),
    z.object({ status: z.literal('ready'), file }),
    z.object({ status: z.literal('failed'), failure: z.enum(['RENDER_FAILED', 'OUTPUT_TOO_LARGE', 'STORAGE_FAILED']) }),
  ]),
).superRefine((value, context) => {
  const source = value.request.source
  if (source.artifactId !== value.frozen.artifact.artifactId
    || (source.kind === 'current' && (source.revision !== value.frozen.artifact.revision
      || JSON.stringify(source.checkpoint) !== JSON.stringify(value.frozen.checkpoint) || value.frozen.observationId !== undefined))
    || (source.kind === 'observation' && source.observationId !== value.frozen.observationId)) {
    context.addIssue({ code: 'custom', message: 'Export request does not identify its frozen source' })
  }
})

/** Validate the Session's current result index, including record-key identity. */
export const exportsSchema: z.ZodType<ArtifactHtmlExports> = z.record(z.string(), recordSchema)
  .superRefine((value, context) => {
    for (const [key, record] of Object.entries(value)) {
      if (key !== record.request.exportId) context.addIssue({ code: 'custom', message: 'Export key does not identify its record' })
    }
  })

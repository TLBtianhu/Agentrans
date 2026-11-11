/** WebM video recording of a FunctionPlot canvas during a deterministic timeline replay. */
import type { FunctionPlotSpec } from '@agentrans/artifact/scene'

/** Recording handle returned by recordSceneVideo. */
export interface SceneVideoRecording {
  readonly stop: () => void
}

/**
 * Record the current canvas as a WebM video for one SceneSpec timeline.
 * @param spec - SceneSpec whose timeline supplies the recording duration and frame rate.
 * @param canvas - Canvas currently rendering the scene.
 * @returns A stop handle, or null when this environment cannot record video.
 */
export function recordSceneVideo(spec: FunctionPlotSpec, canvas: HTMLCanvasElement): SceneVideoRecording | null {
  if (typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') return null
  const timeline = spec.timeline ?? { duration: 8, fps: 30 }
  const stream = canvas.captureStream(timeline.fps)
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${spec.kind}-animation.webm`
    anchor.click()
    URL.revokeObjectURL(url)
    for (const track of stream.getTracks()) track.stop()
  }
  recorder.start()
  return { stop: () => { recorder.stop() } }
}

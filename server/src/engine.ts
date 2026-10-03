import { rename, unlink } from "node:fs/promises"
import { extname } from "node:path"
import { ENGINE, ENGINE_PORT, FFMPEG, FFPROBE, MANAGED, PHONON } from "./config"
import type { Segment } from "./types"

const SAMPLE_RATE = 16000
const PEAK_COUNT = 1200

export async function engineUp() {
  try {
    return (await fetch(`${ENGINE}/health`, { signal: AbortSignal.timeout(1000) })).ok
  } catch {
    return false
  }
}

/** launchd normally runs the engine; start one ourselves if it isn't there (e.g. in dev). */
export async function ensureEngine() {
  if (await engineUp()) return
  // Under launchd the engine has its own agent that may still be loading the model:
  // starting a second one would race it for the port (and the GPU).
  if (MANAGED) return console.log("waiting for the engine service")
  if (!PHONON) throw new Error("phonon CLI not found; run scripts/install.sh")
  console.log("starting phonon engine")
  Bun.spawn([PHONON, "serve", "--port", String(ENGINE_PORT)], { stdout: "inherit", stderr: "inherit" })
  for (let i = 0; i < 180; i++) {
    if (await engineUp()) return
    await Bun.sleep(1000)
  }
  throw new Error("phonon engine did not come up")
}

/** True if ffprobe finds at least one audio stream, whatever the extension says. */
export async function hasAudio(path: string) {
  if (!FFPROBE) throw new Error("ffprobe not found; run scripts/install.sh")
  const proc = Bun.spawn(
    [FFPROBE, "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
    { stdout: "pipe", stderr: "ignore" },
  )
  const out = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 && out.includes("audio")
}

/** Decode any audio/video file to 16 kHz mono s16le PCM. */
export async function decode(path: string) {
  if (!FFMPEG) throw new Error("ffmpeg not found; run scripts/install.sh")
  const proc = Bun.spawn(
    [FFMPEG, "-nostdin", "-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [pcm, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(cleanFfmpegError(err))
  if (pcm.byteLength < 2) throw new Error("ffmpeg found no audio track in this file")
  return new Int16Array(pcm, 0, pcm.byteLength >> 1)
}

function cleanFfmpegError(err: string) {
  const line = err.trim().split("\n").pop() ?? ""
  if (/does not contain any stream|Output file .* does not contain/i.test(err)) return "ffmpeg found no audio track in this file"
  if (/Invalid data found/i.test(err)) return "ffmpeg couldn't read this file; it may not be audio or video"
  return line.replace(/^.*?: /, "") || "ffmpeg couldn't read this file"
}

/** Max |amplitude| per bucket, normalised to 0..1. */
export function peaks(pcm: Int16Array) {
  const out = new Float32Array(PEAK_COUNT)
  const bucket = pcm.length / PEAK_COUNT
  let max = 0
  for (let i = 0; i < PEAK_COUNT; i++) {
    let p = 0
    const end = Math.min(pcm.length, Math.floor((i + 1) * bucket))
    for (let j = Math.floor(i * bucket); j < end; j++) {
      const v = Math.abs(pcm[j])
      if (v > p) p = v
    }
    out[i] = p
    if (p > max) max = p
  }
  if (max > 0) for (let i = 0; i < PEAK_COUNT; i++) out[i] /= max
  return out
}

function wav(pcm: Int16Array) {
  const header = new DataView(new ArrayBuffer(44))
  const bytes = pcm.byteLength
  const str = (o: number, s: string) => [...s].forEach((c, i) => header.setUint8(o + i, c.charCodeAt(0)))
  str(0, "RIFF")
  header.setUint32(4, 36 + bytes, true)
  str(8, "WAVE")
  str(12, "fmt ")
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true) // PCM
  header.setUint16(22, 1, true) // mono
  header.setUint32(24, SAMPLE_RATE, true)
  header.setUint32(28, SAMPLE_RATE * 2, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  str(36, "data")
  header.setUint32(40, bytes, true)
  return new Blob([header, new Uint8Array(pcm.buffer as ArrayBuffer, pcm.byteOffset, pcm.byteLength)])
}

/** The engine isn't answering (stopped, restarting, still loading). Worth waiting for, not a failure. */
export class EngineUnavailable extends Error {}

/** Blocks until the engine answers /health, up to `maxMs`. */
export async function waitForEngine(maxMs: number) {
  const until = Date.now() + maxMs
  while (Date.now() < until) {
    if (await engineUp()) return true
    await Bun.sleep(2000)
  }
  return false
}

export async function transcribe(pcm: Int16Array) {
  const form = new FormData()
  form.set("model", "phonon-2")
  form.set("response_format", "verbose_json")
  form.append("timestamp_granularities[]", "word")
  form.append("timestamp_granularities[]", "segment")
  form.set("file", wav(pcm), "audio.wav")
  // Phonon-2 runs at ~100× realtime or better; allow 5× realtime plus a minute before giving up.
  const seconds = pcm.length / SAMPLE_RATE
  const res = await fetch(`${ENGINE}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000 + (seconds / 5) * 1000),
  }).catch((e) => {
    if (e instanceof DOMException && e.name === "TimeoutError")
      throw new Error("The engine took too long on this file and was stopped.")
    throw new EngineUnavailable("The transcription engine isn't running.")
  })
  const body = (await res.json().catch(() => ({}))) as {
    text?: string
    duration?: number
    segments?: Segment[]
    words?: Word[]
    error?: { message: string }
  }
  if (!res.ok) throw new Error(body.error?.message ?? `engine returned ${res.status}`)
  return {
    text: (body.text ?? "").trim(),
    durationS: body.duration ?? pcm.length / SAMPLE_RATE,
    segments: body.words?.length
      ? sentences(body.words)
      : (body.segments ?? []).map(({ start, end, text }) => ({ start, end, text: text.trim() })),
  }
}

type Word = { word: string; start: number; end: number }

const MAX_WORDS = 40

/**
 * The engine's own segments are ~30 s windows; regroup its word timestamps into
 * sentences so the UI can highlight and seek at sentence granularity. Run-ons
 * are split at a comma or pause once they pass MAX_WORDS.
 */
function sentences(words: Word[]): Segment[] {
  const out: Segment[] = []
  let cur: Word[] = []
  const flush = () => {
    if (!cur.length) return
    out.push({ start: cur[0].start, end: cur.at(-1)!.end, text: cur.map((w) => w.word.trim()).join(" ") })
    cur = []
  }
  words.forEach((w, i) => {
    cur.push(w)
    const next = words[i + 1]
    const gap = next ? next.start - w.end : 0
    if (/[.?!]["')\]]?$/.test(w.word.trim()) || gap > 1.5) flush()
    else if (cur.length >= MAX_WORDS && (/[,;:]$/.test(w.word.trim()) || gap > 0.3)) flush()
    else if (cur.length >= MAX_WORDS * 2) flush()
  })
  flush()
  return out
}

/**
 * Browser recordings (MediaRecorder) have no duration or seek index, so <audio> can't scrub
 * them. A stream copy rewrites the container with both; nothing is re-encoded. Best-effort:
 * on failure the original file is kept as it was.
 */
export async function remux(path: string) {
  const ext = extname(path).toLowerCase()
  if (!FFMPEG || ext === ".wav") return
  const tmp = `${path}.remux${ext}`
  const args = [FFMPEG, "-nostdin", "-loglevel", "error", "-y", "-i", path, "-map", "0:a", "-c", "copy"]
  if (ext === ".m4a" || ext === ".mp4") args.push("-movflags", "+faststart")
  const proc = Bun.spawn([...args, tmp], { stdout: "ignore", stderr: "ignore" })
  if ((await proc.exited) === 0) await rename(tmp, path)
  else await unlink(tmp).catch(() => {})
}

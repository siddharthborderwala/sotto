// Served from public/ as a real file: Vite would inline it as a data: URL, which audio worklets can refuse.
const workletUrl = "/pcm-tap.worklet.js"

/**
 * One mic recording. Two independent outputs:
 *  - the saved file (MediaRecorder, or a WAV built from the PCM if MediaRecorder is unavailable),
 *    which goes through the normal transcription pipeline when you stop; and
 *  - a live preview: 16 kHz PCM streamed over /api/live to the engine's streaming decoder.
 * The preview is best-effort. If it fails or falls behind, recording carries on regardless.
 */

export type LiveState = "connecting" | "live" | "unavailable"
export type LiveText = { finals: string[]; partial: string }

export type RecorderEvents = {
  onLevel: (rms: number) => void
  onText: (text: LiveText) => void
  onLiveState: (state: LiveState) => void
}

const SAMPLE_RATE = 16000
/** Anything shorter is a stray tap, not a recording. */
export const MIN_SECONDS = 0.6
/** Stop sending live audio if the socket backs up this far (≈8 s of audio); the preview is then stale. */
const MAX_BUFFERED = 512 * 1024
/** Blocks held while the socket connects (10 s). */
const MAX_PENDING = 200
/** How long stop() waits for the engine's last words. */
const DONE_WAIT_MS = 1500

const MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
]

const EXTENSION: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
}

export class MicError extends Error {}

function micError(e: unknown) {
  const name = e instanceof DOMException ? e.name : ""
  if (name === "NotAllowedError" || name === "SecurityError")
    return new MicError(
      "Microphone access is blocked. Allow it for this site in your browser's settings."
    )
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return new MicError("No microphone found.")
  if (name === "NotReadableError" || name === "AbortError")
    return new MicError("The microphone is in use by another app.")
  return new MicError(
    e instanceof Error ? e.message : "Couldn't start the microphone."
  )
}

export class Recorder {
  private samples = 0
  private live: LiveText = { finals: [], partial: "" }
  private socket: WebSocket | null = null
  private pending: ArrayBuffer[] = []
  private done: Promise<void> | null = null
  private pcm: Float32Array[] | null = null // only kept when MediaRecorder isn't available
  private chunks: Blob[] = []
  private closed = false

  private stream: MediaStream
  private ctx: AudioContext
  private media: MediaRecorder | null
  private events: RecorderEvents

  private constructor(
    stream: MediaStream,
    ctx: AudioContext,
    media: MediaRecorder | null,
    events: RecorderEvents
  ) {
    this.stream = stream
    this.ctx = ctx
    this.media = media
    this.events = events
  }

  /** Starts capturing immediately; resolves once audio is flowing. */
  static async start(events: RecorderEvents) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new MicError(
        "This browser can't record audio here. Open Sotto at http://localhost or your HTTPS address."
      )
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (e) {
      throw micError(e)
    }

    // The file recorder starts first so the opening syllable isn't lost to worklet setup.
    const mime = MIME_TYPES.find(
      (m) =>
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)
    )
    const media = mime
      ? new MediaRecorder(stream, {
          mimeType: mime,
          audioBitsPerSecond: 96_000,
        })
      : null
    const ctx = new AudioContext({ latencyHint: "interactive" })
    const rec = new Recorder(stream, ctx, media, events)
    if (media) {
      media.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data)
      media.start(1000)
    } else rec.pcm = []

    try {
      await ctx.audioWorklet.addModule(workletUrl)
      const source = ctx.createMediaStreamSource(stream)
      const tap = new AudioWorkletNode(ctx, "pcm-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      const mute = ctx.createGain()
      mute.gain.value = 0
      source.connect(tap).connect(mute).connect(ctx.destination)
      tap.port.onmessage = (
        e: MessageEvent<{ pcm: Float32Array; rms: number }>
      ) => rec.block(e.data.pcm, e.data.rms)
      rec.flushTap = () => tap.port.postMessage("flush")
      if (ctx.state === "suspended") await ctx.resume()
    } catch (e) {
      rec.discard()
      throw micError(e)
    }
    rec.connect()
    return rec
  }

  private flushTap = () => {}

  get seconds() {
    return this.samples / SAMPLE_RATE
  }

  private block(pcm: Float32Array, rms: number) {
    if (this.closed) return
    this.samples += pcm.length
    this.pcm?.push(pcm)
    this.events.onLevel(rms)
    const ws = this.socket
    if (!ws) return
    if (ws.readyState === WebSocket.CONNECTING) {
      if (this.pending.length < MAX_PENDING)
        this.pending.push(pcm.buffer as ArrayBuffer)
    } else if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > MAX_BUFFERED) return this.dropLive()
      ws.send(pcm.buffer as ArrayBuffer)
    }
  }

  private connect() {
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`
    )
    ws.binaryType = "arraybuffer"
    this.socket = ws
    this.events.onLiveState("connecting")
    let resolveDone = () => {}
    this.done = new Promise((r) => (resolveDone = r))
    ws.onopen = () => {
      ws.send(JSON.stringify({ sample_rate: SAMPLE_RATE, format: "pcm_f32le" }))
      for (const b of this.pending.splice(0)) ws.send(b)
      this.events.onLiveState("live")
    }
    ws.onmessage = (m) => {
      let msg: { type?: string; text?: string }
      try {
        msg = JSON.parse(m.data as string)
      } catch {
        return
      }
      if (msg.type === "partial")
        this.live = { ...this.live, partial: msg.text ?? "" }
      else if (msg.type === "final")
        this.live = {
          finals: [...this.live.finals, msg.text ?? ""],
          partial: "",
        }
      else if (msg.type === "done") return resolveDone()
      else if (msg.type === "error") return this.dropLive()
      else return
      this.events.onText(this.live)
    }
    ws.onerror = () => this.dropLive()
    ws.onclose = () => {
      resolveDone()
      if (!this.closed) this.dropLive()
    }
  }

  private dropLive() {
    const ws = this.socket
    this.socket = null
    this.pending = []
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close()
    if (!this.closed) this.events.onLiveState("unavailable")
  }

  /** Ends the recording and returns the file to transcribe, or null if it was too short to keep. */
  async stop(name: string): Promise<File | null> {
    if (this.closed) return null
    this.flushTap()
    await new Promise((r) => setTimeout(r, 60)) // let the last partial block arrive
    const ws = this.socket
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "end" }))
      await Promise.race([
        this.done,
        new Promise((r) => setTimeout(r, DONE_WAIT_MS)),
      ])
    }
    const blob = await this.finishMedia()
    this.close()
    if (this.seconds < MIN_SECONDS || !blob) return null
    const type = blob.type.split(";")[0] || "audio/wav"
    return new File([blob], `${name}.${EXTENSION[type] ?? "wav"}`, { type })
  }

  discard() {
    if (this.media?.state === "recording") this.media.stop()
    this.close()
  }

  private finishMedia(): Promise<Blob | null> {
    if (this.pcm) return Promise.resolve(wav(this.pcm))
    const media = this.media!
    if (media.state === "inactive")
      return Promise.resolve(
        this.chunks.length
          ? new Blob(this.chunks, { type: media.mimeType })
          : null
      )
    return new Promise((resolve) => {
      media.onstop = () =>
        resolve(
          this.chunks.length
            ? new Blob(this.chunks, { type: media.mimeType })
            : null
        )
      media.stop()
    })
  }

  /** Releases the mic (the macOS indicator turns off) and the audio graph. */
  private close() {
    if (this.closed) return
    this.closed = true
    this.socket?.close()
    this.socket = null
    this.stream.getTracks().forEach((t) => t.stop())
    void this.ctx.close().catch(() => {})
  }
}

function wav(blocks: Float32Array[]) {
  const n = blocks.reduce((a, b) => a + b.length, 0)
  const buf = new DataView(new ArrayBuffer(44 + n * 2))
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)))
  str(0, "RIFF")
  buf.setUint32(4, 36 + n * 2, true)
  str(8, "WAVE")
  str(12, "fmt ")
  buf.setUint32(16, 16, true)
  buf.setUint16(20, 1, true)
  buf.setUint16(22, 1, true)
  buf.setUint32(24, SAMPLE_RATE, true)
  buf.setUint32(28, SAMPLE_RATE * 2, true)
  buf.setUint16(32, 2, true)
  buf.setUint16(34, 16, true)
  str(36, "data")
  buf.setUint32(40, n * 2, true)
  let o = 44
  for (const b of blocks)
    for (let i = 0; i < b.length; i++, o += 2)
      buf.setInt16(o, Math.max(-1, Math.min(1, b[i])) * 0x7fff, true)
  return new Blob([buf], { type: "audio/wav" })
}

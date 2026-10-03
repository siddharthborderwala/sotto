import { readdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { MEDIA_DIR } from "./config"
import * as db from "./db"
import { decode, EngineUnavailable, peaks, transcribe, waitForEngine } from "./engine"
import { autoCleanup, enqueueCleanup } from "./cleanup"
import { emit } from "./events"


function emitUpsert(id: string) {
  const t = db.getSummary(id)
  if (t) emit({ type: "upsert", transcript: t })
}

// The engine handles one request at a time, so jobs run strictly in order.
const queue: string[] = []
let running = false
/** How long a job waits for an unavailable engine before failing. */
const ENGINE_WAIT_MS = 15 * 60_000

export const queueDepth = () => queue.length + (running ? 1 : 0)

export function enqueue(id: string) {
  if (!queue.includes(id)) queue.push(id)
  void drain()
}

async function drain() {
  if (running) return
  running = true
  while (queue.length) {
    const id = queue.shift()!
    try {
      await run(id)
    } catch (e) {
      // Engine restarting or stopped: put the job back, wait for it, and carry on in order.
      if (e instanceof EngineUnavailable) {
        db.setStatus(id, "queued")
        emitUpsert(id)
      }
      if (e instanceof EngineUnavailable && (await waitForEngine(ENGINE_WAIT_MS))) {
        queue.unshift(id)
        continue
      }
      db.setStatus(id, "error", e instanceof Error ? e.message : String(e))
      emitUpsert(id)
    }
  }
  running = false
}

async function run(id: string) {
  const media = db.getMedia(id)
  if (!media) return // deleted while queued
  db.setStatus(id, "processing")
  emitUpsert(id)

  const t0 = performance.now()
  const pcm = await decode(join(MEDIA_DIR, media.media_path))
  const t1 = performance.now()
  const result = await transcribe(pcm)
  const t2 = performance.now()

  if (!db.getMedia(id)) return
  // A mic recording where nothing was said isn't worth keeping (an accidental press, a silent room).
  if (!result.text && db.source(id) === "mic") {
    const row = db.remove(id)
    if (row) await unlink(join(MEDIA_DIR, row.media_path)).catch(() => {})
    emit({ type: "delete", id, reason: "no-speech" })
    return
  }
  db.complete(id, {
    ...result,
    peaks: peaks(pcm),
    convertMs: Math.round(t1 - t0),
    transcribeMs: Math.round(t2 - t1),
  })
  emitUpsert(id)
  if (autoCleanup()) enqueueCleanup(id)
}

/** Pick up anything interrupted by a crash or restart, and remove media no transcript points to. */
export async function resume() {
  for (const id of db.unfinished()) enqueue(id)
  const known = db.mediaPaths()
  for (const file of await readdir(MEDIA_DIR)) {
    if (!known.has(file)) await unlink(join(MEDIA_DIR, file)).catch(() => {})
  }
}

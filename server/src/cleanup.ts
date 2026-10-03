import { clean } from "./cleaners"
import { CLEANUP } from "./config"
import * as db from "./db"
import { emit } from "./events"

/** Runs the configured cleaner (see cleaners.ts) over transcripts, a few at a time. */

export const cleanupEnabled = () => CLEANUP.provider !== null
export const autoCleanup = () => cleanupEnabled() && CLEANUP.auto
const TIMEOUT_MS = 120_000
const CONCURRENCY = 3

const queue: string[] = []
let running = 0

export function enqueueCleanup(id: string) {
  if (queue.includes(id)) return
  db.setClean(id, "queued")
  emitUpsert(id)
  queue.push(id)
  pump()
}

function emitUpsert(id: string) {
  const t = db.getSummary(id)
  if (t) emit({ type: "upsert", transcript: t })
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift()!
    running++
    void run(id).finally(() => {
      running--
      pump()
    })
  }
}

async function run(id: string) {
  const lines = db.lines(id)
  if (!lines) return
  db.setClean(id, "running")
  emitUpsert(id)
  const t0 = performance.now()
  try {
    const cleaned = lines.length ? await clean(lines, AbortSignal.timeout(TIMEOUT_MS)) : []
    // The transcript may have been re-transcribed or deleted while Codex ran.
    if (JSON.stringify(db.lines(id)) !== JSON.stringify(lines)) return
    db.setClean(id, "done", { lines: cleaned, ms: Math.round(performance.now() - t0) })
  } catch (e) {
    if (!db.getSummary(id)) return
    db.setClean(id, "error", { error: e instanceof Error ? e.message : String(e) })
  }
  emitUpsert(id)
}

export function resumeCleanups() {
  for (const id of db.unfinishedCleanups()) enqueueCleanup(id)
}

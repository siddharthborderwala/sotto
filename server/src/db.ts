import { Database } from "bun:sqlite"
import { existsSync, renameSync } from "node:fs"
import { extname, join } from "node:path"
import { DATA_DIR, MEDIA_DIR } from "./config"
import { ID_LENGTH, newId } from "./ids"
import type { CleanStatus, Segment, Status, Transcript, TranscriptSummary } from "./types"

const DB_FILE = join(DATA_DIR, "sotto.db")

// Libraries from before the rename used phonon.db. Move it (and its WAL/SHM journals, which
// hold not-yet-checkpointed writes) before opening, so nothing is lost or opened twice.
const LEGACY_DB_FILE = join(DATA_DIR, "phonon.db")
if (existsSync(LEGACY_DB_FILE) && !existsSync(DB_FILE)) {
  for (const suffix of ["", "-wal", "-shm"])
    if (existsSync(LEGACY_DB_FILE + suffix)) renameSync(LEGACY_DB_FILE + suffix, DB_FILE + suffix)
}

export const db = new Database(DB_FILE, { create: true, strict: true })
db.run("PRAGMA journal_mode = WAL")
db.run("PRAGMA foreign_keys = ON")

const MIGRATIONS: (string | (() => void))[] = [
  `CREATE TABLE transcripts (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     original_name TEXT NOT NULL,
     mime TEXT,
     size_bytes INTEGER NOT NULL,
     media_path TEXT NOT NULL,
     duration_s REAL,
     status TEXT NOT NULL,
     error TEXT,
     text TEXT,
     segments TEXT,
     peaks BLOB,
     convert_ms INTEGER,
     transcribe_ms INTEGER,
     created_at INTEGER NOT NULL,
     completed_at INTEGER
   );
   CREATE INDEX transcripts_created ON transcripts(created_at DESC);
   CREATE VIRTUAL TABLE transcripts_fts USING fts5(title, text, content='transcripts', content_rowid='rowid', tokenize='porter unicode61');
   CREATE TRIGGER transcripts_ai AFTER INSERT ON transcripts BEGIN
     INSERT INTO transcripts_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
   END;
   CREATE TRIGGER transcripts_ad AFTER DELETE ON transcripts BEGIN
     INSERT INTO transcripts_fts(transcripts_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
   END;
   CREATE TRIGGER transcripts_au AFTER UPDATE OF title, text ON transcripts BEGIN
     INSERT INTO transcripts_fts(transcripts_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
     INSERT INTO transcripts_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
   END;`,
  // v2: short random ids (they're the URL suffix). Media files are named by id, so rename them too.
  () => {
    const rows = db.query("SELECT id, media_path FROM transcripts").all() as { id: string; media_path: string }[]
    const renamed: [string, string][] = []
    try {
      for (const r of rows) {
        if (r.id.length === ID_LENGTH) continue
        const id = newId()
        const mediaPath = id + extname(r.media_path)
        renameSync(join(MEDIA_DIR, r.media_path), join(MEDIA_DIR, mediaPath))
        renamed.push([r.media_path, mediaPath])
        db.query("UPDATE transcripts SET id = ?, media_path = ? WHERE id = ?").run(id, mediaPath, r.id)
      }
    } catch (e) {
      // The transaction rolls the rows back; put the files back to match.
      for (const [from, to] of renamed.reverse()) renameSync(join(MEDIA_DIR, to), join(MEDIA_DIR, from))
      throw e
    }
  },
  // v3: Codex clean-up, stored next to the raw transcript.
  `ALTER TABLE transcripts ADD COLUMN clean_lines TEXT;
   ALTER TABLE transcripts ADD COLUMN clean_status TEXT;
   ALTER TABLE transcripts ADD COLUMN clean_error TEXT;
   ALTER TABLE transcripts ADD COLUMN clean_ms INTEGER;`,
  // v4: where it came from. Mic recordings with no speech are discarded instead of kept.
  `ALTER TABLE transcripts ADD COLUMN source TEXT NOT NULL DEFAULT 'file';`,
]

const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
for (let v = version; v < MIGRATIONS.length; v++) {
  db.transaction(() => {
    const m = MIGRATIONS[v]
    if (typeof m === "string") db.run(m)
    else m()
    db.run(`PRAGMA user_version = ${v + 1}`)
  })()
}

type Row = {
  id: string
  title: string
  original_name: string
  mime: string | null
  size_bytes: number
  media_path: string
  duration_s: number | null
  status: Status
  error: string | null
  text: string | null
  segments: string | null
  convert_ms: number | null
  transcribe_ms: number | null
  created_at: number
  completed_at: number | null
  clean_lines: string | null
  clean_status: CleanStatus | null
  clean_error: string | null
  clean_ms: number | null
  snippet?: string
}

const SUMMARY_COLS = `id, title, status, error, duration_s, substr(text, 1, 160) AS text, created_at, clean_status`

function toSummary(r: Row): TranscriptSummary {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    error: r.error,
    durationS: r.duration_s,
    cleanStatus: r.clean_status ?? null,
    preview: r.text,
    createdAt: r.created_at,
    ...(r.snippet !== undefined && { snippet: r.snippet }),
  }
}

function toTranscript(r: Row): Transcript {
  return {
    ...toSummary(r),
    preview: r.text?.slice(0, 160) ?? null,
    originalName: r.original_name,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    text: r.text,
    segments: r.segments ? (JSON.parse(r.segments) as Segment[]) : [],
    convertMs: r.convert_ms,
    transcribeMs: r.transcribe_ms,
    completedAt: r.completed_at,
    isVideo: (r.mime ?? "").startsWith("video/"),
    cleanLines: r.clean_lines ? (JSON.parse(r.clean_lines) as string[]) : null,
    cleanError: r.clean_error,
    cleanMs: r.clean_ms,
  }
}

/** Quote each word so user input can't produce FTS syntax errors; last word gets prefix matching. */
function ftsQuery(q: string) {
  const words = q.match(/[\p{L}\p{N}']+/gu) ?? []
  return words.map((w, i) => `"${w.replaceAll('"', "")}"${i === words.length - 1 ? "*" : ""}`).join(" ")
}

export function list({ q, before, limit = 100 }: { q?: string; before?: number; limit?: number }) {
  if (q) {
    const match = ftsQuery(q)
    if (!match) return [] // nothing searchable, e.g. only punctuation
    const rows = db
      .query(
        `SELECT t.id, t.title, t.status, t.error, t.duration_s, substr(t.text, 1, 160) AS text, t.created_at, t.clean_status,
                snippet(transcripts_fts, -1, char(2), char(3), '…', 10) AS snippet
         FROM transcripts_fts JOIN transcripts t ON t.rowid = transcripts_fts.rowid
         WHERE transcripts_fts MATCH ?
         -- Title hits first (every word in the title), then by relevance.
         ORDER BY t.rowid IN (SELECT rowid FROM transcripts_fts WHERE transcripts_fts MATCH ?) DESC,
                  bm25(transcripts_fts, 10.0, 1.0)
         LIMIT ?`,
      )
      .all(match, `{title} : (${match})`, limit) as Row[]
    return rows.map(toSummary)
  }
  const rows = db
    .query(`SELECT ${SUMMARY_COLS} FROM transcripts WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`)
    .all(before ?? Number.MAX_SAFE_INTEGER, limit) as Row[]
  return rows.map(toSummary)
}

export function get(id: string) {
  const r = db.query("SELECT * FROM transcripts WHERE id = ?").get(id) as Row | null
  return r && toTranscript(r)
}

export function getSummary(id: string) {
  const r = db.query(`SELECT ${SUMMARY_COLS} FROM transcripts WHERE id = ?`).get(id) as Row | null
  return r && toSummary(r)
}

export function getMedia(id: string) {
  return db.query("SELECT media_path, mime FROM transcripts WHERE id = ?").get(id) as
    | { media_path: string; mime: string | null }
    | null
}

export function getPeaks(id: string) {
  const r = db.query("SELECT peaks FROM transcripts WHERE id = ?").get(id) as { peaks: Uint8Array | null } | null
  return r?.peaks ?? null
}

export function insert(t: {
  id: string
  title: string
  originalName: string
  mime: string | null
  sizeBytes: number
  mediaPath: string
  source: "file" | "mic"
}) {
  db.query(
    `INSERT INTO transcripts (id, title, original_name, mime, size_bytes, media_path, status, created_at, source)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(t.id, t.title, t.originalName, t.mime, t.sizeBytes, t.mediaPath, Date.now(), t.source)
}

export function setStatus(id: string, status: Status, error: string | null = null) {
  db.query("UPDATE transcripts SET status = ?, error = ? WHERE id = ?").run(status, error, id)
}

export function complete(
  id: string,
  r: { text: string; segments: Segment[]; durationS: number; peaks: Float32Array; convertMs: number; transcribeMs: number },
) {
  db.query(
    `UPDATE transcripts SET status = 'done', error = NULL, text = ?, segments = ?, duration_s = ?, peaks = ?,
       convert_ms = ?, transcribe_ms = ?, completed_at = ?,
       clean_lines = NULL, clean_status = NULL, clean_error = NULL, clean_ms = NULL WHERE id = ?`,
  ).run(
    r.text,
    JSON.stringify(r.segments),
    r.durationS,
    new Uint8Array(r.peaks.buffer, r.peaks.byteOffset, r.peaks.byteLength),
    r.convertMs,
    r.transcribeMs,
    Date.now(),
    id,
  )
}

export function rename(id: string, title: string) {
  return db.query("UPDATE transcripts SET title = ? WHERE id = ?").run(title, id).changes > 0
}

export function remove(id: string) {
  return db.query("DELETE FROM transcripts WHERE id = ? RETURNING media_path").get(id) as { media_path: string } | null
}

export function unfinished() {
  return (db.query("SELECT id FROM transcripts WHERE status IN ('queued', 'processing') ORDER BY created_at").all() as {
    id: string
  }[]).map((r) => r.id)
}

export function setClean(id: string, status: CleanStatus, r: { lines?: string[]; error?: string; ms?: number } = {}) {
  db.query(
    `UPDATE transcripts SET clean_status = ?,
       clean_lines = CASE WHEN ? IS NULL THEN clean_lines ELSE ? END,
       clean_error = ?, clean_ms = COALESCE(?, clean_ms) WHERE id = ?`,
  ).run(status, r.lines ? 1 : null, r.lines ? JSON.stringify(r.lines) : null, r.error ?? null, r.ms ?? null, id)
}

/** Raw segment texts for the clean-up, or null if there is nothing to clean. */
export function lines(id: string) {
  const r = db.query("SELECT status, segments FROM transcripts WHERE id = ?").get(id) as
    | { status: Status; segments: string | null }
    | null
  if (!r || r.status !== "done" || !r.segments) return null
  return (JSON.parse(r.segments) as Segment[]).map((s) => s.text)
}

export function unfinishedCleanups() {
  return (
    db.query("SELECT id FROM transcripts WHERE clean_status IN ('queued', 'running') ORDER BY created_at").all() as {
      id: string
    }[]
  ).map((r) => r.id)
}

/** Every media file name a transcript refers to (for sweeping orphans). */
export function mediaPaths() {
  return new Set((db.query("SELECT media_path FROM transcripts").all() as { media_path: string }[]).map((r) => r.media_path))
}

export function source(id: string) {
  return (db.query("SELECT source FROM transcripts WHERE id = ?").get(id) as { source: "file" | "mic" } | null)?.source
}

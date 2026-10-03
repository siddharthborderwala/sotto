import { readFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { upgradeWebSocket, websocket } from "@hono/bun"
import { autoCleanup, cleanupEnabled, enqueueCleanup, resumeCleanups } from "./cleanup"
import { clean } from "./cleaners"
import { CLAUDE, CLEANUP, CODEX, DATA_DIR, DEFAULT_MODEL, EFFORTS, ENGINE, HOST, MEDIA_DIR, PORT, WEB_DIST, saveCleanup, type CleanupSettings } from "./config"
import * as db from "./db"
import { engineUp, ensureEngine, hasAudio, remux } from "./engine"
import { type BundleKind, entries, safeName, zipStream } from "./bundle"
import { emit, subscribe } from "./events"
import { FORMATS, type Format, type TextVersion, version } from "./export"
import { newId } from "./ids"
import { enqueue, queueDepth, resume } from "./jobs"
import type { CleanupSettingsInput, Health, Settings } from "./types"

/** Streams an upload to disk. If the client goes away mid-upload, the partial file is removed. */
async function save(body: ReadableStream<Uint8Array>, path: string) {
  const sink = Bun.file(path).writer()
  let size = 0
  try {
    for await (const chunk of body) {
      sink.write(chunk)
      size += chunk.byteLength
    }
  } catch (e) {
    await Promise.resolve(sink.end()).catch(() => {})
    await unlink(path).catch(() => {})
    throw e
  }
  await sink.end()
  return size
}

function decodeName(header: string | undefined) {
  try {
    return decodeURIComponent(header ?? "recording")
  } catch {
    return null
  }
}


const VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version?: string }).version ?? "dev"

function settingsView(): Settings {
  return {
    cleanup: {
      provider: CLEANUP.provider,
      auto: CLEANUP.auto,
      model: CLEANUP.model,
      effort: CLEANUP.effort,
      url: CLEANUP.url,
      apiKeySet: !!CLEANUP.apiKey,
    },
    installed: { claude: !!CLAUDE, codex: !!CODEX },
    efforts: EFFORTS,
    defaultModels: DEFAULT_MODEL,
    addresses: [...(HOST ? [`https://${HOST}`] : []), `http://localhost:${PORT}`],
    dataDir: DATA_DIR,
    version: VERSION,
  }
}

/** Validates settings from the browser and fills in the saved API key unless a new one was given. */
function parseCleanup(body: unknown): CleanupSettings | string {
  const b = body as Partial<CleanupSettingsInput> | null
  if (!b || typeof b !== "object") return "Expected clean-up settings."
  const provider = b.provider ?? null
  if (provider !== null && !["claude", "codex", "openai"].includes(provider)) return "Unknown provider."
  const text = (v: unknown, fallback = "") => (typeof v === "string" ? v.trim() : fallback)
  if (provider === "openai" && !/^https?:\/\/\S+$/.test(text(b.url))) return "Enter the API's base URL, e.g. http://localhost:11434/v1."
  if (provider === "openai" && !text(b.model)) return "Enter the model to use."
  const efforts = provider ? EFFORTS[provider] : []
  return {
    provider,
    auto: b.auto !== false,
    model: text(b.model) || (provider ? DEFAULT_MODEL[provider] : ""),
    effort: efforts.includes(text(b.effort)) ? text(b.effort) : "low",
    url: text(b.url, CLEANUP.url),
    apiKey: typeof b.apiKey === "string" ? b.apiKey.trim() : CLEANUP.apiKey,
  }
}

// The API has no login, so only this Mac's own pages may use it. Checking Host blocks DNS
// rebinding (a website re-pointing its own name at 127.0.0.1); checking Origin blocks other
// sites from posting to us or opening the mic WebSocket. Browsers can't forge either header.
const NAMES = ["localhost", "127\\.0\\.0\\.1", "\\[::1\\]", ...(HOST ? [HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")] : [])].join("|")
const LOCAL_HOST = new RegExp(`^(${NAMES})(:\\d+)?$`, "i")
const LOCAL_ORIGIN = new RegExp(`^https?://(${NAMES})(:\\d+)?$`, "i")

const api = new Hono()
  .use(async (c, next) => {
    if (!LOCAL_HOST.test(c.req.header("host") ?? "")) return c.json({ error: "Unknown host" }, 421)
    const origin = c.req.header("origin")
    const unsafe = c.req.method !== "GET" || c.req.header("upgrade")?.toLowerCase() === "websocket"
    if (unsafe && (c.req.header("sec-fetch-site") === "cross-site" || (origin && !LOCAL_ORIGIN.test(origin))))
      return c.json({ error: "Cross-site request refused" }, 403)
    await next()
  })
  .get("/health", async (c) => c.json<Health>({
      engine: await engineUp(),
      queue: queueDepth(),
      cleanup: cleanupEnabled() ? { provider: CLEANUP.provider!, auto: autoCleanup() } : null,
    }))

  .get("/transcripts", (c) => {
    const q = c.req.query("q")?.trim()
    const before = Number(c.req.query("before")) || undefined
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit")) || 100))
    return c.json(db.list({ q, before, limit }))
  })

  // One file per request, raw body, so large recordings stream straight to disk.
  .post("/transcripts", async (c) => {
    const name = decodeName(c.req.header("x-filename"))
    if (name === null) return c.json({ error: "x-filename must be URL-encoded" }, 400)
    const mime = c.req.header("content-type") || null
    if (!c.req.raw.body) return c.json({ error: "Empty upload" }, 400)
    const id = newId()
    const mediaPath = id + (extname(name).toLowerCase() || ".bin")
    const size = await save(c.req.raw.body, join(MEDIA_DIR, mediaPath))
    if (!size || !(await hasAudio(join(MEDIA_DIR, mediaPath)))) {
      await unlink(join(MEDIA_DIR, mediaPath)).catch(() => {})
      return c.json({ error: size ? "This file has no audio to transcribe." : "Empty upload" }, size ? 415 : 400)
    }
    let stored = size
    if (c.req.header("x-recorded") === "1") {
      await remux(join(MEDIA_DIR, mediaPath))
      stored = Bun.file(join(MEDIA_DIR, mediaPath)).size
    }
    const title = name.replace(/\.[^.]+$/, "") || "Untitled recording"
    db.insert({
      id,
      title,
      originalName: name,
      mime,
      sizeBytes: stored,
      mediaPath,
      source: c.req.header("x-recorded") === "1" ? "mic" : "file",
    })
    const t = db.getSummary(id)!
    emit({ type: "upsert", transcript: t })
    enqueue(id)
    return c.json(t, 201)
  })

  .get("/transcripts/:id", (c) => {
    const t = db.get(c.req.param("id"))
    return t ? c.json(t) : c.json({ error: "Not found" }, 404)
  })

  .patch("/transcripts/:id", async (c) => {
    const body = await c.req.json<{ title?: unknown }>().catch(() => null)
    const clean = typeof body?.title === "string" ? body.title.trim() : ""
    if (!clean) return c.json({ error: "Title can't be empty" }, 400)
    if (!db.rename(c.req.param("id"), clean)) return c.json({ error: "Not found" }, 404)
    const t = db.getSummary(c.req.param("id"))!
    emit({ type: "upsert", transcript: t })
    return c.json(t)
  })

  .delete("/transcripts/:id", async (c) => {
    const id = c.req.param("id")
    const row = db.remove(id)
    if (!row) return c.json({ error: "Not found" }, 404)
    await unlink(join(MEDIA_DIR, row.media_path)).catch(() => {})
    emit({ type: "delete", id })
    return c.body(null, 204)
  })

  .post("/transcripts/:id/retry", (c) => {
    const id = c.req.param("id")
    const t = db.getSummary(id)
    if (!t) return c.json({ error: "Not found" }, 404)
    if (t.status === "queued" || t.status === "processing")
      return c.json({ error: "This file is already being transcribed." }, 409)
    db.setStatus(id, "queued")
    emit({ type: "upsert", transcript: db.getSummary(id)! })
    enqueue(id)
    return c.json(db.getSummary(id))
  })

  .post("/transcripts/:id/cleanup", (c) => {
    const id = c.req.param("id")
    const t = db.getSummary(id)
    if (!t) return c.json({ error: "Not found" }, 404)
    if (!cleanupEnabled()) return c.json({ error: "Clean-up is off. Choose a provider in Settings." }, 409)
    if (t.status !== "done") return c.json({ error: "Transcribe it first." }, 409)
    if (t.cleanStatus === "queued" || t.cleanStatus === "running")
      return c.json({ error: "Already cleaning up." }, 409)
    enqueueCleanup(id)
    return c.json(db.getSummary(id))
  })

  .get("/settings", (c) => c.json<Settings>(settingsView()))

  .put("/settings/cleanup", async (c) => {
    const next = parseCleanup(await c.req.json().catch(() => null))
    if (typeof next === "string") return c.json({ error: next }, 400)
    saveCleanup(next)
    return c.json<Settings>(settingsView())
  })

  // Tries settings before saving them: cleans a sample with exactly what's in the form.
  .post("/settings/cleanup/test", async (c) => {
    const next = parseCleanup(await c.req.json().catch(() => null))
    if (typeof next === "string") return c.json({ error: next }, 400)
    const sample = ["Um so I I think we should, uh, ship the the update on Friday.", "You know?"]
    const t0 = performance.now()
    try {
      const lines = await clean(sample, AbortSignal.timeout(120_000), next)
      return c.json({ before: sample, after: lines, ms: Math.round(performance.now() - t0) })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 422)
    }
  })

  // Live mic transcription: relays the browser's 16 kHz PCM to the engine's stream and its
  // partial/final/done messages back. The engine allows one stream at a time.
  .get(
    "/live",
    upgradeWebSocket(() => {
      let engine: WebSocket | null = null
      const pending: (string | ArrayBuffer | Uint8Array)[] = []
      return {
        onOpen(_e, ws) {
          engine = new WebSocket(`${ENGINE.replace(/^http/, "ws")}/v1/audio/stream`)
          engine.binaryType = "arraybuffer"
          engine.onopen = () => {
            for (const m of pending.splice(0)) engine!.send(m)
          }
          engine.onmessage = (m) => ws.send(typeof m.data === "string" ? m.data : new Uint8Array(m.data as ArrayBuffer))
          engine.onerror = () =>
            ws.send(JSON.stringify({ type: "error", message: "Live transcription isn't available right now." }))
          engine.onclose = () => ws.close()
        },
        onMessage(e) {
          const data = e.data instanceof Blob ? null : (e.data as string | ArrayBuffer | Uint8Array)
          if (data === null) return
          if (engine?.readyState === WebSocket.OPEN) engine.send(data)
          else pending.push(data)
        },
        onClose() {
          engine?.close()
        },
      }
    }),
  )

  .get("/transcripts/:id/peaks", (c) => {
    const id = c.req.param("id")
    const peaks = db.getPeaks(id)
    // Not transcribed yet is a normal state, not an error.
    if (!peaks) return db.getMedia(id) ? c.body(null, 204) : c.json({ error: "Not found" }, 404)
    return c.body(new Uint8Array(peaks), 200, { "content-type": "application/octet-stream", "cache-control": "max-age=31536000, immutable" })
  })

  .get("/transcripts/:id/media", async (c) => {
    const media = db.getMedia(c.req.param("id"))
    if (!media) return c.json({ error: "Not found" }, 404)
    const file = Bun.file(join(MEDIA_DIR, media.media_path))
    const type = media.mime || file.type
    const size = file.size
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "")
    if (!range) return new Response(file, { headers: { "content-type": type, "accept-ranges": "bytes" } })
    let start = range[1] ? Number(range[1]) : size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(end, size - 1)
    if (start > end) return c.body(null, 416, { "content-range": `bytes */${size}` })
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" },
    })
  })

  .get("/transcripts/:id/export/:format", (c) => {
    const format = c.req.param("format") as Format
    if (!Object.hasOwn(FORMATS, format)) return c.json({ error: "Unknown format" }, 400)
    const t = db.get(c.req.param("id"))
    if (!t || t.status !== "done") return c.json({ error: "Not found" }, 404)
    const filename = `${safeName(t.title)}.${format}`
    return c.body(FORMATS[format].render(version(t, c.req.query("text") as TextVersion)), 200, {
      "content-type": `${FORMATS[format].mime}; charset=utf-8`,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    })
  })

  // Several transcripts at once: ?ids=a,b,c&kind=txt|md|srt|vtt|original. One file comes back as-is, more as a zip.
  .get("/bundle", async (c) => {
    const kind = c.req.query("kind") as BundleKind
    if (kind !== "original" && !Object.hasOwn(FORMATS, kind)) return c.json({ error: "Unknown kind" }, 400)
    const ids = [...new Set((c.req.query("ids") ?? "").split(",").filter(Boolean))]
    const files = await entries(ids, kind, c.req.query("text") as TextVersion)
    if (!files.length) return c.json({ error: "Nothing to download" }, 404)
    const disposition = (n: string) => `attachment; filename*=UTF-8''${encodeURIComponent(n)}`
    if (files.length === 1) {
      const data = files[0].data()
      return c.body(data, 200, {
        "content-type": kind === "original" ? "application/octet-stream" : `${FORMATS[kind].mime}; charset=utf-8`,
        "content-disposition": disposition(files[0].name),
      })
    }
    const noun = kind === "original" ? "recordings" : "transcripts"
    return c.body(zipStream(files), 200, {
      "content-type": "application/zip",
      "content-disposition": disposition(`Sotto - ${files.length} ${noun}.zip`),
    })
  })

  .get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = subscribe((e) => void stream.writeSSE({ data: JSON.stringify(e) }))
      stream.onAbort(() => {
        unsubscribe()
      })
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" })
        await stream.sleep(20_000)
      }
    }),
  )

const app = new Hono()
app.route("/api", api)
// Unknown API paths are JSON 404s, not the SPA page.
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404))

// Built SPA; unknown paths fall back to index.html.
app.get("*", async (c) => {
  const path = normalize(c.req.path).replace(/^(\.\.[/\\])+/, "")
  const file = Bun.file(join(WEB_DIST, path))
  if (path !== "/" && (await file.exists())) {
    const immutable = path.startsWith("/assets/")
    return new Response(file, { headers: immutable ? { "cache-control": "max-age=31536000, immutable" } : {} })
  }
  const index = Bun.file(join(WEB_DIST, "index.html"))
  if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } })
  return c.text("Web UI not built. Run `bun run build` in the project root.", 503)
})

export type AppType = typeof api

await ensureEngine().catch((e) => console.error(String(e)))
await resume()
resumeCleanups()
console.log(`sotto on http://localhost:${PORT}`)

export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
  websocket,
  maxRequestBodySize: 16 * 1024 ** 3,
  idleTimeout: 120,
}

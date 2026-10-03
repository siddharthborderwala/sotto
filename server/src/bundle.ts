import { extname, join } from "node:path"
import { Zip, ZipPassThrough } from "fflate"
import { MEDIA_DIR } from "./config"
import * as db from "./db"
import { FORMATS, type Format, type TextVersion, version } from "./export"

export type BundleKind = Format | "original"

export const safeName = (s: string) => s.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").trim() || "Untitled"

/** "Title.txt", then "Title (2).txt", … so same-titled transcripts don't overwrite each other. */
function uniqueNamer() {
  const used = new Set<string>()
  return (base: string, ext: string) => {
    let name = base + ext
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`
    used.add(name.toLowerCase())
    return name
  }
}

type Entry = { name: string; data: () => ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer> }

/** What goes in the zip. Exports skip unfinished transcripts; originals skip files missing on disk. */
export async function entries(ids: string[], kind: BundleKind, textVersion?: TextVersion) {
  const name = uniqueNamer()
  const out: Entry[] = []
  for (const id of ids) {
    const t = db.get(id)
    if (!t) continue
    if (kind === "original") {
      const media = db.getMedia(id)!
      const file = Bun.file(join(MEDIA_DIR, media.media_path))
      if (!(await file.exists())) continue
      const ext = extname(t.originalName) || extname(media.media_path)
      out.push({ name: name(safeName(t.title), ext), data: () => file.stream() })
    } else {
      if (t.status !== "done") continue
      const text = new TextEncoder().encode(FORMATS[kind].render(version(t, textVersion)))
      out.push({ name: name(safeName(t.title), `.${kind}`), data: () => text })
    }
  }
  return out
}

/** A stored (uncompressed) zip, streamed entry by entry so multi-GB originals never sit in memory. */
export function zipStream(files: Entry[]) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const zip = new Zip((err, chunk, final) => {
        if (err) return controller.error(err)
        controller.enqueue(chunk)
        if (final) controller.close()
      })
      try {
        for (const f of files) {
          const entry = new ZipPassThrough(f.name)
          zip.add(entry)
          const data = f.data()
          if (data instanceof Uint8Array) entry.push(data, true)
          else {
            for await (const chunk of data) entry.push(chunk)
            entry.push(new Uint8Array(0), true)
          }
        }
        zip.end()
      } catch (e) {
        controller.error(e)
      }
    },
  })
}

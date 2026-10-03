import { toast } from "sonner"
import { api, type Transcript, type TranscriptSummary } from "@/lib/api"
import { getTextVersion } from "@/lib/text-version"

export type ExportFormat = "txt" | "md" | "srt" | "vtt"
export type DownloadKind = ExportFormat | "original"

const done = (ts: TranscriptSummary[]) => ts.filter((t) => t.status === "done")
const busy = (t: TranscriptSummary) =>
  t.status === "queued" || t.status === "processing"
const plural = (n: number, one: string, many = one + "s") =>
  `${n} ${n === 1 ? one : many}`

/** The text you're looking at: cleaned lines when the preference is Clean and they exist. */
export function shownText(t: Transcript) {
  if (getTextVersion() === "clean" && t.cleanLines)
    return t.cleanLines.filter((l) => l.trim()).join(" ")
  return t.text ?? ""
}

const cleaning = (t: TranscriptSummary) =>
  t.cleanStatus === "queued" || t.cleanStatus === "running"

export const can = {
  copy: (ts: TranscriptSummary[]) => done(ts).length > 0,
  export: (ts: TranscriptSummary[]) => done(ts).length > 0,
  retry: (ts: TranscriptSummary[]) => ts.some((t) => !busy(t)),
  cleanup: (ts: TranscriptSummary[]) =>
    ts.some((t) => t.status === "done" && !cleaning(t)),
}

function skippedNote(total: number, used: number) {
  const skipped = total - used
  return skipped
    ? `${plural(skipped, "transcript")} not finished yet, skipped.`
    : undefined
}

/**
 * Copies text for one or more transcripts. The clipboard write starts synchronously with a
 * promised blob, because Safari rejects clipboard writes made after an await.
 */
export function copy(targets: TranscriptSummary[]) {
  const ready = done(targets)
  if (!ready.length) return
  const text = Promise.all(ready.map((t) => api.get(t.id))).then((full) =>
    full.length === 1
      ? shownText(full[0])
      : full.map((t) => `# ${t.title}\n\n${shownText(t)}`).join("\n\n")
  )
  const write =
    typeof ClipboardItem !== "undefined"
      ? navigator.clipboard
          .write([
            new ClipboardItem({
              "text/plain": text.then(
                (t) => new Blob([t], { type: "text/plain" })
              ),
            }),
          ])
          .catch(async () => navigator.clipboard.writeText(await text))
      : text.then((t) => navigator.clipboard.writeText(t))
  write.then(
    () =>
      toast(
        ready.length === 1
          ? "Copied"
          : `Copied ${plural(ready.length, "transcript")}`,
        {
          description: skippedNote(targets.length, ready.length),
        }
      ),
    () => toast.error("Couldn't copy to the clipboard")
  )
}

export function download(targets: TranscriptSummary[], kind: DownloadKind) {
  const usable = kind === "original" ? targets : done(targets)
  if (!usable.length) return
  // Originals go through the bundle route even when single, so the file keeps its title.
  const url =
    usable.length > 1 || kind === "original"
      ? api.bundleUrl(
          usable.map((t) => t.id),
          kind
        )
      : api.exportUrl(usable[0].id, kind)
  const a = document.createElement("a")
  a.href = url
  a.download = ""
  document.body.append(a)
  a.click()
  a.remove()
  if (kind !== "original") {
    const note = skippedNote(targets.length, usable.length)
    if (note)
      toast(`Exported ${plural(usable.length, "transcript")}`, {
        description: note,
      })
  }
}

export async function retry(targets: TranscriptSummary[]) {
  const eligible = targets.filter((t) => !busy(t))
  const results = await Promise.allSettled(eligible.map((t) => api.retry(t.id)))
  const failed = results.filter((r) => r.status === "rejected").length
  if (failed) toast.error(`Couldn't restart ${plural(failed, "transcript")}`)
  else
    toast(
      eligible.length === 1
        ? "Transcribing again"
        : `Transcribing ${eligible.length} again`
    )
}

export async function cleanup(targets: TranscriptSummary[]) {
  const eligible = targets.filter((t) => t.status === "done" && !cleaning(t))
  const results = await Promise.allSettled(
    eligible.map((t) => api.cleanup(t.id))
  )
  const failed = results.filter((r) => r.status === "rejected").length
  if (failed)
    toast.error(`Couldn't start clean-up for ${plural(failed, "transcript")}`)
  else
    toast(
      eligible.length === 1
        ? "Cleaning up"
        : `Cleaning up ${eligible.length} transcripts`
    )
}

export async function remove(targets: TranscriptSummary[]) {
  const results = await Promise.allSettled(targets.map((t) => api.remove(t.id)))
  const failed = results.filter((r) => r.status === "rejected").length
  if (failed) toast.error(`Couldn't delete ${plural(failed, "transcript")}`)
  else
    toast(
      targets.length === 1
        ? "Deleted"
        : `Deleted ${plural(targets.length, "transcript")}`
    )
}

export { plural }

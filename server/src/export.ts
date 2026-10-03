import type { Transcript } from "./types"

function stamp(s: number, sep: "," | ".") {
  const ms = Math.round(s * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${pad(h)}:${pad(m)}:${pad(sec)}${sep}${pad(ms % 1000, 3)}`
}

export function clock(s: number) {
  const t = Math.floor(s)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

export const FORMATS = {
  txt: { mime: "text/plain", render: (t: Transcript) => `${t.text ?? ""}\n` },
  md: {
    mime: "text/markdown",
    render: (t: Transcript) =>
      `# ${t.title}\n\n` + t.segments.map((s) => `**[${clock(s.start)}]** ${s.text}`).join("\n\n") + "\n",
  },
  srt: {
    mime: "application/x-subrip",
    render: (t: Transcript) =>
      t.segments.map((s, i) => `${i + 1}\n${stamp(s.start, ",")} --> ${stamp(s.end, ",")}\n${s.text}\n`).join("\n"),
  },
  vtt: {
    mime: "text/vtt",
    render: (t: Transcript) =>
      "WEBVTT\n\n" + t.segments.map((s) => `${stamp(s.start, ".")} --> ${stamp(s.end, ".")}\n${s.text}\n`).join("\n"),
  },
} as const

export type Format = keyof typeof FORMATS

export type TextVersion = "clean" | "raw"

/** The transcript as exported: cleaned lines (filler-only lines dropped) unless `raw` is asked for or there are none. */
export function version(t: Transcript, v: TextVersion | undefined): Transcript {
  if (v === "raw" || !t.cleanLines || t.cleanLines.length !== t.segments.length) return t
  const segments = t.segments
    .map((s, i) => ({ ...s, text: t.cleanLines![i].trim() }))
    .filter((s) => s.text)
  return { ...t, segments, text: segments.map((s) => s.text).join(" ") }
}

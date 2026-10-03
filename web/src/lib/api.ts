import { getTextVersion } from "@/lib/text-version"
import type {
  CleanupSettingsInput,
  Health,
  Settings,
  ServerEvent,
  Transcript,
  TranscriptSummary,
} from "../../../server/src/types"

export type {
  CleanupSettingsInput,
  Settings,
  Health,
  Segment,
  ServerEvent,
  Status,
  Transcript,
  TranscriptSummary,
} from "../../../server/src/types"

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  health: () => req<Health>("/health"),
  settings: () => req<Settings>("/settings"),
  saveCleanup: (s: CleanupSettingsInput) =>
    req<Settings>("/settings/cleanup", {
      method: "PUT",
      body: JSON.stringify(s),
      headers: { "content-type": "application/json" },
    }),
  testCleanup: (s: CleanupSettingsInput) =>
    req<{ before: string[]; after: string[]; ms: number }>(
      "/settings/cleanup/test",
      {
        method: "POST",
        body: JSON.stringify(s),
        headers: { "content-type": "application/json" },
      }
    ),
  /** Newest first. `before` (a createdAt) pages backwards; `q` searches instead. */
  list: ({
    q,
    before,
    limit,
  }: { q?: string; before?: number; limit?: number } = {}) => {
    const params = new URLSearchParams()
    if (q) params.set("q", q)
    if (before) params.set("before", String(before))
    if (limit) params.set("limit", String(limit))
    const qs = params.toString()
    return req<TranscriptSummary[]>(`/transcripts${qs ? `?${qs}` : ""}`)
  },
  get: (id: string) => req<Transcript>(`/transcripts/${id}`),
  peaks: async (id: string) => {
    const res = await fetch(`/api/transcripts/${id}/peaks`)
    // 204: not transcribed yet, so no waveform.
    return res.status === 200 ? new Float32Array(await res.arrayBuffer()) : null
  },
  /** `recorded`: made by mic mode, so the server repackages it to be seekable. */
  upload: (file: File, { recorded = false } = {}) =>
    req<TranscriptSummary>("/transcripts", {
      method: "POST",
      body: file,
      headers: {
        "x-filename": encodeURIComponent(file.name),
        "content-type": file.type || "application/octet-stream",
        ...(recorded && { "x-recorded": "1" }),
      },
    }),
  rename: (id: string, title: string) =>
    req<TranscriptSummary>(`/transcripts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
      headers: { "content-type": "application/json" },
    }),
  remove: (id: string) => req<void>(`/transcripts/${id}`, { method: "DELETE" }),
  retry: (id: string) =>
    req<TranscriptSummary>(`/transcripts/${id}/retry`, { method: "POST" }),
  cleanup: (id: string) =>
    req<TranscriptSummary>(`/transcripts/${id}/cleanup`, { method: "POST" }),
  mediaUrl: (id: string) => `/api/transcripts/${id}/media`,
  /** Follows the Clean/Raw preference; the server falls back to raw when there's no clean version. */
  exportUrl: (id: string, format: "txt" | "md" | "srt" | "vtt") =>
    `/api/transcripts/${id}/export/${format}?text=${getTextVersion()}`,
  /** Several transcripts (or one original, so it downloads under its title) in one download. */
  bundleUrl: (ids: string[], kind: "txt" | "md" | "srt" | "vtt" | "original") =>
    `/api/bundle?ids=${ids.join(",")}&kind=${kind}&text=${getTextVersion()}`,
}

export function subscribe(
  onEvent: (e: ServerEvent) => void,
  onOpen?: () => void
) {
  const es = new EventSource("/api/events")
  es.onmessage = (m) => onEvent(JSON.parse(m.data))
  es.onopen = () => onOpen?.()
  return () => es.close()
}

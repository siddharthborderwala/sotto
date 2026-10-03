// Shared between the server and the web client (imported by path from web/).

export type Status = "queued" | "processing" | "done" | "error"

export type Segment = { start: number; end: number; text: string }

/** Codex clean-up of the transcript, one cleaned line per segment. */
export type CleanStatus = "queued" | "running" | "done" | "error"

export type TranscriptSummary = {
  id: string
  title: string
  status: Status
  error: string | null
  durationS: number | null
  cleanStatus: CleanStatus | null
  preview: string | null
  createdAt: number
  /** FTS snippet; matches are wrapped in \u0002 … \u0003. Present only for searches. */
  snippet?: string
}

export type Transcript = TranscriptSummary & {
  originalName: string
  mime: string | null
  sizeBytes: number
  text: string | null
  segments: Segment[]
  convertMs: number | null
  transcribeMs: number | null
  completedAt: number | null
  isVideo: boolean
  /** Cleaned text per segment (same length as `segments`; "" where a line was only filler). */
  cleanLines: string[] | null
  cleanError: string | null
  cleanMs: number | null
}

export type ServerEvent =
  | { type: "upsert"; transcript: TranscriptSummary }
  /** `reason: "no-speech"`: a mic recording was discarded because nothing was said. */
  | { type: "delete"; id: string; reason?: "no-speech" }

export type CleanupProviderName = "claude" | "codex" | "openai"

/** Clean-up settings as the browser sees them: the API key never leaves the server. */
export type CleanupSettingsView = {
  provider: CleanupProviderName | null
  auto: boolean
  model: string
  effort: string
  url: string
  apiKeySet: boolean
}

/** What the browser sends: omit apiKey to keep the saved one, "" to clear it. */
export type CleanupSettingsInput = Omit<CleanupSettingsView, "apiKeySet"> & { apiKey?: string }

export type Settings = {
  cleanup: CleanupSettingsView
  /** Which CLI providers are installed on this Mac. */
  installed: { claude: boolean; codex: boolean }
  /** Effort levels each provider accepts (empty: no effort setting). */
  efforts: Record<CleanupProviderName, string[]>
  /** Default model per provider. */
  defaultModels: Record<CleanupProviderName, string>
  addresses: string[]
  dataDir: string
  version: string
}

export type Health = {
  engine: boolean
  queue: number
  /** null when clean-up is off. */
  cleanup: { provider: CleanupProviderName; auto: boolean } | null
}

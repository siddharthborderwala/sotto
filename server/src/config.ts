import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Settings come from the environment, then `config.env` in the data directory (written by
 * scripts/install.sh), then defaults. Restart the web service after editing config.env.
 */

export const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), "Library/Application Support/sotto")
export const MEDIA_DIR = join(DATA_DIR, "media")
export const CONFIG_FILE = join(DATA_DIR, "config.env")
export const WEB_DIST = join(import.meta.dir, "../../web/dist")

function readConfigFile(): Record<string, string> {
  if (!existsSync(CONFIG_FILE)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(CONFIG_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trimStart().startsWith("#")) continue
    const raw = m[2]
    out[m[1]] = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
      ? raw.slice(1, -1).replace(/\\(["\\])/g, "$1")
      : raw
  }
  return out
}

const file = readConfigFile()
const setting = (key: string, fallback: string) => process.env[key] ?? file[key] ?? fallback

export const PORT = Number(process.env.PORT ?? setting("SOTTO_PORT", "8011"))
export const ENGINE_PORT = Number(setting("SOTTO_ENGINE_PORT", "8010"))
export const ENGINE = `http://127.0.0.1:${ENGINE_PORT}`

/** Optional HTTPS hostname served by the Caddy proxy (e.g. sotto.example.com). */
export const HOST = setting("SOTTO_HOST", "").toLowerCase()

export type CleanupProvider = "claude" | "codex" | "openai"

/**
 * Transcript clean-up (filler words, stutters, punctuation). Off unless you pick a provider:
 *   claude   the Claude Code CLI with your Claude sign-in (sends text to Anthropic)
 *   codex    the Codex CLI with your ChatGPT sign-in (sends text to OpenAI)
 *   openai   any OpenAI-compatible chat API: OpenAI, or local Ollama / LM Studio / llama.cpp /
 *            `fermion serve` (stays on this Mac)
 * Editable at runtime from the settings dialog, which saves to config.env.
 */
export type CleanupSettings = {
  provider: CleanupProvider | null
  /** Clean every new transcript automatically (otherwise only from the menu). */
  auto: boolean
  model: string
  effort: string
  url: string
  apiKey: string
}

const parseProvider = (v: string): CleanupProvider | null => {
  v = v.toLowerCase()
  if (v === "on") return "codex" // earlier setting name
  return v === "claude" || v === "codex" || v === "openai" ? v : null
}

/** Fast defaults for the CLI providers; the OpenAI-compatible provider needs a model named. */
export const DEFAULT_MODEL: Record<CleanupProvider, string> = { claude: "haiku", codex: "gpt-6-luna", openai: "" }
export const EFFORTS: Record<CleanupProvider, string[]> = {
  claude: ["low", "medium", "high"],
  codex: ["minimal", "low", "medium", "high"],
  openai: [],
}

export const CLEANUP: CleanupSettings = (() => {
  const provider = parseProvider(setting("SOTTO_CLEANUP", "off"))
  return {
    provider,
    auto: setting("SOTTO_CLEANUP_AUTO", "on") !== "off",
    model: setting("SOTTO_CLEANUP_MODEL", provider ? DEFAULT_MODEL[provider] : ""),
    effort: setting("SOTTO_CLEANUP_EFFORT", "low"),
    url: setting("SOTTO_CLEANUP_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: setting("SOTTO_CLEANUP_API_KEY", process.env.OPENAI_API_KEY ?? ""),
  }
})()

const ENV_KEYS: Record<Exclude<keyof CleanupSettings, "provider">, string> = {
  auto: "SOTTO_CLEANUP_AUTO",
  model: "SOTTO_CLEANUP_MODEL",
  effort: "SOTTO_CLEANUP_EFFORT",
  url: "SOTTO_CLEANUP_URL",
  apiKey: "SOTTO_CLEANUP_API_KEY",
}

const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`

/** Applies new clean-up settings now and writes them to config.env (owner-only: it can hold an API key). */
export function saveCleanup(next: CleanupSettings) {
  Object.assign(CLEANUP, next, { url: next.url.replace(/\/+$/, "") })
  const values: Record<string, string> = {
    SOTTO_CLEANUP: CLEANUP.provider ?? "off",
    [ENV_KEYS.auto]: CLEANUP.auto ? "on" : "off",
    [ENV_KEYS.model]: CLEANUP.model,
    [ENV_KEYS.effort]: CLEANUP.effort,
    [ENV_KEYS.url]: CLEANUP.url,
    [ENV_KEYS.apiKey]: CLEANUP.apiKey,
  }
  // Keep every other line (comments, ports, host) as it is; drop settings that no longer exist.
  const retired = ["SOTTO_CLEANUP_COMMAND"]
  const kept = existsSync(CONFIG_FILE)
    ? readFileSync(CONFIG_FILE, "utf8")
        .split("\n")
        .filter(
          (l) => l.trim() && ![...Object.keys(values), ...retired].some((k) => l.trimStart().startsWith(`${k}=`)),
        )
    : ["# Sotto settings. Environment variables override these. Restart the web service after editing by hand."]
  const lines = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${quote(v)}`)]
  writeFileSync(CONFIG_FILE, lines.join("\n") + "\n", { mode: 0o600 })
  chmodSync(CONFIG_FILE, 0o600)
}

/** Set by launchd: the engine has its own service, so the web server must not start one. */
export const MANAGED = !!process.env.SOTTO_MANAGED

export const PATH = [process.env.PATH, "/opt/homebrew/bin", join(homedir(), ".local/bin")].join(":")
export const FFMPEG = Bun.which("ffmpeg", { PATH })
export const FFPROBE = Bun.which("ffprobe", { PATH })
export const PHONON = Bun.which("phonon", { PATH })
export const CODEX = Bun.which("codex", { PATH })
export const CLAUDE = Bun.which("claude", { PATH })

mkdirSync(MEDIA_DIR, { recursive: true })

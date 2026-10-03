import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CLAUDE, CLEANUP, CODEX, DATA_DIR, PATH, type CleanupProvider, type CleanupSettings } from "./config"

/**
 * A cleaner takes the transcript's lines (one per sentence) and returns exactly as many cleaned
 * lines, so each stays aligned with its timestamps. Every provider gets the same instructions
 * and the same validation; they differ only in where the model runs.
 */
export type Cleaner = (lines: string[], signal: AbortSignal, settings: CleanupSettings) => Promise<string[]>

export const PROMPT = `You clean up speech-to-text transcripts. Do not use tools or read files; just answer.

Input: a JSON array of transcript lines, one per spoken sentence, in order.
Return: {"lines": [...]} with EXACTLY the same number of lines, line i being the cleaned version of input line i.

Clean up lightly:
- Remove filler words and hesitations (um, uh, er, "like"/"you know"/"I mean" when used as filler).
- Remove stutters, accidental word repeats and false starts ("that's that's" -> "that's").
- Fix punctuation, capitalisation and obvious mis-hearings only when certain.
- Keep names, numbers, product names and technical terms exactly as written (e.g. "Phonon2" stays "Phonon2").
Never summarise, reorder, translate, add content or change meaning, tone or slang (keep profanity).
If a line becomes empty after removing filler, return "".`

export const SCHEMA = {
  type: "object",
  properties: { lines: { type: "array", items: { type: "string" } } },
  required: ["lines"],
  additionalProperties: false,
} as const

/** Accepts {"lines": [...]} or a bare array, optionally wrapped in a ```json fence. */
export function parseLines(raw: string, expected: number): string[] {
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error("Clean-up didn't return JSON.")
  }
  const lines = Array.isArray(value) ? value : (value as { lines?: unknown })?.lines
  if (!Array.isArray(lines) || lines.some((l) => typeof l !== "string"))
    throw new Error("Clean-up returned something other than a list of lines.")
  if (lines.length !== expected)
    throw new Error(
      `Clean-up returned ${lines.length} ${lines.length === 1 ? "line" : "lines"} for ${expected}; kept the raw transcript.`,
    )
  return lines as string[]
}

async function run(argv: string[], input: string, signal: AbortSignal, cwd?: string) {
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH },
  })
  const kill = () => proc.kill()
  signal.addEventListener("abort", kill)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => signal.removeEventListener("abort", kill))
  if (signal.aborted) throw new Error("Clean-up took longer than 2 minutes and was stopped.")
  return { stdout, stderr, code }
}

const lastErrorLine = (stderr: string) =>
  stderr.trim().split("\n").filter((l) => !/^\d{4}-\d\d-\d\dT/.test(l)).pop()

// Codex runs in an empty, read-only directory so it has nothing to look at or change.
const codex: Cleaner = async (lines, signal, settings) => {
    const work = join(DATA_DIR, "codex")
    const empty = join(work, "empty")
    const schema = join(work, "schema.json")
    mkdirSync(empty, { recursive: true })
    writeFileSync(schema, JSON.stringify(SCHEMA))
    if (!CODEX) throw new Error("Codex CLI not found. Install it and sign in with `codex login`.")
    const out = join(work, `${crypto.randomUUID()}.json`)
    try {
      const r = await run(
        [
          CODEX, "exec",
          "--ignore-user-config", "--ignore-rules", // skips MCP servers etc.: ~4 s faster
          "--ephemeral", "--skip-git-repo-check", "--color", "never",
          "-s", "read-only", "-C", empty,
          "-m", settings.model, "-c", `model_reasoning_effort="${settings.effort}"`,
          "--output-schema", schema, "-o", out,
          PROMPT,
        ],
        JSON.stringify(lines),
        signal,
      )
      const file = Bun.file(out)
      if (r.code !== 0 || !(await file.exists())) {
        if (/log ?in|auth|unauthori[sz]ed|401/i.test(r.stderr)) throw new Error("Codex isn't signed in. Run `codex login`.")
        throw new Error(lastErrorLine(r.stderr) || `Codex exited with ${r.code}`)
      }
      return parseLines(await file.text(), lines.length)
    } finally {
      await Bun.file(out).unlink().catch(() => {})
    }
}

// Any OpenAI-compatible /chat/completions endpoint, with structured output where supported.
const openai: Cleaner = async (lines, signal, settings) => {
    if (!settings.model) throw new Error("Choose a model for clean-up in Settings.")
    const res = await fetch(`${settings.url}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(settings.apiKey && { authorization: `Bearer ${settings.apiKey}` }),
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: JSON.stringify(lines) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "cleaned", strict: true, schema: SCHEMA } },
      }),
    }).catch((e) => {
      if (signal.aborted) throw new Error("Clean-up took longer than 2 minutes and was stopped.")
      throw new Error(`Couldn't reach ${settings.url}: ${e instanceof Error ? e.message : e}`)
    })
    const body = (await res.json().catch(() => null)) as
      | { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
      | null
    if (!res.ok) throw new Error(body?.error?.message ?? `${settings.url} returned ${res.status}`)
    const content = body?.choices?.[0]?.message?.content
    if (!content) throw new Error("The clean-up model returned an empty reply.")
    return parseLines(content, lines.length)
}

// Claude Code in print mode with your Claude sign-in: no tools, no MCP servers, no saved session,
// run from an empty directory. Structured output enforces the line array.
const claude: Cleaner = async (lines, signal, settings) => {
  if (!CLAUDE) throw new Error("Claude Code not found. Install it and sign in by running `claude` once.")
  const empty = join(DATA_DIR, "claude", "empty")
  mkdirSync(empty, { recursive: true })
  const { stdout, stderr, code } = await run(
    [
      CLAUDE, "-p", PROMPT,
      "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA),
      "--model", settings.model, "--effort", settings.effort,
      "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    ],
    JSON.stringify(lines),
    signal,
    empty,
  )
  let reply: { is_error?: boolean; result?: string; structured_output?: unknown } | null = null
  try {
    reply = JSON.parse(stdout)
  } catch {
    /* not JSON: fall through to the error below */
  }
  if (code !== 0 || !reply || reply.is_error) {
    const detail = reply?.result || lastErrorLine(stderr) || `Claude Code exited with ${code}`
    if (/log ?in|auth|credential|unauthori[sz]ed|401/i.test(detail)) throw new Error("Claude Code isn't signed in. Run `claude` once to sign in.")
    throw new Error(detail)
  }
  return parseLines(JSON.stringify(reply.structured_output ?? reply.result ?? ""), lines.length)
}

const CLEANERS: Record<CleanupProvider, Cleaner> = { claude, codex, openai }

/** Cleans with the given settings (the saved ones by default). Throws if clean-up is off. */
export function clean(lines: string[], signal: AbortSignal, settings: CleanupSettings = CLEANUP) {
  if (!settings.provider) throw new Error("Clean-up is off. Choose a provider in Settings.")
  return CLEANERS[settings.provider](lines, signal, settings)
}

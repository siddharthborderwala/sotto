# Contributing to Sotto

Thanks for helping. Bug reports, fixes and ideas are all welcome. For anything larger than a small fix, please open an issue first so we can agree on the approach.

## Development setup

You need an Apple-silicon Mac with [Homebrew](https://brew.sh). Install Sotto once with `./scripts/install.sh` so the speech engine is running, then run a development copy beside it:

```sh
cd server && bun install && DATA_DIR=/tmp/sotto-dev bun run dev   # API on :8012, restarts on change
cd web && bun install && bun run dev                              # UI on http://localhost:5173
```

The dev UI proxies `/api` to `:8012`. `DATA_DIR` keeps test data out of your real library, and the dev server uses the engine already running on `:8010`.

Before opening a pull request:

```sh
bun run typecheck                 # server and web
cd web && bunx eslint src && bun run build
```

Bun is the only package manager. Please don't add npm, pnpm or yarn lockfiles.

## How it fits together

```
Browser ──▶ (optional Caddy :443) ──▶ Hono on Bun :8011 ──16 kHz PCM──▶ phonon serve :8010
 React UI                              API · SQLite · ffmpeg · queues       Phonon-2 on MLX
```

| launchd service | What |
|---|---|
| `com.sotto.engine` | `phonon serve`: keeps Phonon-2 loaded on the GPU. OpenAI/Whisper-compatible API, plus a live-streaming WebSocket. |
| `com.sotto.web` | `server/`: the API and the built UI. |
| `com.sotto.proxy` | Only with `SOTTO_HOST`: Caddy, as a root daemon (macOS needs root to bind :443 on 127.0.0.1), with its admin API off and a root-owned config copy. |

**What happens when a file is added:**

1. The browser streams the raw file to `POST /api/transcripts`.
2. The server writes it to `media/`, checks with ffprobe that it has audio, and inserts a `queued` row. Recordings from the mic are first remuxed (stream copy) so they're seekable.
3. One job at a time:
   - ffmpeg decodes the file to 16 kHz mono PCM, and the server computes 1,200 waveform peaks.
   - The engine returns word timestamps, which the server regroups into sentences. Those sentences are the segments used for highlighting, seeking and subtitles.
   - If the engine is unavailable, the job waits for it and retries.
4. If clean-up is on, a separate queue (three at a time) sends the sentences to the configured provider. It must return exactly one cleaned line per sentence, stored beside the raw text.
5. Every change is pushed to the browser over SSE. Queued work resumes after a restart, and media files with no matching transcript are removed.

**Live dictation:**

- An AudioWorklet resamples the mic to 16 kHz and streams 50 ms blocks over `/api/live` to the engine's live decoder, which drives the floating bar.
- MediaRecorder captures the file that's saved and transcribed by the normal pipeline. If the live preview fails, recording continues regardless.
- A mic recording with no speech is discarded.

### Code map

```
server/src/
  index.ts      routes, Host/Origin guard, static UI, settings API
  config.ts     settings: environment > config.env > defaults; saving clean-up settings
  db.ts         SQLite schema (versioned migrations), queries, FTS5 search
  engine.ts     ffmpeg decode and remux, peaks, engine client, sentence segmentation
  jobs.ts       transcription queue, engine-down retry, restart recovery, orphan sweep
  cleanup.ts    clean-up queue
  cleaners.ts   clean-up providers (claude, codex, openai-compatible) and the shared prompt
  bundle.ts     multi-file downloads as a streamed zip
  export.ts     txt / md / srt / vtt
  events.ts     server-sent events bus
  types.ts      types shared with the web app
web/src/
  App.tsx                         layout, routing (/t/<slug>-<id>), selection, drag and drop, shortcuts
  components/rail.tsx             sidebar: search, list, context menus, footer
  components/transcript-view.tsx  a transcript: title, actions, player, Clean/Raw
  components/transcript-body.tsx  sentences and paragraphs, active sentence, search highlights
  components/tape.tsx             canvas waveform and scrubber
  components/mic-bar.tsx          dictation bar
  components/settings-dialog.tsx  settings
  audio/recorder.ts               mic capture, live stream, saved recording
  hooks/use-mic-mode.ts           the M-key state machine
  components/ui/                  shadcn/ui (Base UI) components
public/pcm-tap.worklet.js         AudioWorklet: low-pass and resample to 16 kHz
scripts/                          install, update, uninstall
```

The UI uses shadcn/ui on Base UI with the theme preset `b3roOBDZbs` (`bunx --bun shadcn@latest apply --preset b3roOBDZbs --only theme`). The design is flat (radius 0), with lime as the accent. Add components with `bunx --bun shadcn@latest add <name>`.

## API

Everything is under `/api` on `:8011`. Requests must be addressed to a local name and come from Sotto's own pages (see [SECURITY.md](SECURITY.md)).

| Route | |
|---|---|
| `POST /transcripts` | Raw file body with `x-filename` (URL-encoded) and `content-type`; `x-recorded: 1` for mic recordings. Returns the queued transcript. |
| `GET /transcripts?q=&before=&limit=` | Newest first, paged by `before` (a `createdAt`). With `q`: full-text search, title matches first, with snippets. |
| `GET /transcripts/:id` | A transcript with its `segments` and `cleanLines`. |
| `PATCH /transcripts/:id` | `{ "title": "…" }` |
| `DELETE /transcripts/:id` | Removes the transcript and its recording. |
| `POST /transcripts/:id/retry` | Transcribe again (409 while queued or running). |
| `POST /transcripts/:id/cleanup` | Clean up again (409 while running or when clean-up is off). |
| `GET /transcripts/:id/media` | The original recording, with Range support. |
| `GET /transcripts/:id/peaks` | 1,200 little-endian float32 waveform peaks (204 before transcription). |
| `GET /transcripts/:id/export/{txt,md,srt,vtt}?text=clean\|raw` | A download. |
| `GET /bundle?ids=a,b&kind={txt,md,srt,vtt,original}&text=` | Several at once: one file as-is, more as a streamed zip. |
| `GET /events` | Server-sent events: `upsert`, `delete`. |
| `GET /live` | WebSocket to the engine's live decoder: send `{"sample_rate":16000,"format":"pcm_f32le"}`, 50 ms float32 blocks, then `{"type":"end"}`; receive `partial`, `final`, `done` and `error`. One stream at a time. |
| `GET /settings`, `PUT /settings/cleanup`, `POST /settings/cleanup/test` | Settings (the API key is never returned). |
| `GET /health` | `{ engine, queue, cleanup }` |

## Pull requests

- Keep each pull request focused, and describe what changed and how you tested it.
- Match the surrounding style. The code favours small modules, comments that explain *why*, and no new dependencies without a good reason.
- UI changes: include a screenshot in light and dark, and check a narrow window.
- By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

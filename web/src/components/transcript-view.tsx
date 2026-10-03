import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  AudioLinesIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  PauseIcon,
  PlayIcon,
  LoaderIcon,
  RotateCwIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react"
import { api, type Transcript, type TranscriptSummary } from "@/lib/api"
import { bytes, clock, length, seconds, when } from "@/lib/format"
import { usePlayer, type PlayerControls } from "@/hooks/use-player"
import { useCleanupEnabled } from "@/lib/cleanup-context"
import * as prefs from "@/lib/prefs"
import { setTextVersion, useTextVersion } from "@/lib/text-version"
import { cached, load } from "@/lib/transcript-cache"
import { Tape } from "@/components/tape"
import {
  TranscriptBody,
  activeIndex,
  type Layout,
} from "@/components/transcript-body"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const RATES = [1, 1.25, 1.5, 2]

export function TranscriptView({
  id,
  version,
  query,
  onRequestDelete,
  registerPlayer,
}: {
  id: string
  /** Bumped by SSE whenever this transcript changes server-side. */
  version: number
  query: string
  onRequestDelete: (targets: TranscriptSummary[]) => void
  registerPlayer: (p: PlayerControls | null) => void
}) {
  // The parent shows this view only once `load` has resolved, so it normally starts filled.
  const initial = cached(id, version)
  const [t, setT] = useState<Transcript | null>(initial?.t ?? null)
  const [peaks, setPeaks] = useState<Float32Array | null>(
    initial?.peaks ?? null
  )
  const [missing, setMissing] = useState(false)
  const [reveal, setReveal] = useState(false)
  const layout = prefs.layout.use()
  const lastStatus = useRef<string | null>(initial?.t.status ?? null)
  const { attach, time, playing, rate, seek, toggle, pause, skip, setRate } =
    usePlayer()

  // Refresh when the server reports a change (e.g. queued → processing → done).
  useEffect(() => {
    let live = true
    load(id, version).then(
      (next) => {
        if (!live) return
        // Animate only when it finishes while you're looking at it.
        setReveal(
          lastStatus.current !== null &&
            lastStatus.current !== "done" &&
            next.t.status === "done"
        )
        lastStatus.current = next.t.status
        setT(next.t)
        setPeaks(next.peaks)
        setMissing(false)
      },
      () => live && setMissing(true)
    )
    return () => {
      live = false
    }
  }, [id, version])

  // Clean lines replace the raw text when the preference says so; filler-only lines drop out.
  const textVersion = useTextVersion()
  const cleanupEnabled = useCleanupEnabled()
  const hasClean = !!t?.cleanLines && t.cleanLines.length === t.segments.length
  const showClean = hasClean && textVersion === "clean"
  const segments = useMemo(() => {
    if (!t) return []
    if (!showClean) return t.segments
    return t.segments
      .map((s, i) => ({ ...s, text: t.cleanLines![i].trim() }))
      .filter((s) => s.text)
  }, [t, showClean])
  // Stable, so the memoised transcript blocks don't re-render on every playback frame.
  const seekAndPlay = useCallback((s: number) => seek(s, true), [seek])

  const copy = () => {
    const text = segments.map((s) => s.text).join(" ")
    if (!text) return
    void navigator.clipboard.writeText(text).then(() => toast("Copied"))
  }

  useEffect(() => {
    registerPlayer(t?.status === "done" ? { toggle, pause, skip, copy } : null)
    return () => registerPlayer(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, segments, toggle, pause, skip])

  if (missing)
    return (
      <p className="px-8 py-16 text-muted-foreground">
        There’s no transcript at this address. It may have been deleted.
      </p>
    )
  if (!t) return <ViewSkeleton />

  const done = t.status === "done"
  const duration = t.durationS ?? 0
  const active = done && time > 0 ? activeIndex(segments, time) : -1
  const cleaning = t.cleanStatus === "queued" || t.cleanStatus === "running"

  const rename = async (title: string) => {
    if (!title.trim() || title === t.title) return
    try {
      setT({ ...t, title: (await api.rename(t.id, title)).title })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const cleanUp = async () => {
    try {
      await api.cleanup(t.id)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const retry = async () => {
    try {
      await api.retry(t.id)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <article className="mx-auto w-full max-w-[52rem] px-4 pb-32 sm:px-8">
      <header className="pt-8 sm:pt-12">
        <div className="flex items-start gap-3">
          <Title key={t.id + t.title} value={t.title} onCommit={rename} />
          <div className="flex shrink-0 items-center gap-1 pt-1">
            {done && (
              <>
                <Button variant="ghost" size="sm" onClick={copy}>
                  <CopyIcon data-icon="inline-start" />
                  <span className="max-sm:sr-only">Copy text</span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="sm" />}
                  >
                    <DownloadIcon data-icon="inline-start" />
                    <span className="max-sm:sr-only">Export</span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    {(
                      [
                        ["txt", "Plain text"],
                        ["md", "Markdown"],
                        ["srt", "Subtitles (SRT)"],
                        ["vtt", "Subtitles (WebVTT)"],
                      ] as const
                    ).map(([f, label]) => (
                      <DropdownMenuItem
                        key={f}
                        render={<a href={api.exportUrl(t.id, f)} download />}
                      >
                        {label}
                        <span className="ml-auto text-xs text-muted-foreground">
                          .{f}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="More actions"
                  />
                }
              >
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem
                  render={
                    <a href={api.mediaUrl(t.id)} download={t.originalName} />
                  }
                >
                  <AudioLinesIcon />
                  Download original
                  <span className="ml-auto text-xs text-muted-foreground">
                    {bytes(t.sizeBytes)}
                  </span>
                </DropdownMenuItem>
                {done && (
                  <DropdownMenuItem onClick={retry}>
                    <RotateCwIcon />
                    Transcribe again
                  </DropdownMenuItem>
                )}
                {done && cleanupEnabled && (
                  <DropdownMenuItem
                    disabled={cleaning}
                    onClick={() => void cleanUp()}
                  >
                    <SparklesIcon />
                    {hasClean || t.cleanStatus === "error"
                      ? "Clean up again"
                      : "Clean up"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onRequestDelete([t])}
                >
                  <Trash2Icon />
                  Delete transcript
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {when(t.createdAt)}
          {done && (
            <>
              {" · "}
              {length(duration)}
              {t.transcribeMs != null && (
                <>
                  {" "}
                  transcribed in {seconds((t.convertMs ?? 0) + t.transcribeMs)}
                </>
              )}
            </>
          )}
          {cleaning && (
            <span className="ml-2 inline-flex items-center gap-1 text-foreground/70">
              <LoaderIcon className="size-3 animate-spin motion-reduce:animate-none" />
              Cleaning up
            </span>
          )}
          {t.cleanStatus === "error" && (
            <span className="ml-2 text-destructive" title={t.cleanError ?? ""}>
              Clean-up failed.{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => void cleanUp()}
              >
                Try again
              </button>
            </span>
          )}
        </p>
      </header>

      {t.status === "error" && (
        <div className="mt-10 max-w-xl">
          <p className="font-medium">Couldn't transcribe this file.</p>
          <p className="mt-1 text-sm text-muted-foreground">{t.error}</p>
          <div className="mt-4 flex gap-2">
            <Button onClick={retry}>
              <RotateCwIcon data-icon="inline-start" />
              Try again
            </Button>
            <Button variant="ghost" onClick={() => onRequestDelete([t])}>
              Delete transcript
            </Button>
          </div>
        </div>
      )}

      {(t.status === "queued" || t.status === "processing") && (
        <Pending status={t.status} />
      )}

      {done && (
        <>
          {t.isVideo && (
            <video
              ref={attach}
              src={api.mediaUrl(t.id)}
              preload="metadata"
              playsInline
              onClick={toggle}
              className="mt-8 max-h-80 w-full rounded-xl bg-muted object-contain"
            />
          )}
          {!t.isVideo && (
            <audio ref={attach} src={api.mediaUrl(t.id)} preload="metadata" />
          )}

          <div className="sticky top-0 z-10 -mx-4 mt-6 bg-background/85 px-4 pt-3 pb-2 backdrop-blur-md sm:-mx-8 sm:px-8">
            <div className="flex items-center gap-3">
              <Button
                size="icon-lg"
                onClick={toggle}
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? (
                  <PauseIcon className="fill-current" />
                ) : (
                  <PlayIcon className="translate-x-px fill-current" />
                )}
              </Button>
              <Tape
                key={t.id}
                peaks={peaks}
                duration={duration}
                time={time}
                onSeek={seek}
                reveal={reveal}
              />
            </div>
            <div className="mt-1 flex items-center justify-between pl-12 text-xs text-muted-foreground tabular-nums">
              <span>
                {clock(time)}{" "}
                <span className="opacity-60">/ {clock(duration)}</span>
              </span>
              <div className="flex items-center gap-2">
                {hasClean && (
                  <ToggleGroup
                    size="sm"
                    spacing={0}
                    value={[textVersion]}
                    onValueChange={(v: string[]) =>
                      v[0] && setTextVersion(v[0] as "clean" | "raw")
                    }
                    aria-label="Text version"
                  >
                    <ToggleGroupItem value="clean" className="h-6 px-2 text-xs">
                      Clean
                    </ToggleGroupItem>
                    <ToggleGroupItem value="raw" className="h-6 px-2 text-xs">
                      Raw
                    </ToggleGroupItem>
                  </ToggleGroup>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  className="w-12 text-muted-foreground tabular-nums"
                  aria-label={`Playback speed ${rate}×, click to change`}
                  title="Playback speed"
                  onClick={() =>
                    setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length])
                  }
                >
                  {rate}×
                </Button>
                <ToggleGroup
                  size="sm"
                  spacing={0}
                  value={[layout]}
                  onValueChange={(v: string[]) =>
                    v[0] && prefs.layout.set(v[0] as Layout)
                  }
                >
                  <ToggleGroupItem value="lines" className="h-6 px-2 text-xs">
                    Lines
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="paragraphs"
                    className="h-6 px-2 text-xs"
                  >
                    Paragraphs
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>
          </div>

          <div
            className={
              reveal
                ? "mt-8 animate-in delay-200 duration-500 fill-mode-both fade-in motion-reduce:animate-none"
                : "mt-8"
            }
          >
            {segments.length ? (
              <div className="-ml-4 sm:-ml-[5rem]">
                <TranscriptBody
                  segments={segments}
                  layout={layout}
                  active={active}
                  playing={playing}
                  query={query}
                  onSeek={seekAndPlay}
                />
              </div>
            ) : (
              <p className="text-muted-foreground">
                No speech found in this recording.
              </p>
            )}
          </div>
        </>
      )}
    </article>
  )
}

function Title({
  value,
  onCommit,
}: {
  value: string
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  return (
    <input
      aria-label="Title"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (draft.trim() ? onCommit(draft.trim()) : setDraft(value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
        if (e.key === "Escape") {
          setDraft(value)
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
        }
      }}
      className="-mx-2 min-w-0 flex-1 truncate rounded-lg bg-transparent px-2 py-0.5 font-heading text-2xl font-semibold tracking-tight outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-[1.75rem]"
    />
  )
}

function Pending({ status }: { status: "queued" | "processing" }) {
  return (
    <div className="mt-8" aria-live="polite">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9" />
        <div className="relative h-14 flex-1 overflow-hidden rounded-md">
          <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
          {status === "processing" && (
            <div className="indeterminate absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
          )}
        </div>
      </div>
      <p className="mt-6 text-sm text-muted-foreground">
        {status === "processing"
          ? "Transcribing…"
          : "Waiting for the file ahead of this one…"}
      </p>
      <div className="mt-6 space-y-3">
        {[92, 100, 84, 96, 60].map((w, i) => (
          <Skeleton key={i} className="h-4" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  )
}

function ViewSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[52rem] px-4 pt-12 sm:px-8">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="mt-3 h-4 w-48" />
      <Skeleton className="mt-8 h-14 w-full" />
    </div>
  )
}

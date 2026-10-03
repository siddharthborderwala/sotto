import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react"
import { toast } from "sonner"
import { LoaderIcon, MenuIcon, MicIcon, PlusIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { api, type Health, type TranscriptSummary } from "@/lib/api"
import { useTranscripts } from "@/hooks/use-transcripts"
import { useMicMode } from "@/hooks/use-mic-mode"
import type { PlayerControls } from "@/hooks/use-player"
import { MicBar } from "@/components/mic-bar"
import { SettingsDialog } from "@/components/settings-dialog"
import { CleanupEnabled } from "@/lib/cleanup-context"
import * as actions from "@/lib/actions"
import { load } from "@/lib/transcript-cache"
import { idFromLocation, transcriptPath } from "@/lib/route"
import { Logo } from "@/components/logo"
import { Rail } from "@/components/rail"
import { TranscriptView } from "@/components/transcript-view"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Toaster } from "@/components/ui/sonner"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"

const ACCEPT =
  "audio/*,video/*,.m4a,.mp3,.wav,.flac,.ogg,.opus,.aiff,.aac,.wma,.mp4,.mov,.mkv,.webm"

const MEDIA_EXT =
  /\.(m4a|mp3|wav|flac|ogg|oga|opus|aiff?|aac|wma|caf|amr|mp4|m4v|mov|mkv|webm|avi|3gp)$/i

/** Audio or video, judged by MIME type, falling back to the extension (browsers leave some types blank). */
function isMedia(f: { type: string; name?: string }) {
  if (/^(audio|video)\//.test(f.type)) return true
  return !f.type && (f.name === undefined || MEDIA_EXT.test(f.name))
}

type Drag = { accepted: number; rejected: number }

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  return (
    !!el &&
    (el.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
  )
}

/** Shortcuts stand down while typing or while a menu or dialog has the keyboard. */
function shortcutsBlocked(e: KeyboardEvent) {
  return (
    isTyping(e) ||
    !!document.querySelector(
      '[role="menu"][data-open], [role="dialog"][data-open], [role="alertdialog"][data-open]'
    )
  )
}

const hasFiles = (e: DragEvent) =>
  e.dataTransfer?.types.includes("Files") ?? false

export default function App() {
  const { items, version, hasMore, loadMore } = useTranscripts({
    onDeleted: (id, reason) => {
      if (reason === "no-speech")
        toast("Nothing heard", {
          description: "The recording had no speech, so it wasn't saved.",
        })
      // Deleted elsewhere (or discarded) while open: go home rather than show a ghost.
      if (id === selectedRef.current) selectRef.current(null)
    },
  })
  const [chosen, setSelected] = useState<string | null>(idFromLocation)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<TranscriptSummary[] | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [healthTick, setHealthTick] = useState(0)
  // "/" is the drop screen, even when there are transcripts.
  const selected = chosen
  const selectedRef = useRef(selected)
  useEffect(() => {
    selectedRef.current = selected
  })
  // What the main pane shows. It lags `selected` until that transcript has loaded,
  // so switching swaps content in one frame instead of flashing a placeholder.
  const [shown, setShown] = useState<string | null>(null)
  const latest = useRef(selected)
  // Rows picked with ⌘/Shift-click or ⌘A; null means "just the open transcript".
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const anchor = useRef<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<
    TranscriptSummary[] | null
  >(null)
  const visible = useMemo(
    () => (query.trim() ? results : items) ?? [],
    [query, results, items]
  )
  // Only rows you can see count, so search never leaves hidden transcripts selected.
  const selection = useMemo(
    () =>
      visible.filter((t) => (picked ? picked.has(t.id) : t.id === selected)),
    [visible, picked, selected]
  )
  const picker = useRef<HTMLInputElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const player = useRef<PlayerControls | null>(null)

  const titleOf = useCallback(
    (id: string) =>
      (items?.find((t) => t.id === id) ?? results?.find((t) => t.id === id))
        ?.title,
    [items, results]
  )

  /** `push` adds a history entry (user navigation); otherwise the URL is replaced. */
  const select = useCallback(
    (id: string | null, { push = false } = {}) => {
      setSelected(id)
      if (!id) setShown(null)
      setPicked(null)
      anchor.current = id
      setSheetOpen(false)
      const path = id ? transcriptPath(id, titleOf(id)) : "/"
      if (path !== location.pathname)
        history[push ? "pushState" : "replaceState"](null, "", path)
    },
    [titleOf]
  )
  const selectRef = useRef(select)
  useEffect(() => {
    selectRef.current = select
  })

  // Back/forward.
  useEffect(() => {
    const onPop = () => {
      const id = idFromLocation()
      setSelected(id)
      if (!id) setShown(null)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  useEffect(() => {
    latest.current = selected
    if (!selected) return
    const show = () => latest.current === selected && setShown(selected)
    load(selected, version[selected] ?? 0).then(show, show)
  }, [selected, version])

  // Keep the slug in step with the title (renames, links without a slug).
  useEffect(() => {
    if (!selected) return
    const title = titleOf(selected)
    const path = transcriptPath(selected, title)
    if (title && location.pathname !== path)
      history.replaceState(null, "", path)
  }, [selected, titleOf])

  // Search (debounced); re-runs when the list changes so results stay fresh.
  useEffect(() => {
    const q = query.trim()
    if (!q) return // results are ignored while the query is empty
    const handle = setTimeout(() => void api.list({ q }).then(setResults), 120)
    return () => clearTimeout(handle)
  }, [query, items])

  // Health doubles as the queue counter in the rail footer.
  useEffect(() => {
    let live = true
    const poll = () =>
      api.health().then(
        (h) => live && setHealth(h),
        () => live && setHealth({ engine: false, queue: 0, cleanup: null })
      )
    void poll()
    const handle = setInterval(poll, 5000)
    return () => {
      live = false
      clearInterval(handle)
    }
  }, [items, healthTick])

  const upload = useCallback(
    async (files: FileList | File[], { recorded = false } = {}) => {
      const all = [...files]
      const list = all.filter((f) => isMedia(f))
      const skipped = all.filter((f) => !isMedia(f))
      if (skipped.length)
        toast.error(
          skipped.length === 1
            ? `Skipped ${skipped[0].name}`
            : `Skipped ${skipped.length} files`,
          {
            description: "Only audio and video files can be transcribed.",
          }
        )
      if (!list.length) return
      let first = true
      for (const file of list) {
        try {
          const t = await api.upload(file, { recorded })
          if (first) select(t.id, { push: true })
          first = false
        } catch (e) {
          toast.error(`Couldn't add ${file.name}`, {
            description: (e as Error).message,
          })
        }
      }
    },
    [select]
  )

  const mic = useMicMode({
    blocked: shortcutsBlocked,
    // Don't record the speakers: pause anything that's playing.
    onStart: useCallback(() => player.current?.pause(), []),
    onRecorded: useCallback(
      (file: File) => upload([file], { recorded: true }),
      [upload]
    ),
  })

  // Window-wide drag and drop, and ⌘V with files on the clipboard.
  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      // Names aren't readable until drop, but MIME types are.
      const items = [...(e.dataTransfer?.items ?? [])].filter(
        (i) => i.kind === "file"
      )
      const accepted = items.filter((i) => isMedia({ type: i.type })).length
      setDrag({ accepted, rejected: items.length - accepted })
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const items = [...(e.dataTransfer?.items ?? [])].filter(
        (i) => i.kind === "file"
      )
      if (e.dataTransfer)
        e.dataTransfer.dropEffect = items.some((i) => isMedia({ type: i.type }))
          ? "copy"
          : "none"
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      if (--depth <= 0) {
        depth = 0
        setDrag(null)
      }
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDrag(null)
      void upload(e.dataTransfer!.files)
    }
    const paste = (e: ClipboardEvent) => {
      if (
        e.clipboardData?.files.length &&
        !isTyping(e as unknown as KeyboardEvent)
      )
        void upload(e.clipboardData.files)
    }
    window.addEventListener("dragenter", enter)
    window.addEventListener("dragover", over)
    window.addEventListener("dragleave", leave)
    window.addEventListener("drop", drop)
    window.addEventListener("paste", paste)
    return () => {
      window.removeEventListener("dragenter", enter)
      window.removeEventListener("dragover", over)
      window.removeEventListener("dragleave", leave)
      window.removeEventListener("drop", drop)
      window.removeEventListener("paste", paste)
    }
  }, [upload])

  // Keyboard: / search, j/k or Shift+→/← move, space play, ←/→ skip, ⌘C copies everything when nothing is selected.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Menus and dialogs handle their own keys (Esc closes them, not the selection).
      if (shortcutsBlocked(e) || e.altKey || e.ctrlKey) return
      const list = visible
      if ((e.metaKey && e.key === "c") || e.key === "C") {
        if (e.metaKey && !window.getSelection()?.toString()) {
          if (selection.length > 1) {
            e.preventDefault()
            actions.copy(selection)
          } else if (player.current) {
            e.preventDefault()
            player.current.copy()
          }
        }
        return
      }
      if (e.metaKey && e.key === ",") {
        e.preventDefault()
        setSettingsOpen(true)
        return
      }
      if (e.metaKey && e.key === "a" && list.length) {
        e.preventDefault()
        setPicked(new Set(list.map((t) => t.id)))
        return
      }
      if (e.metaKey && e.key === "Backspace" && selection.length) {
        e.preventDefault()
        setPendingDelete(selection)
        return
      }
      if (e.metaKey) return
      if (e.key === "Escape" && picked) {
        setPicked(null)
        return
      }
      if (e.key === "/") {
        e.preventDefault()
        search.current?.focus()
      } else if (
        (e.key === "j" ||
          e.key === "k" ||
          (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft"))) &&
        list?.length
      ) {
        // j / Shift+→ = next (down the list), k / Shift+← = previous.
        e.preventDefault()
        const step = e.key === "j" || e.key === "ArrowRight" ? 1 : -1
        const i = list.findIndex((t) => t.id === selected)
        const next = list[Math.max(0, Math.min(list.length - 1, i + step))]
        select(next.id)
        document
          .querySelector(`[data-id="${next.id}"]`)
          ?.scrollIntoView({ block: "nearest" })
      } else if (
        e.key === " " &&
        player.current &&
        !(e.target instanceof HTMLButtonElement)
      ) {
        e.preventDefault()
        player.current.toggle()
      } else if (
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        player.current
      ) {
        e.preventDefault()
        player.current.skip(e.key === "ArrowLeft" ? -5 : 5)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [visible, selection, picked, selected, select])

  const onRowClick = useCallback(
    (id: string, e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey) {
        // Toggle without changing what's open.
        const next = new Set(selection.map((t) => t.id))
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setPicked(next)
        anchor.current = id
      } else if (e.shiftKey) {
        const ids = visible.map((t) => t.id)
        const from = ids.indexOf(anchor.current ?? selected ?? id)
        const to = ids.indexOf(id)
        // Adds the range to the selection, as in Finder.
        const next = new Set(selection.map((t) => t.id))
        if (from === -1) next.add(id)
        else
          ids
            .slice(Math.min(from, to), Math.max(from, to) + 1)
            .forEach((x) => next.add(x))
        setPicked(next)
      } else select(id, { push: true })
    },
    [selection, visible, selected, select]
  )

  const onRowContext = useCallback(
    (id: string) => {
      if (selection.some((t) => t.id === id)) return
      setPicked(new Set([id]))
      anchor.current = id
    },
    [selection]
  )

  const confirmDelete = useCallback(
    async (targets: TranscriptSummary[]) => {
      const gone = new Set(targets.map((t) => t.id))
      // If the open transcript goes, open the nearest survivor (below first, then above).
      if (selected && gone.has(selected)) {
        const list = items ?? []
        const i = list.findIndex((t) => t.id === selected)
        const next =
          list.slice(i + 1).find((t) => !gone.has(t.id)) ??
          list
            .slice(0, Math.max(0, i))
            .reverse()
            .find((t) => !gone.has(t.id))
        select(next?.id ?? null)
      }
      setPicked(null)
      await actions.remove(targets)
      setPendingDelete(null)
    },
    [selected, items, select]
  )

  const registerPlayer = useCallback((p: typeof player.current) => {
    player.current = p
  }, [])

  const rail = (
    <Rail
      ref={search}
      items={items}
      hasMore={hasMore}
      onLoadMore={loadMore}
      results={results}
      query={query}
      onQuery={setQuery}
      open={selected}
      selection={selection}
      onRowClick={onRowClick}
      onRowContext={onRowContext}
      onClearSelection={() => setPicked(null)}
      onDelete={setPendingDelete}
      onHome={() => select(null, { push: true })}
      onMic={mic.toggleHandsfree}
      onSettings={() => setSettingsOpen(true)}
      recording={!!mic.phase}
      onAdd={() => picker.current?.click()}
      health={health}
    />
  )

  const empty = items !== null && items.length === 0

  return (
    <CleanupEnabled.Provider value={!!health?.cleanup}>
      <TooltipProvider>
        <div className="flex h-svh">
          <aside className="hidden w-72 shrink-0 border-r border-sidebar-border min-[900px]:block">
            {rail}
          </aside>

          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent
              side="left"
              className="w-80 max-w-[85vw] gap-0 p-0"
              showCloseButton={false}
            >
              <SheetTitle className="sr-only">Transcripts</SheetTitle>
              {rail}
            </SheetContent>
          </Sheet>

          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-2 min-[900px]:hidden">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSheetOpen(true)}
                aria-label="Show transcripts"
              >
                <MenuIcon />
              </Button>
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault()
                  select(null, { push: true })
                }}
                className="flex items-center gap-2 font-heading text-sm font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Logo className="size-4.5" />
                Sotto
              </a>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                onClick={() => picker.current?.click()}
                aria-label="Add files"
              >
                <PlusIcon />
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {!selected || empty ? (
                <EmptyState
                  onChoose={() => picker.current?.click()}
                  onRecord={mic.toggleHandsfree}
                />
              ) : shown ? (
                <TranscriptView
                  key={shown}
                  id={shown}
                  version={version[shown] ?? 0}
                  query={query}
                  onRequestDelete={setPendingDelete}
                  registerPlayer={registerPlayer}
                />
              ) : null}
            </div>
          </main>
        </div>

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          health={health}
          onSaved={() => setHealthTick((n) => n + 1)}
        />

        <DeleteDialog
          targets={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />

        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files) void upload(e.target.files)
            e.target.value = ""
          }}
        />

        {drag && <DropOverlay drag={drag} />}
        <MicBar
          phase={mic.phase}
          text={mic.text}
          live={mic.live}
          startedAt={mic.startedAt}
          levels={mic.levels}
          onStop={mic.stop}
          onDiscard={mic.discard}
        />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </CleanupEnabled.Provider>
  )
}

/**
 * Confirms a delete. Keeps showing the last targets while it animates closed (so the text
 * never reads "undefined"), and stays open with a spinner until the delete has finished.
 */
function DeleteDialog({
  targets,
  onCancel,
  onConfirm,
}: {
  targets: TranscriptSummary[] | null
  onCancel: () => void
  onConfirm: (targets: TranscriptSummary[]) => Promise<void>
}) {
  const [shown, setShown] = useState(targets)
  if (targets && targets !== shown) setShown(targets)
  const [deleting, setDeleting] = useState(false)
  // Only show the spinner if deleting takes long enough to notice; fast deletes don't flash it.
  const [slow, setSlow] = useState(false)
  const t = targets ?? shown ?? []
  const one = t.length === 1

  const confirm = async () => {
    setDeleting(true)
    const timer = setTimeout(() => setSlow(true), 150)
    try {
      await onConfirm(t)
    } finally {
      clearTimeout(timer)
      setDeleting(false)
      setSlow(false)
    }
  }

  return (
    <Dialog
      open={targets !== null}
      onOpenChange={(open) => !open && !deleting && onCancel()}
    >
      <DialogContent showCloseButton={false}>
        <DialogTitle>
          {one ? `Delete “${t[0]?.title}”?` : `Delete ${t.length} transcripts?`}
        </DialogTitle>
        <DialogDescription>
          {!one && (
            <span className="mb-2 block text-foreground">
              {t
                .slice(0, 4)
                .map((x) => x.title)
                .join(", ")}
              {t.length > 4 && ` and ${t.length - 4} more`}
            </span>
          )}
          {one
            ? "The transcript and its original file are removed from this Mac. This can't be undone."
            : "The transcripts and their original files are removed from this Mac. This can't be undone."}
        </DialogDescription>
        <DialogFooter className="py-2.5">
          <DialogClose render={<Button variant="ghost" disabled={deleting} />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            className="relative"
            disabled={deleting}
            aria-busy={deleting}
            onClick={() => void confirm()}
          >
            {/* The label stays (invisible) while deleting, so the button keeps its width. */}
            <span className={cn(slow && "invisible")}>
              {one ? "Delete transcript" : `Delete ${t.length} transcripts`}
            </span>
            {slow && (
              <span className="absolute inset-0 flex items-center justify-center">
                <LoaderIcon className="animate-spin motion-reduce:animate-none" />
                <span className="sr-only">Deleting</span>
              </span>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EmptyState({
  onChoose,
  onRecord,
}: {
  onChoose: () => void
  onRecord: () => void
}) {
  return (
    <div className="flex h-full items-center px-6 sm:px-16">
      <div className="max-w-md">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Drop a recording to transcribe it
        </h1>
        <p className="mt-3 text-muted-foreground">
          Audio or video, any format. Phonon-2 transcribes it right here on this
          Mac.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button size="lg" onClick={onChoose}>
            Choose files
          </Button>
          <Button size="lg" variant="outline" onClick={onRecord}>
            <MicIcon data-icon="inline-start" />
            Record
          </Button>
        </div>
        <ul className="mt-10 space-y-1.5 text-sm text-muted-foreground">
          {(
            [
              ["Hold", "M", "to dictate"],
              ["Double-tap", "M", "to dictate hands-free"],
              ["Press", "⌘V", "to paste files"],
            ] as const
          ).map(([gesture, key, result]) => (
            <li key={gesture} className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="size-1 shrink-0 bg-muted-foreground/60"
              />
              <span>
                {gesture}{" "}
                <kbd className="border px-1 font-sans text-xs">{key}</kbd>{" "}
                {result}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function DropOverlay({ drag: { accepted, rejected } }: { drag: Drag }) {
  const none = accepted === 0
  return (
    <div className="pointer-events-none fixed inset-0 z-50 animate-in bg-background/70 backdrop-blur-sm duration-100 fade-in motion-reduce:animate-none">
      <div
        className={cn(
          "absolute inset-3 flex flex-col items-center justify-center gap-2 border-2 border-dashed px-6 text-center sm:inset-4",
          none ? "border-destructive" : "border-primary"
        )}
      >
        <p className="font-heading text-2xl font-semibold tracking-tight">
          {none
            ? "Only audio and video files can be transcribed"
            : accepted > 1
              ? `Drop ${accepted} files to transcribe them`
              : "Drop to transcribe"}
        </p>
        {!none && rejected > 0 && (
          <p className="text-sm text-muted-foreground">
            {rejected === 1
              ? "1 file isn't audio or video and will be skipped."
              : `${rejected} files aren't audio or video and will be skipped.`}
          </p>
        )}
      </div>
    </div>
  )
}

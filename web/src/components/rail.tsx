import { forwardRef, useEffect, useMemo, useRef, type MouseEvent } from "react"
import {
  MicIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react"
import type { Health, TranscriptSummary } from "@/lib/api"
import { dayLabel, length } from "@/lib/format"
import { cn } from "@/lib/utils"
import { highlight, termsRegex } from "@/lib/highlight"
import { ActionsMenuItems } from "@/components/actions-menu"
import { Logo } from "@/components/logo"
import { useTheme } from "@/components/theme-provider"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type Props = {
  items: TranscriptSummary[] | null
  /** More (older) transcripts exist beyond the loaded ones. */
  hasMore: boolean
  onLoadMore: () => void
  results: TranscriptSummary[] | null
  query: string
  onQuery: (q: string) => void
  /** The transcript open in the main pane. */
  open: string | null
  /** Selected rows, in list order (always includes something when a transcript is open). */
  selection: TranscriptSummary[]
  onRowClick: (id: string, e: MouseEvent) => void
  /** Right-click on a row that isn't selected makes it the selection. */
  onRowContext: (id: string) => void
  onClearSelection: () => void
  onDelete: (targets: TranscriptSummary[]) => void
  onHome: () => void
  onMic: () => void
  onSettings: () => void
  recording: boolean
  onAdd: () => void
  health: Health | null
}

export const Rail = forwardRef<HTMLInputElement, Props>(function Rail(
  {
    items,
    hasMore,
    onLoadMore,
    results,
    query,
    onQuery,
    open,
    selection,
    onRowClick,
    onRowContext,
    onClearSelection,
    onDelete,
    onHome,
    onMic,
    onSettings,
    recording,
    onAdd,
    health,
  },
  searchRef
) {
  const searching = query.trim().length > 0
  const terms = useMemo(
    () => (searching ? termsRegex(query) : null),
    [query, searching]
  )
  const list = searching ? results : items
  const selectedIds = useMemo(
    () => new Set(selection.map((t) => t.id)),
    [selection]
  )
  const row = (t: TranscriptSummary, rowTerms: RegExp | null = null) => (
    <Row
      key={t.id}
      t={t}
      terms={rowTerms}
      open={open === t.id}
      selected={selectedIds.has(t.id)}
      // Right-clicking inside the selection acts on all of it; elsewhere, on that row only.
      targets={selectedIds.has(t.id) ? selection : [t]}
      onClick={onRowClick}
      onContext={onRowContext}
      onDelete={onDelete}
    />
  )

  const groups = useMemo(() => {
    if (!list || searching) return null
    const out: { label: string; items: TranscriptSummary[] }[] = []
    for (const t of list) {
      const label = dayLabel(t.createdAt)
      if (out.at(-1)?.label !== label) out.push({ label, items: [] })
      out.at(-1)!.items.push(t)
    }
    return out
  }, [list, searching])

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault()
            onHome()
          }}
          className="flex items-center gap-2 font-heading text-[0.95rem] font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Logo />
          Sotto
        </a>
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onMic}
                  aria-label={recording ? "Stop recording" : "Record"}
                  aria-pressed={recording}
                  className={cn(
                    recording &&
                      "bg-primary text-primary-foreground hover:bg-primary/85"
                  )}
                />
              }
            >
              <MicIcon />
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {recording
                ? "Stop recording"
                : "Record. Or hold M; double-tap for hands-free."}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onAdd}
                  aria-label="Add files"
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipContent side="bottom">Add files</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-muted-foreground">
            <SearchIcon className="size-3.5" />
          </span>
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onQuery("")
                e.currentTarget.blur()
              }
            }}
            placeholder="Search transcripts"
            aria-label="Search transcripts"
            className="bg-background pr-8 pl-8 dark:bg-input/30"
          />
          <span className="absolute inset-y-0 right-2 flex items-center">
            {searching ? (
              <button
                type="button"
                onClick={() => onQuery("")}
                aria-label="Clear search"
                className="flex size-5 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : (
              <kbd className="pointer-events-none flex size-5 items-center justify-center border font-sans text-[10px] leading-none text-muted-foreground">
                /
              </kbd>
            )}
          </span>
        </div>
      </div>

      <nav
        aria-label="Transcripts"
        role="listbox"
        aria-multiselectable="true"
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4"
      >
        {list === null && (
          <div className="px-3 py-2 text-sm text-muted-foreground">
            Loading…
          </div>
        )}

        {list?.length === 0 && !searching && (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            Transcripts you add show up here.
          </p>
        )}

        {searching && list?.length === 0 && (
          <div className="px-3 py-2 text-sm">
            <p className="text-muted-foreground">
              No transcripts mention “{query.trim()}”.
            </p>
            <Button
              variant="link"
              size="sm"
              className="mt-1 h-auto px-0"
              onClick={() => onQuery("")}
            >
              Clear search
            </Button>
          </div>
        )}

        {searching && list?.map((t) => row(t, terms))}

        {groups?.map((g) => (
          <section
            key={g.label}
            role="group"
            aria-label={g.label}
            className="mt-6 space-y-0.5 first:mt-2"
          >
            <h3
              aria-hidden="true"
              className="px-3 pb-2 text-xs font-medium text-muted-foreground"
            >
              {g.label}
            </h3>
            {g.items.map((t) => row(t))}
          </section>
        ))}
        {!searching && hasMore && <LoadMore onVisible={onLoadMore} />}
      </nav>

      {selection.length > 1 && (
        <div className="flex items-center gap-1 border-t border-sidebar-border py-1.5 pr-2 pl-4 text-xs">
          <span className="font-medium tabular-nums">
            {selection.length} selected
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="xs" className="ml-auto" />}
            >
              Actions
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-56">
              <ActionsMenuItems
                targets={selection}
                kind="dropdown"
                onDelete={onDelete}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="xs" onClick={onClearSelection}>
            Clear
          </Button>
        </div>
      )}

      <footer className="flex items-center gap-2 border-t border-sidebar-border px-4 py-2.5 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-1.5",
            health === null
              ? "bg-muted-foreground/40"
              : health.engine
                ? "bg-primary"
                : "bg-destructive"
          )}
        />
        <span className="font-mono text-[11px] tracking-wide uppercase">
          {health === null
            ? "Connecting…"
            : health.engine
              ? "Phonon-2 ready"
              : "Engine offline"}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {!!health?.queue && (
            <span className="tabular-nums">{health.queue} in queue</span>
          )}
          <span className="flex items-center gap-1">
            <ThemeToggle />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="-my-1 text-muted-foreground hover:text-foreground"
                    aria-label="Settings"
                    onClick={onSettings}
                  />
                }
              >
                <SettingsIcon />
              </TooltipTrigger>
              <TooltipContent side="top">Settings (⌘,)</TooltipContent>
            </Tooltip>
          </span>
        </span>
      </footer>
    </div>
  )
})

/** Loads the next page once the end of the list scrolls into view (or is already visible). */
function LoadMore({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && onVisible(),
      { rootMargin: "400px" }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [onVisible])
  return (
    <div ref={ref} className="px-3 py-3 text-xs text-muted-foreground">
      Loading older transcripts…
    </div>
  )
}

const THEMES = [
  { value: "system", label: "System", Icon: MonitorIcon },
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
] as const

/** One button: each click moves System → Light → Dark → System. The icon shows the current mode. */
function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const i = Math.max(
    0,
    THEMES.findIndex((t) => t.value === theme)
  )
  const { label, Icon } = THEMES[i]
  const next = THEMES[(i + 1) % THEMES.length]
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="-my-1 text-muted-foreground hover:text-foreground"
            aria-label={`Theme: ${label}. Switch to ${next.label}.`}
            onClick={() => setTheme(next.value)}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent side="top">
        {label} theme. Click for {next.label.toLowerCase()}.
      </TooltipContent>
    </Tooltip>
  )
}

function Row({
  t,
  terms,
  open,
  selected,
  targets,
  onClick,
  onContext,
  onDelete,
}: {
  t: TranscriptSummary
  terms: RegExp | null
  open: boolean
  selected: boolean
  targets: TranscriptSummary[]
  onClick: (id: string, e: MouseEvent) => void
  onContext: (id: string) => void
  onDelete: (targets: TranscriptSummary[]) => void
}) {
  const busy = t.status === "queued" || t.status === "processing"
  return (
    <ContextMenu onOpenChange={(isOpen) => isOpen && onContext(t.id)}>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            role="option"
            data-id={t.id}
            aria-selected={selected}
            aria-current={open ? "page" : undefined}
            onClick={(e) => onClick(t.id, e)}
            className={cn(
              "relative block w-full overflow-hidden rounded-lg px-3 py-2.5 text-left outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50",
              selected
                ? "bg-[color-mix(in_oklch,var(--sidebar-accent),var(--foreground)_3%)] text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60"
            )}
          />
        }
      >
        {open && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-0.5 bg-primary"
          />
        )}
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {highlight(t.title, terms)}
          </span>
          {t.durationS != null && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {length(t.durationS)}
            </span>
          )}
        </span>
        <span
          className={cn(
            "mt-1 block text-xs leading-relaxed",
            t.snippet ? "line-clamp-2" : "truncate",
            t.status === "error" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {t.snippet ? (
            <Snippet text={t.snippet} />
          ) : t.status === "error" ? (
            "Couldn't transcribe"
          ) : t.status === "processing" ? (
            "Transcribing…"
          ) : t.status === "queued" ? (
            "Waiting…"
          ) : (
            t.preview || "No speech found"
          )}
        </span>
        {busy && (
          <span className="absolute inset-x-3 bottom-0.5 h-0.5 overflow-hidden bg-border">
            {t.status === "processing" && (
              <span className="indeterminate absolute inset-y-0 w-1/3 bg-primary" />
            )}
          </span>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ActionsMenuItems
          targets={targets}
          kind="context"
          onDelete={onDelete}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** FTS snippet with \u0002…\u0003 around matches; rendered as nodes, never as HTML. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {/* eslint-disable-next-line no-control-regex -- \u0002/\u0003 are the server's match markers */}
      {text.split(/[\u0002\u0003]/).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-primary/35 text-foreground">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  )
}

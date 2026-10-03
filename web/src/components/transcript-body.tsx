import { memo, useEffect, useMemo, useRef } from "react"
import { cn } from "@/lib/utils"
import { clock } from "@/lib/format"
import { highlight, termsRegex } from "@/lib/highlight"
import type { Segment } from "@/lib/api"

export type Layout = "paragraphs" | "lines"

const PARAGRAPH_PAUSE = 1.2
const PARAGRAPH_MAX = 5

type Block = { start: number; items: { seg: Segment; index: number }[] }

function blocks(segments: Segment[], layout: Layout): Block[] {
  const out: Block[] = []
  segments.forEach((seg, index) => {
    const last = out.at(-1)
    const prev = segments[index - 1]
    const newBlock =
      !last ||
      layout === "lines" ||
      seg.start - prev.end >= PARAGRAPH_PAUSE ||
      last.items.length >= PARAGRAPH_MAX
    if (newBlock) out.push({ start: seg.start, items: [{ seg, index }] })
    else last.items.push({ seg, index })
  })
  return out
}

/** Index of the segment playing at `time`, or -1. */
export function activeIndex(segments: Segment[], time: number) {
  let lo = 0
  let hi = segments.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].start <= time) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/**
 * The transcript text. Timestamps hang in the left gutter; every sentence is a
 * seek target. Only `active` changes during playback, so blocks are memoised.
 */
export function TranscriptBody({
  segments,
  layout,
  active,
  playing,
  query,
  onSeek,
}: {
  segments: Segment[]
  layout: Layout
  active: number
  playing: boolean
  query: string
  onSeek: (t: number) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const grouped = useMemo(() => blocks(segments, layout), [segments, layout])
  const terms = useMemo(() => termsRegex(query), [query])

  useEffect(() => {
    if (!playing || active < 0) return
    const el = root.current?.querySelector<HTMLElement>(
      `[data-seg="${active}"]`
    )
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [active, playing])

  return (
    <div
      ref={root}
      className={cn(
        "font-serif text-[1.0625rem] leading-[1.75]",
        layout === "lines" ? "space-y-1.5" : "space-y-6"
      )}
    >
      {grouped.map((b) => (
        <BlockView
          key={b.start}
          block={b}
          active={b.items.some((x) => x.index === active) ? active : -1}
          terms={terms}
          onSeek={onSeek}
        />
      ))}
    </div>
  )
}

const BlockView = memo(function BlockView({
  block,
  active,
  terms,
  onSeek,
}: {
  block: Block
  active: number
  terms: RegExp | null
  onSeek: (t: number) => void
}) {
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-x-4 sm:grid-cols-[4rem_minmax(0,1fr)]">
      <button
        type="button"
        onClick={() => onSeek(block.start)}
        className="justify-self-end rounded-sm font-sans text-xs text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label={`Play from ${clock(block.start)}`}
      >
        {clock(block.start)}
      </button>
      <p className="max-w-[66ch] text-pretty">
        {block.items.map(({ seg, index }, i) => (
          <span key={index}>
            {i > 0 && " "}
            <span
              data-seg={index}
              onClick={() => {
                if (!window.getSelection()?.toString()) onSeek(seg.start)
              }}
              className={cn(
                "cursor-pointer box-decoration-clone transition-colors duration-150 hover:bg-muted",
                index === active && "bg-primary/30 hover:bg-primary/40"
              )}
            >
              {highlight(seg.text, terms)}
            </span>
          </span>
        ))}
      </p>
    </div>
  )
})

import { useEffect, useRef, useState } from "react"
import { MicIcon, SquareIcon } from "lucide-react"
import type { LiveState, LiveText } from "@/audio/recorder"
import type { Levels, MicPhase } from "@/hooks/use-mic-mode"
import { clock } from "@/lib/format"
import { cn } from "@/lib/utils"

const BARS = 28
const BAR_W = 3
const GAP = 2

// Only transitional states need words; while recording, the timer and meter say enough.
const STATUS: Record<MicPhase, string> = {
  starting: "Opening the mic…",
  holding: "",
  tapped: "Tap M again for hands-free",
  handsfree: "",
  saving: "Saving…",
}

/** Speech RMS sits around 0.01–0.2; compress it into 0..1 so quiet talkers still move the meter. */
const level = (rms: number) =>
  Math.min(1, Math.sqrt(Math.max(0, rms - 0.002) * 12))

/**
 * The recording HUD. Always dark, whatever the theme, so it reads as an overlay.
 * The meter and edge glow are drawn per animation frame straight from the level ring
 * (no React state), and the timer is written into the DOM the same way.
 */
type Props = {
  text: LiveText
  live: LiveState
  startedAt: number
  levels: Levels
  onStop: () => void
  onDiscard: () => void
}

/**
 * Stays mounted after recording ends (`phase` → null) until its exit animation finishes,
 * showing the last phase meanwhile, so the bar leaves instead of vanishing.
 */
export function MicBar({
  phase,
  ...props
}: Props & { phase: MicPhase | null }) {
  const [last, setLast] = useState<MicPhase | null>(phase)
  if (phase && phase !== last) setLast(phase)
  if (!last) return null
  return (
    <MicBarPanel
      {...props}
      phase={phase ?? last}
      closing={!phase}
      onExited={() => setLast(null)}
    />
  )
}

function MicBarPanel({
  phase,
  closing,
  onExited,
  text,
  live,
  startedAt,
  levels,
  onStop,
  onDiscard,
}: Props & { phase: MicPhase; closing: boolean; onExited: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const glow = useRef<HTMLDivElement>(null)
  const timer = useRef<HTMLSpanElement>(null)
  const caption = useRef<HTMLParagraphElement>(null)
  const recording = !closing && phase !== "saving"

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext("2d")!
    const dpr = window.devicePixelRatio || 1
    const w = BARS * (BAR_W + GAP) - GAP
    const h = 28
    c.width = w * dpr
    c.height = h * dpr
    ctx.scale(dpr, dpr)
    const lime = getComputedStyle(c).getPropertyValue("--primary").trim()
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches
    let smooth = 0
    let raf = 0
    const draw = () => {
      const ls = levels.read().slice(-BARS)
      ctx.clearRect(0, 0, w, h)
      ls.forEach((rms, i) => {
        const v = recording ? level(rms) : 0
        const bh = Math.max(2, v * h)
        ctx.globalAlpha = 0.35 + 0.65 * (i / BARS) // older bars fade out to the left
        ctx.fillStyle = lime
        ctx.fillRect(i * (BAR_W + GAP), (h - bh) / 2, BAR_W, bh)
      })
      const now = level(ls[ls.length - 1] ?? 0)
      smooth += (now - smooth) * (still ? 1 : 0.25)
      if (glow.current) {
        glow.current.style.transform = `scaleX(${recording ? Math.max(0.04, smooth) : 0})`
        glow.current.style.opacity = String(0.4 + smooth * 0.6)
      }
      if (timer.current)
        timer.current.textContent = clock(
          (performance.now() - startedAt) / 1000
        )
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [levels, recording, startedAt])

  // Keep the newest words in view, and fade the left edge only once text has actually run
  // off it. Set on the element directly: this changes with every partial, no re-render needed.
  useEffect(() => {
    const el = caption.current
    if (!el) return
    const sync = () => {
      el.scrollLeft = el.scrollWidth
      el.toggleAttribute("data-overflow", el.scrollWidth > el.clientWidth + 1)
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, live])

  const said = text.finals.join(" ")
  const empty = !said && !text.partial

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div
        role="status"
        data-state={closing ? "closed" : "open"}
        inert={closing}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) onExited()
        }}
        aria-live="polite"
        className="mic-bar dark pointer-events-auto relative w-full max-w-[30rem] overflow-hidden border border-white/10 bg-[oklch(0.145_0_0)] text-[oklch(0.985_0_0)] shadow-2xl shadow-black/40"
      >
        {/* Edge glow: a lime line that grows from the centre with your voice. */}
        <div
          ref={glow}
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-0.5 origin-center bg-primary transition-[opacity] will-change-transform"
          style={{ transform: "scaleX(0.04)" }}
        />

        <div className="flex items-center gap-3 px-4 pt-3.5 pb-2 sm:gap-4">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-7 shrink-0 items-center justify-center bg-primary text-primary-foreground max-sm:hidden",
              phase === "saving" && "opacity-60"
            )}
          >
            <MicIcon className="size-4" />
          </span>
          <canvas
            ref={canvas}
            aria-hidden="true"
            className="h-7 min-w-0 shrink"
            style={{ width: BARS * (BAR_W + GAP) - GAP }}
          />
          <span
            ref={timer}
            className="w-12 shrink-0 font-heading text-lg font-semibold tabular-nums"
          >
            0:00
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-white/60">
            {STATUS[phase]}
          </span>
          {phase === "handsfree" && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onDiscard}
                className="h-8 px-3 text-sm text-white/60 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-primary"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={onStop}
                className="flex h-8 items-center gap-1.5 bg-primary px-3 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-white"
              >
                <SquareIcon className="size-3 fill-current" />
                Stop
              </button>
            </div>
          )}
        </div>

        <p
          ref={caption}
          className="overflow-hidden px-4 pb-3.5 text-sm leading-relaxed whitespace-nowrap data-overflow:mask-l-from-80%"
        >
          {live === "unavailable" && empty ? (
            <span className="font-sans text-sm text-white/45">
              Live preview isn't available right now. Your recording will still
              be transcribed.
            </span>
          ) : empty ? (
            <span className="font-sans text-sm text-white/45">
              {live === "connecting" ? "Listening…" : "Start talking."}
            </span>
          ) : (
            <>
              <span>{said}</span>
              {text.partial && (
                <span className="text-white/50"> {text.partial}</span>
              )}
            </>
          )}
          {recording && (
            <span
              aria-hidden="true"
              className="caret ml-0.5 inline-block h-[1.1em] w-1.5 translate-y-[0.2em] bg-primary"
            />
          )}
        </p>
      </div>
    </div>
  )
}

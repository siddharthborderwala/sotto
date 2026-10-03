import { useEffect, useRef, useState } from "react"
import { clock } from "@/lib/format"

const BAR = 2
const GAP = 1
const REVEAL_MS = 420

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * The recording as a waveform. It doubles as the scrubber: click or drag to
 * seek, arrow keys when focused. Played audio fills with the primary colour.
 */
export function Tape({
  peaks,
  duration,
  time,
  onSeek,
  reveal,
}: {
  peaks: Float32Array | null
  duration: number
  time: number
  onSeek: (t: number) => void
  /** Draw in left to right (once, when a transcript has just finished). */
  reveal: boolean
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [progress, setProgress] = useState(reveal && !reducedMotion() ? 0 : 1)
  const dragging = useRef(false)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) =>
      setWidth(Math.floor(e.contentRect.width))
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!reveal || reducedMotion()) return
    let raf = 0
    const start = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / REVEAL_MS)
      setProgress(1 - (1 - p) ** 3)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [reveal])

  useEffect(() => {
    const c = canvas.current
    if (!c || !width) return
    const h = c.clientHeight
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = h * dpr
    const ctx = c.getContext("2d")!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, h)

    const css = getComputedStyle(c)
    const played = css.getPropertyValue("--primary").trim()
    const rest = css.getPropertyValue("--muted-foreground").trim()
    const fg = css.getPropertyValue("--foreground").trim()

    const n = Math.floor((width + GAP) / (BAR + GAP))
    const playX = duration ? (time / duration) * width : 0
    const visible = n * progress
    const mid = h / 2

    for (let i = 0; i < n && i < visible; i++) {
      let v = 0.04
      if (peaks?.length) {
        const a = Math.floor((i / n) * peaks.length)
        const b = Math.max(a + 1, Math.floor(((i + 1) / n) * peaks.length))
        for (let j = a; j < b; j++) v = Math.max(v, peaks[j])
      }
      const x = i * (BAR + GAP)
      const bh = Math.max(2, v ** 0.8 * (h - 4))
      const isPlayed = x + BAR <= playX
      ctx.globalAlpha = isPlayed ? 1 : 0.32
      ctx.fillStyle = isPlayed ? played : rest
      ctx.fillRect(x, mid - bh / 2, BAR, bh)
    }

    ctx.globalAlpha = 1
    if (hover !== null) {
      ctx.fillStyle = fg
      ctx.globalAlpha = 0.25
      ctx.fillRect(Math.round(hover), 0, 1, h)
      ctx.globalAlpha = 1
    }
    if (time > 0 && progress === 1) {
      ctx.fillStyle = fg
      ctx.fillRect(Math.min(width - 2, Math.round(playX)), 0, 2, h)
    }
  }, [width, peaks, duration, time, hover, progress])

  const at = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }

  return (
    <div
      ref={wrap}
      role="slider"
      tabIndex={0}
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={`${clock(time)} of ${clock(duration)}`}
      className="group relative h-14 min-w-0 flex-1 cursor-pointer touch-none rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        onSeek(at(e.clientX) * duration)
      }}
      onPointerMove={(e) => {
        const r = wrap.current!.getBoundingClientRect()
        setHover(e.clientX - r.left)
        if (dragging.current) onSeek(at(e.clientX) * duration)
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (!e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault()
          e.stopPropagation()
          onSeek(time + (e.key === "ArrowLeft" ? -5 : 5))
        }
      }}
    >
      <canvas ref={canvas} className="block size-full" />
      {hover !== null && width > 0 && (
        <span
          className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded-md bg-foreground px-1.5 py-0.5 text-[11px] font-medium text-background tabular-nums"
          style={{ left: Math.max(18, Math.min(width - 18, hover)) }}
        >
          {clock((hover / width) * duration)}
        </span>
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  MicError,
  Recorder,
  type LiveState,
  type LiveText,
} from "@/audio/recorder"

/**
 * Mic mode, driven by the M key:
 *   hold M ............ push-to-talk; release to save
 *   double-tap M ...... hands-free; press M again (or Stop) to save
 *   single quick tap .. ignored (discarded)
 * Recording starts on the first keydown, so a double-tap continues the same recording with no gap.
 */

export type MicPhase =
  "starting" | "holding" | "tapped" | "handsfree" | "saving"

/** A press shorter than this is a tap, not a hold. */
const TAP_MS = 250
/** How long after a tap a second press still counts as a double-tap. */
const DOUBLE_TAP_MS = 350

export type Levels = { push: (rms: number) => void; read: () => Float32Array }

/** Ring buffer of recent levels, read by the bar's canvas each frame (no React re-render per block). */
function levelRing(size = 64): Levels {
  const buf = new Float32Array(size)
  let at = 0
  return {
    push: (rms) => {
      buf[at] = rms
      at = (at + 1) % size
    },
    read: () => {
      const out = new Float32Array(size)
      for (let i = 0; i < size; i++) out[i] = buf[(at + i) % size]
      return out
    },
  }
}

const voiceNoteName = () =>
  `Voice note ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`

export function useMicMode({
  blocked,
  onStart,
  onRecorded,
}: {
  /** True while typing, or a menu/dialog is open: M is a letter then, not a shortcut. */
  blocked: (e: KeyboardEvent) => boolean
  onStart: () => void
  onRecorded: (file: File) => Promise<void>
}) {
  const [phase, setPhase] = useState<MicPhase | null>(null)
  const [text, setText] = useState<LiveText>({ finals: [], partial: "" })
  const [live, setLive] = useState<LiveState>("connecting")
  const [startedAt, setStartedAt] = useState(0)
  const [levels] = useState(levelRing)

  const phaseRef = useRef<MicPhase | null>(null)
  const recorder = useRef<Promise<Recorder | null> | null>(null)
  // Each recording gets a token; a mic that finishes opening after its session ended is discarded.
  const session = useRef(0)
  const ready = useRef(false)
  const pressedAt = useRef(0)
  const ignoreKeyUp = useRef(false)
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const go = useCallback((p: MicPhase | null) => {
    phaseRef.current = p
    setPhase(p)
  }, [])

  const start = useCallback(
    (handsfree: boolean) => {
      if (phaseRef.current) return
      onStart()
      setText({ finals: [], partial: "" })
      setLive("connecting")
      setStartedAt(performance.now())
      go(handsfree ? "handsfree" : "starting")
      const token = ++session.current
      ready.current = false
      recorder.current = Recorder.start({
        onLevel: levels.push,
        onText: setText,
        onLiveState: setLive,
      }).then(
        (r) => {
          // Released or discarded while the mic was still opening.
          if (token !== session.current || !phaseRef.current) {
            r.discard()
            return null
          }
          ready.current = true
          if (phaseRef.current === "starting") go("holding")
          setStartedAt(performance.now())
          return r
        },
        (e) => {
          if (token === session.current) {
            toast.error(
              e instanceof MicError
                ? e.message
                : "Couldn't start the microphone."
            )
            go(null)
          }
          return null
        }
      )
    },
    [go, levels, onStart]
  )

  const finish = useCallback(
    async (save: boolean) => {
      clearTimeout(tapTimer.current)
      const pending = recorder.current
      recorder.current = null
      if (!pending) return go(null)
      // The mic never opened (e.g. M released during the permission prompt): nothing was
      // recorded, so end now instead of waiting on the prompt.
      if (!ready.current) {
        session.current++
        go(null)
        if (save)
          toast("The mic wasn't ready yet", {
            description: "Hold M again once the browser has mic access.",
          })
        return
      }
      if (save) go("saving")
      else go(null)
      const r = await pending
      if (!r) return go(null)
      if (!save) return r.discard()
      const file = await r.stop(voiceNoteName())
      go(null)
      if (!file)
        return toast("Too short to save", {
          description:
            "Hold M while you talk, or double-tap it for hands-free.",
        })
      await onRecorded(file)
    },
    [go, onRecorded]
  )

  const stop = useCallback(() => void finish(true), [finish])
  const discard = useCallback(() => void finish(false), [finish])
  const toggleHandsfree = useCallback(
    () => (phaseRef.current ? stop() : start(true)),
    [start, stop]
  )

  useEffect(() => {
    const isM = (e: KeyboardEvent) =>
      e.key.toLowerCase() === "m" && !e.metaKey && !e.ctrlKey && !e.altKey

    const down = (e: KeyboardEvent) => {
      if (!isM(e) || e.repeat || blocked(e)) return
      e.preventDefault()
      const p = phaseRef.current
      if (!p) {
        pressedAt.current = performance.now()
        start(false)
      } else if (p === "tapped") {
        clearTimeout(tapTimer.current) // second tap: keep the same recording going hands-free
        ignoreKeyUp.current = true
        go("handsfree")
      } else if (p === "handsfree") {
        ignoreKeyUp.current = true
        stop()
      }
    }

    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "m") return
      if (ignoreKeyUp.current) {
        ignoreKeyUp.current = false
        return
      }
      const p = phaseRef.current
      if (p !== "starting" && p !== "holding") return
      if (performance.now() - pressedAt.current < TAP_MS) {
        go("tapped")
        tapTimer.current = setTimeout(() => {
          if (phaseRef.current === "tapped") discard()
        }, DOUBLE_TAP_MS)
      } else stop()
    }

    // Losing focus mid-hold means the keyup will never arrive: treat it as a release.
    const blur = () => {
      const p = phaseRef.current
      if (p === "starting" || p === "holding") stop()
      else if (p === "tapped") discard()
    }

    const leave = (e: BeforeUnloadEvent) => {
      if (phaseRef.current && phaseRef.current !== "saving") e.preventDefault()
    }

    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", blur)
    window.addEventListener("beforeunload", leave)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      window.removeEventListener("blur", blur)
      window.removeEventListener("beforeunload", leave)
    }
  }, [blocked, discard, go, start, stop])

  // Unmount (e.g. hot reload): never leave the mic open.
  useEffect(() => () => void recorder.current?.then((r) => r?.discard()), [])

  return {
    phase,
    text,
    live,
    startedAt,
    levels,
    stop,
    discard,
    toggleHandsfree,
  }
}

import { useCallback, useEffect, useState } from "react"
import { defaultRate } from "@/lib/prefs"

/** Wraps an <audio>/<video> element; `time` updates every frame while playing so the playhead is smooth. */
export function usePlayer() {
  const [el, attach] = useState<HTMLMediaElement | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  // Each transcript starts at the default speed; the speed button changes only this playback.
  const [rate, setRateState] = useState(() => Number(defaultRate.get()))

  useEffect(() => {
    if (!el) return
    let raf = 0
    const tick = () => {
      setTime(el.currentTime)
      raf = requestAnimationFrame(tick)
    }
    const onPlay = () => {
      setPlaying(true)
      raf = requestAnimationFrame(tick)
    }
    const onPause = () => {
      setPlaying(false)
      cancelAnimationFrame(raf)
      setTime(el.currentTime)
    }
    const onSeeked = () => setTime(el.currentTime)
    el.addEventListener("play", onPlay)
    el.addEventListener("pause", onPause)
    el.addEventListener("ended", onPause)
    el.addEventListener("seeked", onSeeked)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener("play", onPlay)
      el.removeEventListener("pause", onPause)
      el.removeEventListener("ended", onPause)
      el.removeEventListener("seeked", onSeeked)
    }
  }, [el])

  const seek = useCallback(
    (t: number, play = false) => {
      if (!el) return
      // The element is DOM state, not React state; writing to it is how seeking works.
      // eslint-disable-next-line react-hooks/immutability
      el.currentTime = Math.max(
        0,
        Math.min(t, Number.isFinite(el.duration) ? el.duration : t)
      )
      setTime(el.currentTime)
      if (play) void el.play()
    },
    [el]
  )

  const toggle = useCallback(() => {
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }, [el])

  const pause = useCallback(() => el?.pause(), [el])

  const skip = useCallback(
    (d: number) => el && seek(el.currentTime + d),
    [el, seek]
  )

  // Loading audio resets playbackRate to defaultPlaybackRate, so set both.
  useEffect(() => {
    if (!el) return
    // eslint-disable-next-line react-hooks/immutability -- DOM element properties
    el.defaultPlaybackRate = rate
    el.playbackRate = rate
  }, [el, rate])

  const setRate = useCallback((r: number) => setRateState(r), [])

  return { attach, time, playing, rate, seek, toggle, pause, skip, setRate }
}

export type Player = ReturnType<typeof usePlayer>

/** What the app shell can do to whichever transcript is open (keyboard shortcuts, mic mode). */
export type PlayerControls = {
  toggle: () => void
  pause: () => void
  skip: (d: number) => void
  copy: () => void
}

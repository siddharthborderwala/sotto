import { useSyncExternalStore } from "react"

/**
 * Small per-browser preferences (localStorage), shared live across components: change one
 * anywhere and everything reading it re-renders. Invalid or unreadable values fall back to
 * the default, so private mode and old values are harmless.
 */
function pref<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[]
) {
  const listeners = new Set<() => void>()
  const get = (): T => {
    try {
      const v = localStorage.getItem(key)
      return allowed.includes(v as T) ? (v as T) : fallback
    } catch {
      return fallback
    }
  }
  const set = (v: T) => {
    try {
      localStorage.setItem(key, v)
    } catch {
      /* not persisted, but still applied for this session */
    }
    listeners.forEach((l) => l())
  }
  const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
  const use = () => useSyncExternalStore(subscribe, get, () => fallback)
  return { get, set, use }
}

export type TextVersion = "clean" | "raw"
export type Layout = "lines" | "paragraphs"
export const RATES = ["1", "1.25", "1.5", "2"] as const
export type Rate = (typeof RATES)[number]

/** Which text to show, copy and export when a cleaned version exists. */
export const textVersion = pref<TextVersion>("sotto.text", "clean", [
  "clean",
  "raw",
])
/** One sentence per line, or sentences grouped into paragraphs at pauses. */
export const layout = pref<Layout>("sotto.layout", "lines", [
  "lines",
  "paragraphs",
])
/** The speed every transcript starts playing at. */
export const defaultRate = pref<Rate>("sotto.rate", "1", RATES)

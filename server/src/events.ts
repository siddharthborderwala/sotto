import type { ServerEvent } from "./types"

type Listener = (e: ServerEvent) => void
const listeners = new Set<Listener>()

export function subscribe(fn: Listener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emit(e: ServerEvent) {
  for (const fn of listeners) fn(e)
}

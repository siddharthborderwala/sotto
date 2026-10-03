import { api, type Transcript } from "@/lib/api"

export type Loaded = {
  t: Transcript
  peaks: Float32Array | null
  version: number
}

// Keyed by id; `version` is the SSE change counter it was fetched at.
const cache = new Map<string, Loaded>()
const MAX = 30

export const cached = (id: string, version: number) => {
  const hit = cache.get(id)
  return hit && hit.version === version ? hit : undefined
}

/** Transcript and waveform together, so the view never paints half-loaded. */
// The app shell and the view both ask for the same transcript in the same frame; share the request.
const inflight = new Map<string, Promise<Loaded>>()

export function load(id: string, version: number): Promise<Loaded> {
  const hit = cached(id, version)
  if (hit) return Promise.resolve(hit)
  const key = `${id}@${version}`
  const pending = inflight.get(key)
  if (pending) return pending
  const request = Promise.all([api.get(id), api.peaks(id)])
    .then(([t, peaks]) => {
      const entry = { t, peaks: t.status === "done" ? peaks : null, version }
      cache.delete(id)
      cache.set(id, entry)
      if (cache.size > MAX) cache.delete(cache.keys().next().value!)
      return entry
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

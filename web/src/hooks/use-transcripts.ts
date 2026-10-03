import { useCallback, useEffect, useRef, useState } from "react"
import { api, subscribe, type TranscriptSummary } from "@/lib/api"

const PAGE = 100

/**
 * The full (unsearched) list, newest first, kept live over SSE and loaded a page at a time.
 * `version[id]` goes up whenever a transcript may have changed, so views showing it refetch.
 */
export function useTranscripts({
  onDeleted,
}: {
  /** A transcript went away (deleted anywhere, or a silent mic recording discarded). */
  onDeleted?: (id: string, reason?: "no-speech") => void
} = {}) {
  const [items, setItems] = useState<TranscriptSummary[] | null>(null)
  const [version, setVersion] = useState<Record<string, number>>({})
  const [hasMore, setHasMore] = useState(false)
  const loaded = useRef(0)
  const loadingMore = useRef(false)
  const deleted = useRef(onDeleted)
  useEffect(() => {
    deleted.current = onDeleted
  })

  const bump = useCallback((ids: string[]) => {
    setVersion((v) => {
      const next = { ...v }
      for (const id of ids) next[id] = (next[id] ?? 0) + 1
      return next
    })
  }, [])

  // (Re)connecting may have missed events (e.g. the Mac slept): refetch everything we had,
  // and mark it all as possibly changed.
  const reload = useCallback(async () => {
    const limit = Math.max(PAGE, loaded.current)
    const list = await api.list({ limit })
    loaded.current = list.length
    setItems(list)
    setHasMore(list.length === limit)
    bump(list.map((t) => t.id))
  }, [bump])

  const loadMore = useCallback(async () => {
    if (loadingMore.current || !hasMore || !items?.length) return
    loadingMore.current = true
    try {
      const page = await api.list({
        before: items.at(-1)!.createdAt,
        limit: PAGE,
      })
      setItems((xs) => {
        const seen = new Set(xs?.map((x) => x.id))
        return [...(xs ?? []), ...page.filter((t) => !seen.has(t.id))]
      })
      loaded.current += page.length
      setHasMore(page.length === PAGE)
    } finally {
      loadingMore.current = false
    }
  }, [hasMore, items])

  useEffect(() => {
    return subscribe(
      (e) => {
        if (e.type === "delete") {
          setItems((xs) => xs?.filter((x) => x.id !== e.id) ?? xs)
          bump([e.id]) // an open view refetches and shows that it's gone
          deleted.current?.(e.id, e.reason)
          return
        }
        const t = e.transcript
        setItems((xs) => {
          if (!xs) return xs
          const i = xs.findIndex((x) => x.id === t.id)
          if (i === -1)
            return [t, ...xs].sort((a, b) => b.createdAt - a.createdAt)
          const next = xs.slice()
          next[i] = t
          return next
        })
        bump([t.id])
      },
      () => void reload()
    )
  }, [reload, bump])

  return { items, version, hasMore, loadMore }
}

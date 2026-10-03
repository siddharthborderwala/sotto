export function clock(s: number) {
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

/** "16 min", "42 s", "1 h 05 min" */
export function length(s: number) {
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`
}

export function seconds(ms: number) {
  return ms < 1000
    ? `${(ms / 1000).toFixed(2)} s`
    : `${(ms / 1000).toFixed(1)} s`
}

export function bytes(n: number) {
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

export function dayLabel(ts: number) {
  const today = startOfDay(new Date())
  const day = startOfDay(new Date(ts))
  if (day === today) return "Today"
  if (day === today - 86_400_000) return "Yesterday"
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    weekday: sameYear ? "long" : undefined,
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  })
}

export function when(ts: number) {
  const d = new Date(ts)
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
  const label = dayLabel(ts)
  return label === "Today" || label === "Yesterday"
    ? `${label}, ${time}`
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`
}

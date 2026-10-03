// Transcript URLs: /t/<title-slug>-<id>. Only the id (after the last "-") is used to look a
// transcript up, so links keep working after a rename; the slug is just for humans.

export function slugify(title: string) {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "")
  return slug || "recording"
}

export function transcriptPath(id: string, title?: string) {
  return title ? `/t/${slugify(title)}-${id}` : `/t/${id}`
}

/** The transcript id in the current URL, if any. */
export function idFromLocation() {
  const m = /^\/t\/(?:[a-z0-9-]*-)?([a-z0-9]+)\/?$/.exec(location.pathname)
  return m?.[1] ?? null
}

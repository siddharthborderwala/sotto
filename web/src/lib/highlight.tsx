/** Regex matching each query word as a word prefix, mirroring the server's FTS prefix search. */
export function termsRegex(query: string) {
  const words = query.match(/[\p{L}\p{N}']+/gu)
  if (!words?.length) return null
  return new RegExp(
    `(${words.map((w) => `\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*`).join("|")})`,
    "giu"
  )
}

export function highlight(text: string, terms: RegExp | null) {
  if (!terms) return text
  return text.split(terms).map((part, i) =>
    i % 2 ? (
      <mark key={i} className="bg-primary/35 text-inherit">
        {part}
      </mark>
    ) : (
      part
    )
  )
}

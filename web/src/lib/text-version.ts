import { textVersion, type TextVersion } from "@/lib/prefs"

export type { TextVersion }
export const getTextVersion = textVersion.get
export const setTextVersion = textVersion.set
export const useTextVersion = textVersion.use

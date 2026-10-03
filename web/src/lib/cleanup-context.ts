import { createContext, useContext } from "react"

/** Whether a clean-up provider is configured; clean-up actions are hidden when it isn't. */
export const CleanupEnabled = createContext(false)
export const useCleanupEnabled = () => useContext(CleanupEnabled)

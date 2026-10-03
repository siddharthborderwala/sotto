import { cn } from "@/lib/utils"

/** Square-cut closing quotes on the primary colour: what was said. Same drawing as public/favicon.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={cn("size-5 shrink-0", className)}
    >
      <rect width="32" height="32" fill="var(--primary)" />
      <g fill="oklch(0.145 0 0)">
        <rect x="7" y="9" width="7" height="7" />
        <rect x="11" y="16" width="3" height="5" />
        <rect x="18" y="9" width="7" height="7" />
        <rect x="22" y="16" width="3" height="5" />
      </g>
    </svg>
  )
}

import {
  CopyIcon,
  DownloadIcon,
  AudioLinesIcon,
  RotateCwIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react"
import type { TranscriptSummary } from "@/lib/api"
import { useCleanupEnabled } from "@/lib/cleanup-context"
import {
  can,
  cleanup,
  copy,
  download,
  plural,
  retry,
  type ExportFormat,
} from "@/lib/actions"
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"

const FORMATS: [ExportFormat, string][] = [
  ["txt", "Plain text"],
  ["md", "Markdown"],
  ["srt", "Subtitles (SRT)"],
  ["vtt", "Subtitles (WebVTT)"],
]

const PARTS = {
  context: {
    Group: ContextMenuGroup,
    Item: ContextMenuItem,
    Label: ContextMenuLabel,
    Separator: ContextMenuSeparator,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
  dropdown: {
    Group: DropdownMenuGroup,
    Item: DropdownMenuItem,
    Label: DropdownMenuLabel,
    Separator: DropdownMenuSeparator,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
}

/** Actions for one or more transcripts, shared by the row context menu and the selection bar. */
export function ActionsMenuItems({
  targets,
  kind,
  onDelete,
}: {
  targets: TranscriptSummary[]
  kind: keyof typeof PARTS
  onDelete: (targets: TranscriptSummary[]) => void
}) {
  const { Group, Item, Label, Separator, Sub, SubTrigger, SubContent } =
    PARTS[kind]
  const many = targets.length > 1
  const cleanupEnabled = useCleanupEnabled()
  return (
    <>
      {many && (
        <Group>
          <Label>{plural(targets.length, "transcript")} selected</Label>
        </Group>
      )}
      <Item disabled={!can.copy(targets)} onClick={() => copy(targets)}>
        <CopyIcon />
        Copy text
      </Item>
      <Sub>
        <SubTrigger disabled={!can.export(targets)}>
          <DownloadIcon />
          Export
        </SubTrigger>
        <SubContent className="w-48">
          {FORMATS.map(([f, label]) => (
            <Item key={f} onClick={() => download(targets, f)}>
              {label}
              <span className="ml-auto text-xs text-muted-foreground">
                {many ? ".zip" : `.${f}`}
              </span>
            </Item>
          ))}
        </SubContent>
      </Sub>
      <Item onClick={() => download(targets, "original")}>
        <AudioLinesIcon />
        {many ? "Download originals" : "Download original"}
      </Item>
      <Item disabled={!can.retry(targets)} onClick={() => void retry(targets)}>
        <RotateCwIcon />
        Transcribe again
      </Item>
      {cleanupEnabled && (
        <Item
          disabled={!can.cleanup(targets)}
          onClick={() => void cleanup(targets)}
        >
          <SparklesIcon />
          Clean up again
        </Item>
      )}
      <Separator />
      <Item variant="destructive" onClick={() => onDelete(targets)}>
        <Trash2Icon />
        {many ? `Delete ${targets.length} transcripts` : "Delete transcript"}
      </Item>
    </>
  )
}

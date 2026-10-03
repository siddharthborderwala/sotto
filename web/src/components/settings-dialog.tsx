import { useEffect, useId, useState, type ReactNode } from "react"
import { toast } from "sonner"
import {
  InfoIcon,
  LoaderIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react"
import {
  api,
  type CleanupSettingsInput,
  type Health,
  type Settings,
} from "@/lib/api"
import * as prefs from "@/lib/prefs"
import { cn } from "@/lib/utils"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

type Section = "cleanup" | "customize" | "about"
type Provider = "off" | "claude" | "codex" | "openai"
type Form = Omit<CleanupSettingsInput, "provider"> & { provider: Provider }

const SECTIONS: { id: Section; label: string; Icon: typeof InfoIcon }[] = [
  { id: "cleanup", label: "Clean-up", Icon: SparklesIcon },
  { id: "customize", label: "Customize", Icon: SlidersHorizontalIcon },
  { id: "about", label: "About", Icon: InfoIcon },
]

const PROVIDERS: {
  value: Provider
  label: string
  detail: string
  missing?: string
}[] = [
  {
    value: "off",
    label: "Off",
    detail: "Keep transcripts exactly as Phonon-2 wrote them.",
  },
  {
    value: "claude",
    label: "Claude",
    detail:
      "Uses your Claude Code sign-in. Sends transcript text to Anthropic.",
    missing:
      "Claude Code not found. Install it and run `claude` once to sign in.",
  },
  {
    value: "codex",
    label: "Codex",
    detail:
      "Uses your Codex CLI and ChatGPT sign-in. Sends transcript text to OpenAI.",
    missing: "Codex CLI not found. Install it and run `codex login`.",
  },
  {
    value: "openai",
    label: "OpenAI-compatible API",
    detail:
      "OpenAI with an API key, or a local model in Ollama, LM Studio or llama.cpp that never leaves this Mac.",
  },
]

const PRESETS = [
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "Ollama", url: "http://localhost:11434/v1" },
  { label: "LM Studio", url: "http://localhost:1234/v1" },
]

function toForm(s: Settings): Form {
  const { provider, auto, model, effort, url } = s.cleanup
  return { provider: provider ?? "off", auto, model, effort, url }
}

type Test =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; after: string[]; ms: number }
  | { state: "error"; message: string }

export function SettingsDialog({
  open,
  onOpenChange,
  health,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  health: Health | null
  onSaved: () => void
}) {
  const [section, setSection] = useState<Section>("cleanup")
  const [settings, setSettings] = useState<Settings | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState<Test>({ state: "idle" })

  // Fresh values every time it opens, so a hand-edited config.env shows up.
  useEffect(() => {
    if (!open) return
    let live = true
    api.settings().then(
      (s) => {
        if (!live) return
        setSettings(s)
        setForm(toForm(s))
        setTest({ state: "idle" })
      },
      (e) =>
        toast.error("Couldn't load settings", {
          description: (e as Error).message,
        })
    )
    return () => {
      live = false
    }
  }, [open])

  const dirty =
    !!settings &&
    !!form &&
    JSON.stringify(form) !== JSON.stringify(toForm(settings))
  const set = (patch: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...patch } : f))
    setTest({ state: "idle" })
  }
  const payload = (f: Form): CleanupSettingsInput => ({
    ...f,
    provider: f.provider === "off" ? null : f.provider,
  })

  // Switching provider swaps in its default model, unless you'd typed your own.
  const chooseProvider = (next: Provider) => {
    if (!form || !settings) return
    const defaults = settings.defaultModels
    const wasDefault =
      !form.model ||
      (form.provider !== "off" && form.model === defaults[form.provider])
    const efforts = next === "off" ? [] : settings.efforts[next]
    set({
      provider: next,
      model: wasDefault ? (next === "off" ? "" : defaults[next]) : form.model,
      effort: efforts.includes(form.effort) ? form.effort : "low",
    })
  }

  const save = async () => {
    if (!form) return
    setSaving(true)
    try {
      const s = await api.saveCleanup(payload(form))
      setSettings(s)
      setForm(toForm(s))
      toast("Settings saved")
      onSaved()
      onOpenChange(false)
    } catch (e) {
      toast.error("Couldn't save settings", {
        description: (e as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    if (!form) return
    setTest({ state: "running" })
    try {
      const r = await api.testCleanup(payload(form))
      setTest({ state: "ok", after: r.after, ms: r.ms })
    } catch (e) {
      setTest({ state: "error", message: (e as Error).message })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="flex h-[min(38rem,calc(100svh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="shrink-0 border-b px-5 py-4">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Clean-up, customization and information about this install.
          </DialogDescription>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label="Settings sections"
            className="flex shrink-0 gap-0.5 overflow-x-auto border-b p-2 sm:w-48 sm:flex-col sm:border-r sm:border-b-0"
          >
            {SECTIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={section === id ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-2 px-3 py-2 text-left text-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  section === id
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
              >
                {section === id && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 w-0.5 bg-primary max-sm:hidden"
                  />
                )}
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
            {!form || !settings ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
                Loading…
              </div>
            ) : section === "cleanup" ? (
              <CleanupSection
                form={form}
                settings={settings}
                test={test}
                set={set}
                chooseProvider={chooseProvider}
                onTest={() => void runTest()}
              />
            ) : section === "customize" ? (
              <CustomizeSection />
            ) : (
              <AboutSection settings={settings} health={health} />
            )}
          </div>
        </div>

        <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t px-5 py-2.5">
          <span className="mr-auto self-center text-xs text-muted-foreground max-sm:hidden">
            {dirty
              ? "Unsaved clean-up changes"
              : section === "customize"
                ? "Changes here apply right away"
                : ""}
          </span>
          <DialogClose render={<Button variant="ghost" disabled={saving} />}>
            {dirty ? "Cancel" : "Close"}
          </DialogClose>
          <Button
            className="relative"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            <span className={cn(saving && "invisible")}>Save</span>
            {saving && (
              <span className="absolute inset-0 flex items-center justify-center">
                <LoaderIcon className="animate-spin motion-reduce:animate-none" />
              </span>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SectionHeading({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="mb-5">
      <h3 className="text-base font-medium">{title}</h3>
      {children && (
        <p className="mt-1 text-sm text-muted-foreground">{children}</p>
      )}
    </div>
  )
}

function CleanupSection({
  form,
  settings,
  test,
  set,
  chooseProvider,
  onTest,
}: {
  form: Form
  settings: Settings
  test: Test
  set: (patch: Partial<Form>) => void
  chooseProvider: (p: Provider) => void
  onTest: () => void
}) {
  const efforts = form.provider === "off" ? [] : settings.efforts[form.provider]
  return (
    <>
      <SectionHeading title="Clean-up">
        Tidies each transcript after it's transcribed: removes filler words and
        stutters and fixes punctuation. The raw transcript is always kept.
      </SectionHeading>

      <RadioGroup
        value={form.provider}
        onValueChange={(v) => chooseProvider(v as Provider)}
        className="gap-0 border"
        aria-label="Clean-up provider"
      >
        {PROVIDERS.map((p) => {
          const unavailable =
            (p.value === "claude" && !settings.installed.claude) ||
            (p.value === "codex" && !settings.installed.codex)
          return (
            <label
              key={p.value}
              className={cn(
                "flex gap-3 border-b px-3 py-3 last:border-b-0 has-data-checked:bg-muted/60",
                unavailable ? "opacity-50" : "cursor-pointer hover:bg-muted/40"
              )}
            >
              <RadioGroupItem
                value={p.value}
                disabled={unavailable}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{p.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {unavailable ? p.missing : p.detail}
                </span>
              </span>
            </label>
          )
        })}
      </RadioGroup>

      {form.provider !== "off" && (
        <div className="mt-6 space-y-5">
          {form.provider === "openai" && (
            <Field
              label="Base URL"
              action={
                <span className="flex gap-1">
                  {PRESETS.map((p) => (
                    <Button
                      key={p.label}
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-pressed={form.url === p.url}
                      className="text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
                      onClick={() => set({ url: p.url })}
                    >
                      {p.label}
                    </Button>
                  ))}
                </span>
              }
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.url}
                  placeholder="http://localhost:11434/v1"
                  onChange={(e) => set({ url: e.target.value })}
                  className="font-mono text-xs"
                />
              )}
            </Field>
          )}

          <div
            className={cn(
              "grid gap-5",
              (efforts.length > 0 || form.provider === "openai") &&
                "sm:grid-cols-2"
            )}
          >
            <Field label="Model">
              {(id) => (
                <Input
                  id={id}
                  value={form.model}
                  placeholder={
                    form.provider === "openai"
                      ? "e.g. gpt-4o-mini or llama3.2"
                      : settings.defaultModels[
                          form.provider as "claude" | "codex"
                        ]
                  }
                  onChange={(e) => set({ model: e.target.value })}
                />
              )}
            </Field>
            {efforts.length > 0 && (
              <Field label="Effort">
                {(id) => (
                  <ToggleGroup
                    id={id}
                    size="sm"
                    variant="outline"
                    spacing={0}
                    value={[form.effort]}
                    onValueChange={(v: string[]) =>
                      v[0] && set({ effort: v[0] })
                    }
                  >
                    {efforts.map((e) => (
                      <ToggleGroupItem
                        key={e}
                        value={e}
                        className="h-8 px-2.5 text-xs capitalize"
                      >
                        {e}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                )}
              </Field>
            )}
            {form.provider === "openai" && (
              <Field label="API key">
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="off"
                    value={form.apiKey ?? ""}
                    placeholder={
                      settings.cleanup.apiKeySet
                        ? "Saved. Type to replace"
                        : "Not needed for local servers"
                    }
                    onChange={(e) => set({ apiKey: e.target.value })}
                  />
                )}
              </Field>
            )}
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-4 border-t pt-5 text-sm">
            <span>
              <span className="block">Clean new transcripts automatically</span>
              <span className="block text-xs text-muted-foreground">
                Otherwise, clean up from a transcript's menu.
              </span>
            </span>
            <Switch
              checked={form.auto}
              onCheckedChange={(auto) => set({ auto })}
            />
          </label>

          <div className="space-y-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onTest}
              disabled={test.state === "running"}
            >
              {test.state === "running" && (
                <LoaderIcon
                  className="animate-spin motion-reduce:animate-none"
                  data-icon="inline-start"
                />
              )}
              Test with a sample
            </Button>
            {test.state === "ok" && (
              <p className="border-l-2 border-primary pl-3 text-sm">
                {test.after.filter(Boolean).join(" ")}
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                  {(test.ms / 1000).toFixed(1)} s
                </span>
              </p>
            )}
            {test.state === "error" && (
              <p className="border-l-2 border-destructive pl-3 text-sm text-destructive">
                {test.message}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function CustomizeSection() {
  const { theme, setTheme } = useTheme()
  const text = prefs.textVersion.use()
  const layout = prefs.layout.use()
  const rate = prefs.defaultRate.use()
  return (
    <>
      <SectionHeading title="Customize">Saved in this browser.</SectionHeading>
      <div className="space-y-6">
        <Choice
          label="Theme"
          value={theme}
          onChange={(v) => setTheme(v as typeof theme)}
          options={[
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
        />
        <Choice
          label="Transcript text"
          hint="Which version to show, copy and export when a cleaned one exists."
          value={text}
          onChange={(v) => prefs.textVersion.set(v as prefs.TextVersion)}
          options={[
            ["clean", "Clean"],
            ["raw", "Raw"],
          ]}
        />
        <Choice
          label="Transcript display"
          hint="One sentence per line, or sentences grouped into paragraphs at pauses."
          value={layout}
          onChange={(v) => prefs.layout.set(v as prefs.Layout)}
          options={[
            ["lines", "Lines"],
            ["paragraphs", "Paragraphs"],
          ]}
        />
        <Choice
          label="Default playback speed"
          hint="Every transcript starts at this speed. The speed button still changes it while you listen."
          value={rate}
          onChange={(v) => prefs.defaultRate.set(v as prefs.Rate)}
          options={prefs.RATES.map((r) => [r, `${r}×`])}
        />
      </div>
    </>
  )
}

function AboutSection({
  settings,
  health,
}: {
  settings: Settings
  health: Health | null
}) {
  return (
    <>
      <SectionHeading title="About" />
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
        <dt className="text-muted-foreground">Engine</dt>
        <dd>
          {health === null
            ? "Connecting…"
            : health.engine
              ? "Phonon-2, ready"
              : "Offline"}
        </dd>
        <dt className="text-muted-foreground">
          {settings.addresses.length > 1 ? "Addresses" : "Address"}
        </dt>
        <dd className="space-y-0.5">
          {settings.addresses.map((a) => (
            <a
              key={a}
              href={a}
              className="block truncate underline-offset-2 hover:underline"
            >
              {a}
            </a>
          ))}
        </dd>
        <dt className="text-muted-foreground">Library</dt>
        <dd
          className="truncate font-mono text-xs leading-5"
          title={settings.dataDir}
        >
          {settings.dataDir.replace(/^\/Users\/[^/]+/, "~")}
        </dd>
        <dt className="text-muted-foreground">Version</dt>
        <dd className="tabular-nums">{settings.version}</dd>
      </dl>
      <div className="mt-8 space-y-1.5 text-xs text-muted-foreground">
        <p className="text-sm text-foreground">
          Built with ❤️ by{" "}
          <a
            href="https://x.com/sidborderwala"
            target="_blank"
            rel="noreferrer"
            className="font-medium underline-offset-2 hover:underline"
          >
            @sidborderwala
          </a>
        </p>
        <p>
          Speech recognition by Phonon-2 from Fermion Research.{" "}
          <a
            href="https://github.com/siddharthborderwala/sotto"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Sotto on GitHub
          </a>
        </p>
      </div>
    </>
  )
}

function Choice({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  options: [string, string][]
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <ToggleGroup
          id={id}
          size="sm"
          variant="outline"
          spacing={0}
          value={[value]}
          onValueChange={(v: string[]) => v[0] && onChange(v[0])}
        >
          {options.map(([v, l]) => (
            <ToggleGroupItem key={v} value={v} className="h-8 px-3 text-xs">
              {l}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
    </Field>
  )
}

function Field({
  label,
  hint,
  action,
  children,
}: {
  label: string
  hint?: ReactNode
  action?: ReactNode
  children: (id: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {action}
      </div>
      {children(id)}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

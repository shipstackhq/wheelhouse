import { useCallback, useRef, useState, type ReactNode } from "react";
import { AlertDialog, Dialog, Select as RSelect } from "radix-ui";
import clsx from "clsx";
import { ChevronDownIcon } from "./icons";

// ───────── Select ─────────
// Radix Select forbids empty-string item values, so "" is mapped to a sentinel.
const NONE = "__none__";

/** `icon`: shown before the label, in the list and on the trigger. */
export type Option = { value: string; label: string; icon?: ReactNode };

export function Select(props: {
  options: Option[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  name?: string;
  className?: string;
  triggerClassName?: string;
  placeholder?: string;
  disabled?: boolean;
  /** The trigger's accessible name, for a select with no visible label. */
  ariaLabel?: string;
  /** Hide the chevron on the trigger (a compact control with its label beside it). */
  noChevron?: boolean;
  /** Smaller items and text in the list, for a compact control. */
  compact?: boolean;
}) {
  // "" maps to the sentinel only when it's a real option; otherwise it means "nothing selected" (shows placeholder).
  const hasEmpty = props.options.some((o) => o.value === "");
  const enc = (v: string | undefined) => (v === "" && hasEmpty ? NONE : v);
  const dec = (v: string) => (v === NONE ? "" : v);
  return (
    <RSelect.Root
      value={enc(props.value)}
      defaultValue={enc(props.defaultValue)}
      onValueChange={(v) => props.onValueChange?.(dec(v))}
      name={props.name}
      disabled={props.disabled}
    >
      <RSelect.Trigger
        aria-label={props.ariaLabel}
        className={clsx(
          "input flex items-center justify-between gap-2 py-1.5 text-left data-[placeholder]:text-muted",
          props.className,
          props.triggerClassName,
        )}
      >
        <span className="min-w-0 truncate">
          <RSelect.Value placeholder={props.placeholder} />
        </span>
        {!props.noChevron && <RSelect.Icon className="text-muted"><ChevronDownIcon /></RSelect.Icon>}
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className={clsx("z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line bg-panel text-fg shadow-xl", props.compact ? "text-xs" : "text-sm")}
        >
          <RSelect.Viewport className="p-1">
            {props.options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={enc(o.value)!}
                className={clsx("relative flex cursor-pointer select-none items-center rounded outline-none data-[highlighted]:bg-panel-2 data-[state=checked]:text-accent", props.compact ? "px-1.5 py-0.5" : "px-2.5 py-1.5")}
              >
                <RSelect.ItemText>
                  {o.icon ? (
                    <span className="inline-flex items-center gap-2">
                      {o.icon}
                      {o.label}
                    </span>
                  ) : (
                    o.label
                  )}
                </RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

// ───────── Confirm / Prompt dialogs (replace window.confirm / window.prompt) ─────────

type ConfirmOpts = { title: string; description?: string; confirmLabel?: string; danger?: boolean };
type PromptOpts = { title: string; description?: string; placeholder?: string; confirmLabel?: string };

type State =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void }
  | null;

/** `const { confirm, prompt, dialogs } = useDialogs()` then render `{dialogs}` once. */
export function useDialogs() {
  const [state, setState] = useState<State>(null);
  const [text, setText] = useState("");
  const settled = useRef(false);

  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => {
        settled.current = false;
        setState({ kind: "confirm", opts, resolve });
      }),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        settled.current = false;
        setText("");
        setState({ kind: "prompt", opts, resolve });
      }),
    [],
  );

  const close = (result: boolean | string | null) => {
    if (!state || settled.current) return;
    settled.current = true;
    if (state.kind === "confirm") state.resolve(result === true);
    else state.resolve(typeof result === "string" ? result : null);
    setState(null);
  };

  const overlay = "fixed inset-0 z-40 bg-black/50";
  const content =
    "fixed left-1/2 top-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-5 text-fg shadow-2xl";

  const dialogs = (
    <>
      <AlertDialog.Root open={state?.kind === "confirm"} onOpenChange={(o) => !o && close(false)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={overlay} />
          <AlertDialog.Content className={content}>
            <AlertDialog.Title className="font-semibold">{state?.kind === "confirm" && state.opts.title}</AlertDialog.Title>
            {state?.kind === "confirm" && state.opts.description && (
              <AlertDialog.Description className="mt-2 text-sm text-muted">{state.opts.description}</AlertDialog.Description>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel className="btn">Cancel</AlertDialog.Cancel>
              <AlertDialog.Action
                className={clsx("btn", state?.kind === "confirm" && state.opts.danger ? "btn-danger" : "btn-primary")}
                onClick={() => close(true)}
              >
                {(state?.kind === "confirm" && state.opts.confirmLabel) || "Confirm"}
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <Dialog.Root open={state?.kind === "prompt"} onOpenChange={(o) => !o && close(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className={overlay} />
          <Dialog.Content className={content}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) close(text.trim());
              }}
            >
              <Dialog.Title className="font-semibold">{state?.kind === "prompt" && state.opts.title}</Dialog.Title>
              {state?.kind === "prompt" && state.opts.description && (
                <Dialog.Description className="mt-2 text-sm text-muted">{state.opts.description}</Dialog.Description>
              )}
              <input
                autoFocus
                className="input mt-4"
                value={text}
                placeholder={state?.kind === "prompt" ? state.opts.placeholder : undefined}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="mt-5 flex justify-end gap-2">
                <Dialog.Close type="button" className="btn">Cancel</Dialog.Close>
                <button className="btn btn-primary" disabled={!text.trim()}>
                  {(state?.kind === "prompt" && state.opts.confirmLabel) || "Create"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );

  return { confirm, prompt, dialogs };
}

import { useState } from "react";
import { Dialog } from "radix-ui";
import { AVATAR_STYLES, randomSeed, type AvatarStyle } from "@wheelhouse/shared/agents/avatar";
import type { AgentView } from "@wheelhouse/shared/agents/render";
import { describeFailure } from "../lib/form-state";
import { AgentAvatar } from "./agent-avatar";

const STYLE_LABEL: Record<AvatarStyle, string> = {
  notionists: "Notionists",
  "notionists-neutral": "Notionists neutral",
  lorelei: "Lorelei",
  "lorelei-neutral": "Lorelei neutral",
  "open-peeps": "Open peeps",
};

type Avatar = AgentView["avatar"];

/** Change a custom agent's face. Only the face is saved; the rest of the profile is not sent. */
export function AvatarEditor(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agent: Pick<AgentView, "name" | "avatar">;
  onSave: (patch: { avatar: Avatar }) => Promise<unknown>;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-5 text-fg shadow-2xl">
          {/* Mounted only while open, so each opening starts from the saved face. */}
          <EditorBody {...props} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EditorBody({ agent, onOpenChange, onSave }: Parameters<typeof AvatarEditor>[0]) {
  const [avatar, setAvatar] = useState<Avatar>(agent.avatar);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await onSave({ avatar });
      onOpenChange(false);
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Dialog.Title className="font-semibold">Edit face</Dialog.Title>
      <Dialog.Description className="mt-1 text-xs text-muted">Only the face changes. Shuffle picks a new one in this style.</Dialog.Description>

      <div className="mt-4 flex justify-center">
        <AgentAvatar avatar={avatar} name={agent.name} size="xl" />
      </div>

      <div role="group" aria-label="Style" className="mt-4 grid grid-cols-5 gap-2">
        {AVATAR_STYLES.map((style) => (
          <button
            key={style}
            type="button"
            data-style={style}
            aria-label={STYLE_LABEL[style]}
            aria-pressed={avatar.style === style}
            onClick={() => setAvatar({ ...avatar, style })}
            className="grid place-items-center rounded-md border border-line p-0.5 aria-pressed:border-accent"
          >
            <AgentAvatar avatar={{ style, seed: avatar.seed }} name={STYLE_LABEL[style]} size="lg" />
          </button>
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-5 flex justify-between gap-2">
        <button type="button" className="btn" onClick={() => setAvatar({ ...avatar, seed: randomSeed() })}>
          Shuffle
        </button>
        <div className="flex gap-2">
          <Dialog.Close type="button" className="btn">Cancel</Dialog.Close>
          <button className="btn btn-primary" disabled={saving}>Save</button>
        </div>
      </div>
    </form>
  );
}

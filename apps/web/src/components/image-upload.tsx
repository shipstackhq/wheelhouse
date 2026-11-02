import { useRef, useState } from "react";
import { useServices } from "../lib/services";
import { failure } from "../lib/form-state";
import { Menu, MenuItem, MenuLabel } from "./menu";

const MAX_BYTES = 2 * 1024 * 1024;

/** The picture as base64 (what the API takes), without the `data:` prefix. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Choose, replace or remove a picture: the person's own, or the workspace's. `preview` is what shows now (an initials fallback
 * when there is no image) and is the button that opens the menu; `onSave` and `onRemove` call the API, after which `me` is read
 * again so every place showing it updates.
 */
export function ImageUpload({ label, preview, hasImage, onSave, onRemove }: {
  label: string;
  preview: React.ReactNode;
  hasImage: boolean;
  onSave: (base64: string) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}) {
  const { queryClient } = useServices();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setError(undefined);
    setBusy(true);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (e) {
      setError(failure(e)?.error ?? "Could not save the image");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const choose = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return setError("Use a PNG, JPEG, WebP or GIF image");
    if (file.size > MAX_BYTES) return setError("The image is too large (2 MB at most)");
    return run(async () => onSave(await toBase64(file)));
  };
  return (
    <div className="space-y-1">
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label={label} className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
      <Menu
        align="end"
        trigger={
          <button type="button" aria-label={`Change ${label.toLowerCase()}`} disabled={busy} className="block rounded-full outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50">
            {preview}
          </button>
        }
      >
        <MenuLabel>PNG, JPEG, WebP or GIF, 2 MB at most</MenuLabel>
        <MenuItem onSelect={() => input.current?.click()}>{hasImage ? "Change image" : "Upload image"}</MenuItem>
        {hasImage && (
          <MenuItem danger onSelect={() => void run(onRemove)}>
            Remove
          </MenuItem>
        )}
      </Menu>
      {error && <p className="text-right text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

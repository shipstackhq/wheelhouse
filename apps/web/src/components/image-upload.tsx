import { useRef, useState } from "react";
import { useServices } from "../lib/services";
import { failure } from "../lib/form-state";

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
 * when there is no image); `onSave` and `onRemove` call the API, after which `me` is read again so every place showing it updates.
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
    <div className="flex items-center gap-4">
      <div className="shrink-0">{preview}</div>
      <div className="space-y-1">
        <div className="flex gap-2">
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label={label} className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
          <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
            {hasImage ? "Change image" : "Upload image"}
          </button>
          {hasImage && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => run(onRemove)}>
              Remove
            </button>
          )}
        </div>
        <p className="text-xs text-muted">PNG, JPEG, WebP or GIF, 2 MB at most.</p>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      </div>
    </div>
  );
}

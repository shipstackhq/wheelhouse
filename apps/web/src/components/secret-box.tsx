import { useState } from "react";

export function SecretBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-sm">{value}</code>
      <button
        type="button"
        className="btn py-1"
        onClick={() => {
          navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

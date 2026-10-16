import { useState } from "react";

export function CopyBlock({ value, multiline }: { value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className={`overflow-x-auto rounded-md border border-line bg-bg p-3 pr-20 font-mono text-[12px] ${multiline ? "whitespace-pre-wrap" : ""}`}>
        {value}
      </pre>
      <button
        type="button"
        className="btn absolute right-2 top-2 py-0.5 text-xs"
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

import clsx from "clsx";

/** Up to two capital letters from a name: "Ada Lovelace" is AL, "ada" is A. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length === 1 ? [words[0][0]] : [words[0][0], words[words.length - 1][0]];
  return letters.join("").toUpperCase();
}

/** A person as a small circle of initials; with no name, an empty dashed circle ("nobody"). */
export function Avatar({ name, className }: { name?: string | null; className?: string }) {
  if (!name) return <span aria-hidden className={clsx("inline-block size-5 shrink-0 rounded-full border border-dashed border-muted/60", className)} data-avatar="none" />;
  return (
    <span aria-hidden title={name} className={clsx("inline-grid size-5 shrink-0 place-items-center rounded-full bg-accent/20 text-[10px] font-medium text-accent", className)} data-avatar={name}>
      {initialsOf(name)}
    </span>
  );
}

import { useEffect, useState, useSyncExternalStore } from "react";
import { Switch } from "radix-ui";

type Mode = "system" | "light" | "dark";
const KEY = "wh_theme";

const systemTheme = () => (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

function readMode(): Mode {
  try {
    return (localStorage.getItem(KEY) as Mode) || "system";
  } catch {
    return "system";
  }
}

export function applyTheme(mode: Mode) {
  const resolved = mode === "system" ? systemTheme() : mode;
  document.documentElement.dataset.theme = resolved;
  window.dispatchEvent(new CustomEvent("wheelhouse:theme", { detail: resolved }));
}

/** Resolved theme ("light" | "dark"), live. */
export function useResolvedTheme(): "light" | "dark" {
  // Reads <html data-theme> synchronously on the client (set before first paint by the
  // inline script), so components mounting later (e.g. a popover) never flash the wrong state.
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("wheelhouse:theme", cb);
      return () => window.removeEventListener("wheelhouse:theme", cb);
    },
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    () => "dark",
  );
}

/**
 * Dark mode switch. Until the user flips it, the app follows the OS setting;
 * after that their choice sticks, with a link to go back to following the OS.
 */
export function ThemeSwitch() {
  const resolved = useResolvedTheme();
  const [mode, setMode] = useState<Mode>(() => (typeof window === "undefined" ? "system" : readMode()));

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => readMode() === "system" && applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const choose = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {}
    applyTheme(m);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="theme-switch" className="cursor-pointer text-sm">
          Dark mode
        </label>
        <Switch.Root
          id="theme-switch"
          checked={resolved === "dark"}
          onCheckedChange={(dark) => choose(dark ? "dark" : "light")}
          className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full border border-line bg-panel-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
        >
          <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-fg shadow transition-transform data-[state=checked]:translate-x-[17px] data-[state=checked]:bg-accent-fg" />
        </Switch.Root>
      </div>
      <div className="mt-1 text-xs text-muted">
        {mode === "system" ? (
          "Following your system setting"
        ) : (
          <button className="hover:text-fg hover:underline" onClick={() => choose("system")}>
            Match system instead
          </button>
        )}
      </div>
    </div>
  );
}

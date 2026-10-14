"use client";

import { useEffect, useState } from "react";

type InstallEvent = Event & { prompt: () => Promise<void> };
let deferred: InstallEvent | null = null;

/** Wipe per-user cached pages; call before signing out. */
export async function clearOfflineData() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.active?.postMessage("CLEAR_CACHES");
  } catch {}
}

/** Registers the service worker, shows an offline banner and a "Reload to update" prompt. */
export function PwaRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    const onInstall = (e: Event) => {
      e.preventDefault();
      deferred = e as InstallEvent;
      window.dispatchEvent(new Event("wh-installable"));
    };
    window.addEventListener("beforeinstallprompt", onInstall);

    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((reg) => {
        if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const w = reg.installing;
          w?.addEventListener("statechange", () => {
            if (w.state === "installed" && navigator.serviceWorker.controller) setWaiting(w);
          });
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!reloaded) { reloaded = true; location.reload(); }
      });
    }
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      window.removeEventListener("beforeinstallprompt", onInstall);
    };
  }, []);

  if (!offline && !waiting) return null;
  return (
    <div className="fixed inset-x-0 bottom-3 z-[100] flex justify-center px-3">
      <div role="status" className="flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-2 text-sm shadow-xl">
        {offline && <span>You&apos;re offline — viewing cached pages read-only.</span>}
        {waiting && (
          <>
            <span>A new version is available.</span>
            <button className="font-medium text-accent hover:underline" onClick={() => waiting.postMessage("SKIP_WAITING")}>
              Reload to update
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Menu entry that appears only when the browser offers installation. */
export function InstallButton() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const on = () => setOk(!!deferred);
    on();
    window.addEventListener("wh-installable", on);
    return () => window.removeEventListener("wh-installable", on);
  }, []);
  if (!ok) return null;
  return (
    <button
      type="button"
      onClick={async () => { await deferred?.prompt(); deferred = null; setOk(false); }}
      className="w-full rounded-md px-2 py-1.5 text-left text-sm text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2"
    >
      Install app
    </button>
  );
}

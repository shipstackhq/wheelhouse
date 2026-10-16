export function OfflinePage() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-lg font-semibold">You&apos;re offline</h1>
      <p className="max-w-sm text-sm text-muted">Wheelhouse needs a connection to load this page. Reconnect, then reload.</p>
    </main>
  );
}

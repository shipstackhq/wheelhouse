/**
 * A page that is not ported yet. The shell around it is real (sidebar, switcher, live updates); the body names the ticket that
 * ports it. Replace the stub with the page when that ticket lands.
 */
export function PageStub({ title, owner }: { title: string; owner: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8" data-testid="page-stub" data-owner={owner}>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted">
          This page is ported in {owner}. Until then, use the Next app.
        </p>
      </div>
    </div>
  );
}

export const stub = (title: string, owner: string) => function Stub() {
  return <PageStub title={title} owner={owner} />;
};

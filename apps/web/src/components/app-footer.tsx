/** The end of the home page: the product's name and version, and who it belongs to. */
export function AppFooter() {
  return (
    <footer className="mt-10 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted">
      <span>
        Wheelhouse <span className="tabular-nums">v{__APP_VERSION__}</span>
      </span>
      <span>© {new Date().getFullYear()} Shipstack</span>
    </footer>
  );
}

/** The end of the home page: the product's name and the version it is running. */
export function AppFooter() {
  return (
    <footer className="mt-10 border-t border-line pt-4 text-xs text-muted">
      Wheelhouse <span className="tabular-nums">v{__APP_VERSION__}</span>
    </footer>
  );
}

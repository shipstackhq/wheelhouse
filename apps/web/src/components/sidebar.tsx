import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import clsx from "clsx";
import { Logo } from "./logo";
import { NavLink } from "./nav-link";
import { CloseIcon, MenuIcon } from "./icons";

type ProjectItem = { key: string; name: string };

const SECTIONS = [
  { group: "Work", items: [{ path: "", label: "Board" }, { path: "/activity", label: "Activity" }] },
  {
    group: "Knowledge",
    items: [
      { path: "/map", label: "Map" },
      { path: "/docs", label: "Docs" },
      { path: "/decisions", label: "Decisions" },
      { path: "/glossary", label: "Glossary" },
    ],
  },
  { group: "Code", items: [{ path: "/repos", label: "Repos" }] },
];

const RECENT_KEY = "wh:recent-projects";
const LAST_COOKIE = "wh_last_project";

/** The project last viewed, from the cookie this sidebar writes (the Next app read the same cookie on the server). */
export function readLastProject(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${LAST_COOKIE}=([^;]*)`));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function currentSection(path: string, key: string): string {
  const rest = path.slice(`/p/${key}`.length);
  const first = rest.split("/").filter(Boolean)[0];
  return first ? `/${first}` : "";
}

export function Sidebar({
  projects,
  teamName,
  isAdmin,
  lastProject,
  profile,
}: {
  projects: ProjectItem[];
  teamName: string;
  isAdmin: boolean;
  /** The project to open from the logo; read from the cookie when not given. */
  lastProject?: string | null;
  profile: React.ReactNode;
}) {
  const { pathname: path } = useLocation();
  const navigate = useNavigate();
  const match = path.match(/^\/p\/([^/]+)/);
  const currentKey = match ? decodeURIComponent(match[1]) : null;
  const current = projects.find((p) => p.key === currentKey) ?? null;
  const [open, setOpen] = useState(false); // mobile drawer
  const [switcher, setSwitcher] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Remember the project being viewed (recents + cookie), and close the drawer after navigating.
  useEffect(() => {
    setOpen(false);
    if (!currentKey || !current) return;
    const next = [currentKey, ...readRecent().filter((k) => k !== currentKey)].slice(0, 5);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {}
    document.cookie = `${LAST_COOKIE}=${encodeURIComponent(currentKey)}; path=/; max-age=31536000; samesite=lax`;
    setRecent(next);
  }, [currentKey, current]);

  useEffect(() => setRecent(readRecent()), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcher((v) => !v);
      } else if (e.key === "Escape") setSwitcher(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (switcher) {
      setQuery("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [switcher]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return projects.filter((p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q));
    const byKey = new Map(projects.map((p) => [p.key, p]));
    const rec = recent.map((k) => byKey.get(k)).filter((p): p is ProjectItem => !!p);
    return [...rec, ...projects.filter((p) => !rec.includes(p))];
  }, [query, projects, recent]);

  function go(p: ProjectItem) {
    // Keep the current section when the new project has it; every section exists for every project today.
    const section = currentKey ? currentSection(path, currentKey) : "";
    const known = SECTIONS.some((g) => g.items.some((i) => i.path === section));
    setSwitcher(false);
    navigate(`/p/${p.key}${known ? section : ""}`);
  }

  const last = lastProject === undefined ? readLastProject() : lastProject; // re-read on each render: viewing a project writes the cookie
  const home = last && projects.some((p) => p.key === last) ? `/p/${last}` : "/";

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        onClick={() => setOpen(true)}
        className="fixed left-2 top-2 z-30 rounded-md border border-line bg-panel px-2 py-1 text-sm md:hidden"
      >
        <MenuIcon className="text-lg" />
      </button>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setOpen(false)} />}
      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-40 flex w-56 shrink-0 flex-col border-r border-line bg-panel transition-transform md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-4 py-4">
          <Link to={home}>
            <Logo className="text-sm" compact />
          </Link>
          <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="text-muted md:hidden">
            <CloseIcon className="text-lg" />
          </button>
        </div>
        <div className="px-4 pb-2 text-xs text-muted">{teamName}</div>
        <nav className="flex-1 overflow-y-auto px-2 text-sm">
          <NavLink href="/">Home</NavLink>
          <div className="relative mt-3">
            <button
              type="button"
              onClick={() => setSwitcher(true)}
              className="flex w-full items-center justify-between gap-2 rounded-md border border-line px-2 py-1.5 text-left hover:bg-panel-2"
            >
              <span className="min-w-0 truncate">{current ? current.name : "Select a project"}</span>
              <kbd className="font-mono text-[11px] text-muted">⌘K</kbd>
            </button>
            {switcher && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSwitcher(false)} />
                <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-line bg-panel p-1 shadow-lg">
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setCursor(0);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setCursor((c) => Math.min(c + 1, results.length - 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setCursor((c) => Math.max(c - 1, 0));
                      } else if (e.key === "Enter" && results[cursor]) go(results[cursor]);
                    }}
                    placeholder="Search projects…"
                    className="mb-1 w-full rounded bg-panel-2 px-2 py-1 text-sm outline-none"
                  />
                  <div className="max-h-64 overflow-y-auto">
                    {!query && recent.length > 0 && <div className="px-2 py-1 text-[11px] text-muted">Recent</div>}
                    {results.map((p, i) => (
                      <button
                        key={p.key}
                        type="button"
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => go(p)}
                        className={clsx("flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left", i === cursor && "bg-panel-2")}
                      >
                        <span className="truncate">{p.name}</span>
                        <span className="font-mono text-[11px] text-muted">{p.key}</span>
                      </button>
                    ))}
                    {results.length === 0 && <div className="px-2 py-1.5 text-muted">No projects match.</div>}
                  </div>
                  <Link
                    to="/projects/new"
                    onClick={() => setSwitcher(false)}
                    className="mt-1 block rounded border-t border-line px-2 py-1.5 text-muted hover:bg-panel-2 hover:text-fg"
                  >
                    + New project
                  </Link>
                </div>
              </>
            )}
          </div>
          {current &&
            SECTIONS.map((g) => (
              <div key={g.group}>
                <div className="label mt-4 px-2 normal-case tracking-normal">{g.group}</div>
                {g.items.map((i) => (
                  <NavLink key={i.path} href={`/p/${current.key}${i.path}`} prefix={i.path !== ""}>
                    {i.label}
                  </NavLink>
                ))}
              </div>
            ))}
          <div className="label mt-5 px-2 normal-case tracking-normal">Team</div>
          <NavLink href="/team">Members</NavLink>
          <NavLink href="/agents">Agents &amp; API keys</NavLink>
          {isAdmin && (
            <>
              <div className="label mt-5 px-2 normal-case tracking-normal">Admin</div>
              <NavLink href="/admin/teams">Teams</NavLink>
              <NavLink href="/admin/invites">Invite a new team</NavLink>
            </>
          )}
        </nav>
        <div className="border-t border-line p-2">{profile}</div>
      </aside>
    </>
  );
}

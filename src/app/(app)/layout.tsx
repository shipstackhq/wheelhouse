import Link from "next/link";
import { requireHuman } from "@/lib/auth";
import { listProjects } from "@/lib/service";
import { Logo } from "@/components/logo";
import { logout } from "../actions";
import { NavLink } from "@/components/nav-link";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, team, membership, actor } = await requireHuman();
  const projects = await listProjects(actor);
  return (
    <div className="flex h-dvh">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
        <Link href="/" className="px-4 py-4">
          <Logo className="text-sm" />
        </Link>
        <div className="px-4 pb-2 text-xs text-muted">{team.name}</div>
        <nav className="flex-1 overflow-y-auto px-2 text-sm">
          <div className="label mt-3 px-2">Projects</div>
          {projects.map((p) => (
            <NavLink key={p.id} href={`/p/${p.key}`} prefix>
              <span className="font-mono text-[11px] text-muted">{p.key}</span> {p.name}
            </NavLink>
          ))}
          <NavLink href="/">+ New project</NavLink>
          <div className="label mt-5 px-2">Team</div>
          <NavLink href="/team">Members</NavLink>
          <NavLink href="/agents">Agents &amp; API keys</NavLink>
        </nav>
        <div className="border-t border-line p-3 text-xs">
          <div className="truncate text-fg">{user.name}</div>
          <div className="truncate text-muted">
            {user.email} · {membership.role}
          </div>
          <form action={logout} className="mt-2">
            <button className="text-muted hover:text-fg">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}

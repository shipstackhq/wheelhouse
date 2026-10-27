import Link from "next/link";
import { requireHuman } from "@/lib/auth";
import { listProjects } from "@/lib/service";
import { Logo } from "@/components/logo";
import { NavLink } from "@/components/nav-link";
import { ProfileMenu } from "@/components/profile-menu";
import { isInstanceAdmin } from "@/lib/auth-policy";

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
          <NavLink href="/">Dashboard</NavLink>
          <NavLink href="/ideas" prefix>Ideas</NavLink>
          <div className="label mt-4 px-2 normal-case tracking-normal">Projects</div>
          {projects.map((p) => (
            <NavLink key={p.id} href={`/p/${p.key}`} prefix>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate">{p.name}</span>
                <span className="font-mono text-[11px] text-muted">{p.key}</span>
              </span>
            </NavLink>
          ))}
          <NavLink href="/projects/new">+ New project</NavLink>
          <div className="label mt-5 px-2 normal-case tracking-normal">Team</div>
          <NavLink href="/team">Members</NavLink>
          <NavLink href="/agents">Agents &amp; API keys</NavLink>
          {isInstanceAdmin(user.email) && (
            <>
              <div className="label mt-5 px-2 normal-case tracking-normal">Admin</div>
              <NavLink href="/admin/teams">Teams</NavLink>
              <NavLink href="/admin/invites">Invite a new team</NavLink>
            </>
          )}
        </nav>
        <div className="border-t border-line p-2">
          <ProfileMenu name={user.name} email={user.email} role={membership.role} tags={membership.tags} team={team.name} />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}

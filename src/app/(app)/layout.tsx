import { Suspense } from "react";
import { cookies } from "next/headers";
import { requireHuman } from "@/lib/auth";
import { listProjects } from "@/lib/service";
import { Sidebar } from "@/components/sidebar";
import { ProfileMenu } from "@/components/profile-menu";
import { NavigationProgress } from "@/components/navigation-progress";
import { isInstanceAdmin } from "@/lib/auth-policy";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, team, membership, actor } = await requireHuman();
  const projects = await listProjects(actor);
  return (
    <div className="flex h-dvh">
      <Suspense fallback={null}>
        <NavigationProgress />
      </Suspense>
      <Sidebar
        projects={projects.map((p) => ({ key: p.key, name: p.name }))}
        teamName={team.name}
        isAdmin={isInstanceAdmin(user.email)}
        lastProject={(await cookies()).get("wh_last_project")?.value ?? null}
        profile={<ProfileMenu name={user.name} email={user.email} role={membership.role} tags={membership.tags} team={team.name} />}
      />
      <main className="min-w-0 flex-1 overflow-hidden pt-10 md:pt-0">{children}</main>
    </div>
  );
}

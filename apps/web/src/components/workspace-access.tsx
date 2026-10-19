import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AuditEvent } from "@wheelhouse/api-client";
import { failure } from "../lib/form-state";
import { auditQuery, workspaceProjectsQuery } from "../lib/queries";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";

/** Every project of the workspace by name, with who administers it. An owner or admin joins one as its admin; nothing inside it is shown here. */
export function ProjectsAccess() {
  const { api, queryClient } = useServices();
  const query = useQuery(workspaceProjectsQuery(api));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const join = async (key: string) => {
    setError(undefined);
    setBusy(key);
    try {
      await api.projects.join(key);
    } catch (e) {
      setError(failure(e)?.error);
    }
    setBusy(undefined);
    await refreshAll(queryClient);
  };
  const projects = query.data ?? [];
  return (
    <div className="card p-5">
      <h2 className="font-medium">Projects</h2>
      <p className="mt-1 text-sm text-muted">
        Everyone in the workspace sees nothing of a project until they are added to it. You can see each project&apos;s name and admins, and join one as its admin. Joining is recorded in the access log and shown in the project&apos;s activity.
      </p>
      {query.isError && <p className="mt-3 text-sm text-danger" role="alert">Could not load the projects.</p>}
      {query.isSuccess && projects.length === 0 && <p className="mt-3 text-sm text-muted">No projects yet.</p>}
      <ul className="mt-3 divide-y divide-line">
        {projects.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
            <div className="min-w-40 flex-1">
              <span className="font-medium">{p.name}</span> <span className="font-mono text-xs text-muted">{p.key}</span>
              <div className="text-xs text-muted">
                {p.memberCount} {p.memberCount === 1 ? "member" : "members"} · admin{p.admins.length === 1 ? "" : "s"}: {p.admins.length ? p.admins.join(", ") : "none"}
              </div>
            </div>
            {p.isMember ? (
              <span className="chip bg-panel-2 text-fg">you are in</span>
            ) : (
              <button className="btn" disabled={busy === p.key} onClick={() => join(p.key)} aria-label={`Join ${p.name} as admin`}>
                Join as admin
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

const LABEL: Record<string, string> = {
  "project.created": "created project",
  "project.member_added": "added to a project",
  "project.member_removed": "removed from a project",
  "project.member_left": "left a project",
  "project.member_role_changed": "changed a project role",
  "project.admin_joined": "joined a project as admin",
  "workspace.member_removed": "removed from the workspace",
  "workspace.role_changed": "changed a workspace role",
};

const detail = (e: AuditEvent) => {
  const a = e.after as { role?: string } | null;
  const b = e.before as { role?: string } | null;
  if (b?.role && a?.role) return `${b.role} → ${a.role}`;
  return a?.role ?? b?.role ?? "";
};

/** The access audit log, newest first: who changed who can open what. Owners and admins only. */
export function AccessLog() {
  const { api } = useServices();
  const query = useQuery(auditQuery(api));
  const events = query.data ?? [];
  return (
    <div className="card p-5">
      <h2 className="font-medium">Access log</h2>
      <p className="mt-1 text-sm text-muted">Who added, removed or re-roled people, and who joined a project as admin. It is never edited or deleted.</p>
      {query.isError && <p className="mt-3 text-sm text-danger" role="alert">Could not load the access log.</p>}
      {query.isSuccess && events.length === 0 && <p className="mt-3 text-sm text-muted">Nothing yet.</p>}
      <ul className="mt-3 divide-y divide-line">
        {events.map((e) => (
          <li key={e.seq} className="py-2 text-sm">
            <span className="font-medium">{e.actorName}</span> {LABEL[e.action] ?? e.action}
            {e.projectKey && <span className="font-mono text-xs text-muted"> {e.projectKey}</span>}
            {detail(e) && <span className="text-muted"> ({detail(e)})</span>}
            <span className="ml-2 text-xs text-muted">{new Date(e.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

import type { StatusRow } from "./teams.repository";
import type { TEAM_ICON_COLORS } from "./team-icon";
import type { StatusRole } from "@wheelhouse/shared/status-roles";

type TeamLike = { id: string; key: string; name: string; description: string; createdAt: Date; icon?: string | null; iconColor?: string | null; role?: string; retiredAt?: Date | null; parentId?: string | null };

/** A team row as the API shows it (`role` only when the list put the caller's role on it). */
export const teamView = (p: TeamLike) => ({ id: p.id, key: p.key, name: p.name, description: p.description, createdAt: p.createdAt, icon: p.icon ?? null, iconColor: p.iconColor ?? null, retired: !!p.retiredAt, parentId: p.parentId ?? null, ...(p.role ? { role: p.role } : {}) });

export type StatusView = {
  id: string;
  name: string;
  role: StatusRole;
  isDefault: boolean;
  color: (typeof TEAM_ICON_COLORS)[number] | null;
  position: number;
  /** How many issues are in it. */
  issueCount: number;
};

/** A status row with the number of issues in it. */
export const statusView = (r: StatusRow, issueCount: number): StatusView => ({ id: r.id, name: r.name, role: r.role, isDefault: r.isDefault, color: r.color, position: r.position, issueCount });

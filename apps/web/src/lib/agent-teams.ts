import { canManagePeople } from "./roles";
import { useMe, useTeams } from "./session";

/** Who may change rosters and make agents: workspace owners and admins on every team they are on, team admins on their own. */
export function useAgentRights() {
  const admin = canManagePeople(useMe().data?.role);
  const teams = (useTeams().data ?? []).filter((t) => !t.retired && (admin || t.role === "admin"));
  return { admin, teams, canCreate: admin || teams.length > 0 };
}

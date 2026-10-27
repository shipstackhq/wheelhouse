/** Who performed an action. Every mutation is attributed to one of these. */
export type Actor = {
  kind: "human" | "agent";
  id: string; // user id or api key id
  name: string;
  workspaceId: string;
  /**
   * Set only by Wheelhouse itself for work it does on a workspace's behalf, such as handling a GitHub webhook. A system actor is
   * not a person and not a team member: it reaches only the one team named in `teamId` and nothing else (WH-120).
   */
  system?: true;
  /** System actors only: the one team the work is for. An agent key's teams are in `api_key_teams`, not here. */
  teamId?: string;
  /** Agent keys only: the scopes the key holds. Left out (people, system work), every scope is held. */
  scopes?: string[];
  /** Agents only: the client session making the call (Claude Code session_id), when the call names one. */
  sessionId?: string;
};

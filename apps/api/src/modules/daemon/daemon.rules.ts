import crypto from "node:crypto";
import { isUuid } from "../../common/uuid";
import { str } from "./device-common";

/** Pure rules of the daemon module, no database: the pairing code, branch names, what a capability report may carry. */

// No vowels or look-alikes, so a code is easy to read aloud and never spells a word.
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export function userCode() {
  const pick = () => Array.from(crypto.randomBytes(4), (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join("");
  return `${pick()}-${pick()}`;
}
export const normalizeUserCode = (v: unknown) => {
  const s = str(v, 20).toUpperCase().replace(/[^A-Z]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
};

export const PAIRING_STARTS_PER_IP = 20;

export const REJECT_REASONS = ["no_free_slot", "unknown_repository", "bad_signature", "expired", "unsupported_model", "not_ready"] as const;

/** The position a device resumes from: its Last-Event-ID header. */
export function parseLastEventId(v: string | null | undefined): number | null {
  return v != null && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : null;
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** `wh/WH-12-fix-the-login-3f2a1c`: the issue ref (so the GitHub App links it), its title, and a bit of the job id, since an issue can run again. */
export const jobBranch = (ref: string, title: string, jobId: string) => `wh/${[ref, slugify(title), jobId.replace(/-/g, "").slice(0, 6)].filter(Boolean).join("-")}`;

/** A branch name a run may start from: what git accepts, without the tricks (`..`, a leading `-`, `@{`). */
export function validBaseBranch(v: unknown): string | null {
  const s = str(v, 200);
  if (!s || !/^[A-Za-z0-9._\/-]+$/.test(s) || s.startsWith("-") || s.startsWith("/") || s.endsWith("/") || s.endsWith(".lock") || s.includes("..") || s.includes("//")) return null;
  return s;
}

/** Keep only what Wheelhouse uses from a capability report, with bounded sizes; anything else the daemon sends is dropped. */
export function cleanCapabilities(v: unknown): Record<string, unknown> {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const c = (o.claude && typeof o.claude === "object" ? o.claude : {}) as Record<string, unknown>;
  const repos = Array.isArray(o.repositories) ? o.repositories : [];
  const power = (o.power && typeof o.power === "object" ? o.power : {}) as Record<string, unknown>;
  return {
    claude: {
      installed: c.installed === true,
      version: str(c.version, 40) || null,
      signedIn: c.signedIn === true,
      subscriptionType: str(c.subscriptionType, 40) || null,
      models: Array.isArray(c.models) ? c.models.map((m) => str(m, 60)).filter(Boolean).slice(0, 20) : [],
    },
    repositories: repos
      .slice(0, 200)
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
      .filter((r) => isUuid(r.repositoryId))
      .map((r) => ({ repositoryId: r.repositoryId as string, source: r.source === "link" ? "link" : "clone" })),
    platform: str(o.platform, 40) || null,
    power: { onBattery: power.onBattery === true },
  };
}

// ───────── learnings (WH-124) ─────────

/** The most learnings an agent keeps for one team. */
export const LEARNINGS_CAP = 20;
export const NOTE_MAX = 300;

/** What a run proposes at its end, cleaned: a few short one-line notes, never more than three a run. */
export function proposedLearnings(v: unknown): string[] {
  return [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").map((x) => x.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX)).filter(Boolean))].slice(0, 3);
}

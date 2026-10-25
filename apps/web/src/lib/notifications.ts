import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@wheelhouse/api-client";
import { useNavigate } from "react-router";
import { useServices } from "./services";

/** One inbox item as /api/app/notifications lists it. */
export type InboxItem = {
  id: string;
  teamId: string | null;
  type: string;
  source: string;
  title: string;
  body: string;
  /** How the reader shows `body`: as it is, or as markdown. */
  bodyFormat: "text" | "markdown";
  /** An address inside the app (for example /t/AA?t=AA-3), or null when there is nowhere to go. */
  href: string | null;
  actor: { kind: "human" | "agent" | "system"; name: string | null } | null;
  subject: { entity: string; id: string | null } | null;
  readAt: string | null;
  createdAt: string;
  /** Set while the item is in Archived (archive, not delete). */
  archivedAt: string | null;
  /** Set while the item is in Trash. */
  deletedAt: string | null;
  /** When a trashed item is removed for good (30 days after deletion); null when it is not in Trash. */
  purgeAt: string | null;
};
export type InboxPage = { items: InboxItem[]; nextCursor: string | null };
/** The three lists the page shows: what needs a look (inbox), what was set aside (archived), what was deleted (trash). */
export type InboxView = "inbox" | "archived" | "trash";

export const INBOX_PAGE_SIZE = 25;
export const BELL_ITEMS = 5;

/** Everything about the inbox is under "inbox", so one invalidation (a change, a mark, the live signal) refreshes the list and the count together. */
const base = "/api/app/notifications";
export const inboxQuery = (api: ApiClient, unreadOnly: boolean, limit = INBOX_PAGE_SIZE, view: InboxView = "inbox") => ({
  queryKey: ["inbox", "list", { view, unreadOnly, limit }] as const,
  initialPageParam: null as string | null,
  queryFn: ({ pageParam }: { pageParam: string | null }) => {
    const q = new URLSearchParams({ view, limit: String(limit) });
    if (unreadOnly) q.set("unreadOnly", "true");
    if (pageParam) q.set("cursor", pageParam);
    return api.get<InboxPage>(`${base}?${q}`);
  },
  getNextPageParam: (last: InboxPage) => last.nextCursor,
});
export const unreadCountQuery = (api: ApiClient) => ({ queryKey: ["inbox", "count"] as const, queryFn: async () => (await api.get<{ count: number }>(`${base}/unread-count`)).count });

export const useInbox = (unreadOnly: boolean, limit?: number, view?: InboxView) => useInfiniteQuery(inboxQuery(useServices().api, unreadOnly, limit, view));
export const useUnreadCount = () => useQuery(unreadCountQuery(useServices().api));

/** Mark one read, mark everything read, and move one between the inbox, Archived and Trash. Every change refreshes all of "inbox". */
export function useInboxActions() {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["inbox"] });
  const at = (id: string, action: string) => `${base}/${encodeURIComponent(id)}/${action}`;
  const markRead = useMutation({ mutationFn: (id: string) => api.post(at(id, "read")), onSettled: refresh });
  const markAllRead = useMutation({ mutationFn: () => api.post(`${base}/read-all`), onSettled: refresh });
  const archive = useMutation({ mutationFn: (id: string) => api.post(at(id, "archive")), onSettled: refresh });
  const unarchive = useMutation({ mutationFn: (id: string) => api.post(at(id, "unarchive")), onSettled: refresh });
  /** A soft delete: the item goes to Trash and can be restored until its purgeAt. */
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`${base}/${encodeURIComponent(id)}`), onSettled: refresh });
  const restore = useMutation({ mutationFn: (id: string) => api.post(at(id, "restore")), onSettled: refresh });
  return { markRead, markAllRead, archive, unarchive, remove, restore };
}

/** Clicking an item in the bell marks it read and opens it in the inbox's reader. */
export function useOpenItem() {
  const { markRead } = useInboxActions();
  const navigate = useNavigate();
  return (n: InboxItem) => {
    if (!n.readAt) markRead.mutate(n.id);
    void navigate(`/inbox?n=${encodeURIComponent(n.id)}`);
  };
}

/** A markdown body as one line of plain words, for a row that only has room for a snippet: the syntax goes, the words stay. */
export function plainSnippet(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?([\s\S]*?)(```|$)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/(\*\*|__|~~|[*_`])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

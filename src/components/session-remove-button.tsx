"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { removeSessionAction } from "@/app/actions";
import { shortSession } from "./session-row";

/** Teammates remove a session from Wheelhouse (soft delete: if it reconnects it starts at the top of the queue). */
export function SessionRemoveButton({ projectKey, sessionId }: { projectKey: string; sessionId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      title="Remove this session from Wheelhouse"
      aria-label={`Remove session ${shortSession(sessionId)}`}
      className="shrink-0 underline-offset-2 hover:text-danger hover:underline disabled:opacity-50"
      onClick={() => {
        if (!window.confirm(`Remove session ${shortSession(sessionId)} from Wheelhouse?\n\nIf it connects again it starts at the latest changes.`)) return;
        start(async () => {
          await removeSessionAction(projectKey, sessionId);
          router.refresh();
        });
      }}
    >
      remove
    </button>
  );
}

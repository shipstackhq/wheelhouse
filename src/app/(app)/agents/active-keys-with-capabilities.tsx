"use client";

import { useRouter } from "next/navigation";
import { ActiveKeys, type KeyRow } from "@/components/active-keys";

/** Thin client wrapper: ActiveKeys is presentational, this adds the router refresh after a capability toggle. */
export function ActiveKeysWithCapabilities({
  keys,
  markAllSeen,
  revoke,
  setDocsWrite,
}: {
  keys: KeyRow[];
  markAllSeen: (formData: FormData) => void | Promise<void>;
  revoke: (formData: FormData) => void | Promise<void>;
  setDocsWrite: (keyId: string, canWrite: boolean) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();
  return (
    <ActiveKeys
      keys={keys}
      markAllSeen={markAllSeen}
      revoke={revoke}
      setDocsWrite={async (keyId, canWrite) => {
        await setDocsWrite(keyId, canWrite);
        router.refresh();
      }}
    />
  );
}

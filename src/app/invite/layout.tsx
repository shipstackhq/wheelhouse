import type { Metadata } from "next";
import { Logo } from "@/components/logo";

// The link carries a secret in its fragment: never index it, never send it as a referrer.
export const metadata: Metadata = {
  title: "Join Wheelhouse",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Logo className="text-lg" />
          <p className="mt-2 text-sm text-muted">You have been invited.</p>
        </div>
        <div className="card p-6">{children}</div>
      </div>
    </main>
  );
}

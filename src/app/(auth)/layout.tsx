import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { Logo } from "@/components/logo";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await currentUser()) redirect("/");
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Logo className="text-lg" />
          <p className="mt-2 text-sm text-muted">The board your team and your AI agents share.</p>
        </div>
        <div className="card p-6">{children}</div>
      </div>
    </main>
  );
}

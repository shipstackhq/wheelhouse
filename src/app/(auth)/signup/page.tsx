import Link from "next/link";
import { signupAllowed } from "@/lib/auth";
import { AuthForm } from "../auth-form";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  if (!(await signupAllowed())) {
    return (
      <div className="space-y-3 text-center text-sm">
        <p>Signups are closed on this server.</p>
        <p className="text-muted">Invite only. Ask for an invite link, then sign in.</p>
        <Link className="text-accent" href="/login">Back to sign in</Link>
      </div>
    );
  }
  return <AuthForm mode="signup" />;
}

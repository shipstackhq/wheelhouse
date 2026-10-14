import { signupAllowed } from "@/lib/auth";
import { AuthForm } from "../auth-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  return <AuthForm mode="login" signupOpen={await signupAllowed()} />;
}

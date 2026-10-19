import { useActionState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { SubmitButton } from "../components/submit-button";
import { failure, field, type FormState } from "../lib/form-state";
import { useServices } from "../lib/services";

/** Whether this server lets anyone sign up (the first account always can; after that it is by invite unless the server says otherwise). */
function useSignupOpen() {
  const { api } = useServices();
  return useQuery({ queryKey: ["auth", "options"], queryFn: () => api.auth.options(), staleTime: 0, retry: false });
}

export function LoginPage() {
  const options = useSignupOpen();
  return <AuthForm mode="login" signupOpen={options.data?.signupOpen} />;
}

export function SignupPage() {
  const options = useSignupOpen();
  if (options.isPending) return <p className="text-center text-sm text-muted">One moment…</p>;
  if (options.data && !options.data.signupOpen) {
    return (
      <div className="space-y-3 text-center text-sm">
        <p>Signups are closed on this server.</p>
        <p className="text-muted">Invite only. Ask for an invite link, then sign in.</p>
        <Link className="text-accent" to="/login">Back to sign in</Link>
      </div>
    );
  }
  return <AuthForm mode="signup" />;
}

/** `signupOpen`: true shows the link to sign up, false says it is invite only, undefined (still asking the server) shows neither. */
export function AuthForm({ mode, signupOpen = true }: { mode: "login" | "signup"; signupOpen?: boolean }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      const me =
        mode === "login"
          ? await api.auth.login({ email: field(fd, "email"), password: field(fd, "password") })
          : await api.auth.signup({ name: field(fd, "name"), email: field(fd, "email"), password: field(fd, "password"), team: field(fd, "team") });
      // Whatever an earlier person's session left in memory goes; the new person's own data is read fresh.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      queryClient.setQueryData(["me"], me);
      await navigate("/", { replace: true });
      return undefined;
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  return (
    <form action={action} className="space-y-4">
      {mode === "signup" && (
        <>
          <div>
            <label className="label" htmlFor="name">Name</label>
            <input className="input" id="name" name="name" required autoComplete="name" />
          </div>
          <div>
            <label className="label" htmlFor="team">Workspace name</label>
            <input className="input" id="team" name="team" placeholder="Acme" />
          </div>
        </>
      )}
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input className="input" id="email" name="email" type="email" required autoComplete="email" />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input
          className="input"
          id="password"
          name="password"
          type="password"
          required
          minLength={mode === "signup" ? 12 : undefined}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
      </div>
      {state?.error && <p className="text-sm text-danger" role="alert">{state.error}</p>}
      <SubmitButton className="btn btn-primary w-full justify-center">{mode === "login" ? "Sign in" : "Create account"}</SubmitButton>
      <p className="text-center text-sm text-muted">
        {mode === "login" ? (
          signupOpen === undefined ? null : signupOpen ? <>No account? <Link className="text-accent" to="/signup">Sign up</Link></> : "Invite only. Ask for an invite link."
        ) : (
          <>Have an account? <Link className="text-accent" to="/login">Sign in</Link></>
        )}
      </p>
    </form>
  );
}

import { useActionState, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "../components/icons";
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

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/** `signupOpen`: true shows the link to sign up, false says it is invite only, undefined (still asking the server) shows neither. */
export function AuthForm({ mode, signupOpen = true }: { mode: "login" | "signup"; signupOpen?: boolean }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      const me =
        mode === "login"
          ? await api.auth.login({ email: field(fd, "email"), password: field(fd, "password") })
          : await api.auth.signup({ name: field(fd, "name"), email: field(fd, "email"), password: field(fd, "password") });
      // Whatever an earlier person's session left in memory goes; the new person's own data is read fresh.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      queryClient.setQueryData(["me"], me);
      await navigate("/", { replace: true });
      return undefined;
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  const label = "mb-1.5 block text-sm font-medium";
  const inputIcon = "pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{mode === "login" ? "Log in to your account" : "Create your account"}</h1>
        <p className="mt-1.5 text-sm text-muted">{mode === "login" ? "Welcome back! Enter your details to continue." : "Start a board for your team and your agents."}</p>
      </div>
      <form action={action} className="space-y-4">
        {mode === "signup" && (
          <>
            <div>
              <label className={label} htmlFor="name">Name</label>
              <input className="input rounded-lg py-2.5" id="name" name="name" required autoComplete="name" />
            </div>
          </>
        )}
        <div>
          <label className={label} htmlFor="email">Email</label>
          <div className="relative">
            <MailIcon className={inputIcon} />
            <input className="input rounded-lg py-2.5 pl-10" id="email" name="email" type="email" required autoComplete="email" />
          </div>
        </div>
        <div>
          <label className={label} htmlFor="password">Password</label>
          <div className="relative">
            <LockIcon className={inputIcon} />
            <input
              className="input rounded-lg py-2.5 pl-10 pr-10"
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              required
              minLength={mode === "signup" ? 12 : undefined}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-fg"
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>
        {state?.error && <p className="text-sm text-danger" role="alert">{state.error}</p>}
        <SubmitButton className="btn btn-primary w-full justify-center rounded-lg py-2.5">{mode === "login" ? "Sign in" : "Create account"}</SubmitButton>
        <div className="flex items-center gap-3 text-xs text-muted" aria-hidden="true">
          <span className="h-px flex-1 bg-line" />
          or continue with
          <span className="h-px flex-1 bg-line" />
        </div>
        {/* A placeholder: sign-in with Google is not built yet, so the button is disabled and submits nothing. */}
        <button type="button" disabled title="Coming soon" className="btn w-full justify-center gap-2 rounded-lg py-2.5">
          <GoogleMark />
          {mode === "login" ? "Sign in with Google" : "Sign up with Google"}
        </button>
        <p className="text-center text-sm text-muted">
          {mode === "login" ? (
            signupOpen === undefined ? null : signupOpen ? <>No account? <Link className="text-accent" to="/signup">Sign up</Link></> : "Invite only. Ask for an invite link."
          ) : (
            <>Have an account? <Link className="text-accent" to="/login">Sign in</Link></>
          )}
        </p>
      </form>
    </div>
  );
}

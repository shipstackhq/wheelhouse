"use client";

import Link from "next/link";
import { useActionState } from "react";
import { login, signup, type FormState } from "../actions";

export function AuthForm({ mode, signupOpen = true }: { mode: "login" | "signup"; signupOpen?: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(mode === "login" ? login : signup, undefined);
  return (
    <form action={action} className="space-y-4">
      {mode === "signup" && (
        <>
          <div>
            <label className="label" htmlFor="name">Name</label>
            <input className="input" id="name" name="name" required autoComplete="name" />
          </div>
          <div>
            <label className="label" htmlFor="team">Team name</label>
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
          minLength={mode === "signup" ? 8 : undefined}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
      </div>
      {state?.error && <p className="text-sm text-danger">{state.error}</p>}
      <button className="btn btn-primary w-full" disabled={pending}>
        {pending ? "…" : mode === "login" ? "Sign in" : "Create account"}
      </button>
      <p className="text-center text-sm text-muted">
        {mode === "login" ? (
          signupOpen ? <>No account? <Link className="text-accent" href="/signup">Sign up</Link></> : "Ask a team owner to add you."
        ) : (
          <>Have an account? <Link className="text-accent" href="/login">Sign in</Link></>
        )}
      </p>
    </form>
  );
}

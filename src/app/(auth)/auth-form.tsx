"use client";

import Link from "next/link";
import { useActionState } from "react";
import { login, signup, type FormState } from "../actions";
import { SubmitButton } from "@/components/submit-button";

export function AuthForm({ mode, signupOpen = true }: { mode: "login" | "signup"; signupOpen?: boolean }) {
  const [state, action] = useActionState<FormState, FormData>(mode === "login" ? login : signup, undefined);
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
          minLength={mode === "signup" ? 12 : undefined}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
      </div>
      {state?.error && <p className="text-sm text-danger">{state.error}</p>}
      <SubmitButton className="btn btn-primary w-full justify-center">{mode === "login" ? "Sign in" : "Create account"}</SubmitButton>
      <p className="text-center text-sm text-muted">
        {mode === "login" ? (
          signupOpen ? <>No account? <Link className="text-accent" href="/signup">Sign up</Link></> : "Invite only. Ask for an invite link."
        ) : (
          <>Have an account? <Link className="text-accent" href="/login">Sign in</Link></>
        )}
      </p>
    </form>
  );
}

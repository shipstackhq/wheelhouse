import { useActionState, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { InvitePeek } from "@wheelhouse/api-client";
import { SubmitButton } from "../components/submit-button";
import { failure, field, type FormState } from "../lib/form-state";
import { useServices } from "../lib/services";
import { errorText } from "../components/query-state";

type Phase = { name: "loading" } | { name: "missing" } | { name: "bad"; message: string } | { name: "ready"; invite: InvitePeek };

/**
 * The token lives in the URL fragment, which browsers never send to a server. We read it here, take it out of
 * the address bar, and send it only in the body of the two requests.
 */
export function InvitePage() {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const [token, setToken] = useState("");
  const started = useRef(false);
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      const me = await api.invites.accept({ token: field(fd, "token"), name: field(fd, "name"), password: field(fd, "password"), confirm: field(fd, "confirm") });
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      queryClient.setQueryData(["me"], me);
      await navigate("/", { replace: true });
      return undefined;
    } catch (e) {
      return failure(e);
    }
  }, undefined);

  useEffect(() => {
    if (started.current) return; // React strict mode runs effects twice in development
    started.current = true;
    const t = window.location.hash.replace(/^#/, "");
    window.history.replaceState(null, "", window.location.pathname);
    if (!t) return setPhase({ name: "missing" });
    setToken(t);
    api.invites
      .peek(t)
      .then((invite) => setPhase({ name: "ready", invite }))
      .catch((e) => setPhase({ name: "bad", message: e instanceof Error && "status" in e ? errorText(e) : "Something went wrong. Try the link again." }));
  }, [api]);

  if (phase.name === "loading") return <p className="text-center text-sm text-muted">Checking your invite…</p>;
  if (phase.name === "missing")
    return (
      <div className="space-y-3 text-center text-sm">
        <p>This page needs the full invite link you were sent.</p>
        <p className="text-muted">Open that link again, including everything after the # sign.</p>
      </div>
    );
  if (phase.name === "bad")
    return (
      <div className="space-y-3 text-center text-sm">
        <p>{phase.message}</p>
        <p className="text-muted">Ask the person who invited you for a new link.</p>
        <Link className="text-accent" to="/login">Go to sign in</Link>
      </div>
    );

  const { invite } = phase;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <p className="text-sm text-muted">
        {invite.kind === "new_team"
          ? `Create your account and your team${invite.teamName ? `, ${invite.teamName}` : ""}.`
          : `Create your account to join ${invite.teamName ?? "the team"}.`}
      </p>
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input className="input" id="email" type="email" value={invite.email} readOnly aria-readonly />
      </div>
      <div>
        <label className="label" htmlFor="name">Your name</label>
        <input className="input" id="name" name="name" required maxLength={100} autoComplete="name" />
      </div>
      <div>
        <label className="label" htmlFor="password">Password (12+ characters)</label>
        <input className="input" id="password" name="password" type="password" required minLength={12} autoComplete="new-password" />
      </div>
      <div>
        <label className="label" htmlFor="confirm">Repeat password</label>
        <input className="input" id="confirm" name="confirm" type="password" required minLength={12} autoComplete="new-password" />
      </div>
      {state?.error && <p className="text-sm text-danger" role="alert">{state.error}</p>}
      <SubmitButton className="btn btn-primary w-full justify-center">Create account</SubmitButton>
    </form>
  );
}

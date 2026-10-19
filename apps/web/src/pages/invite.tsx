import { useActionState, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, type InvitePeek, type InvitePeekExisting } from "@wheelhouse/api-client";
import { SubmitButton } from "../components/submit-button";
import { failure, field, type FormState } from "../lib/form-state";
import { useServices } from "../lib/services";
import { errorText } from "../components/query-state";

type Phase =
  | { name: "loading" }
  | { name: "missing" }
  | { name: "bad"; message: string; signedOut?: boolean }
  | { name: "ready"; invite: InvitePeek }
  | { name: "existing"; invite: InvitePeekExisting };

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
      .catch(async (e) => {
        const message = e instanceof Error && "status" in e ? errorText(e) : "Something went wrong. Try the link again.";
        // Not an invite for a new account. If someone with an account is signed in and it is addressed to them, they can join with it.
        try {
          setPhase({ name: "existing", invite: await api.invites.peekExisting(t) });
        } catch (e2) {
          setPhase({ name: "bad", message, signedOut: e2 instanceof ApiError && e2.status === 401 });
        }
      });
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
        {phase.signedOut && <p className="text-muted">Already have an account on this server? Sign in with the email this invite was sent to, then open the link again.</p>}
        <Link className="text-accent" to="/login">Go to sign in</Link>
      </div>
    );

  if (phase.name === "existing") return <JoinExisting invite={phase.invite} token={token} />;

  const { invite } = phase;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <p className="text-sm text-muted">
        {invite.kind === "new_workspace"
          ? `Create your account and your workspace${invite.workspaceName ? `, ${invite.workspaceName}` : ""}.`
          : `Create your account to join ${invite.workspaceName ?? "the workspace"}.`}
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

/** A signed-in person is invited to another workspace with the account they already have. */
function JoinExisting({ invite, token }: { invite: InvitePeekExisting; token: string }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const [state, action] = useActionState<FormState, FormData>(async () => {
    try {
      await api.invites.acceptExisting(token);
      // Everything read so far belongs to the workspace they were in: drop it all, and the person's own record too (the workspace changed).
      queryClient.clear();
      await navigate("/", { replace: true });
      return undefined;
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  return (
    <form action={action} className="space-y-4">
      <p className="text-sm">
        You are signed in as <span className="font-medium">{invite.email}</span>. Join <span className="font-medium">{invite.workspaceName}</span> as {invite.role}
        {invite.projects.length > 0 && <>, in {invite.projects.map((p) => `${p.name} (${p.role})`).join(", ")}</>}?
      </p>
      <p className="text-sm text-muted">You keep your account and your other workspaces; you can switch between them from the account menu.</p>
      {state?.error && <p className="text-sm text-danger" role="alert">{state.error}</p>}
      <SubmitButton className="btn btn-primary w-full justify-center">Join {invite.workspaceName}</SubmitButton>
    </form>
  );
}

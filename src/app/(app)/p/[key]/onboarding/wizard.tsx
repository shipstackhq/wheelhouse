"use client";

import { useActionState, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { createConceptFromDescriptionAction, createInviteAction, type FormState } from "@/app/actions";
import { SetupGuide } from "@/components/setup-guide";
import { CopyBlock } from "@/components/copy-block";
import { SubmitButton } from "@/components/submit-button";
import { SecretBox } from "@/components/secret-box";
import { Select } from "@/components/ui";
import type { onboarding } from "@/lib/onboarding";

type Cmd = ReturnType<typeof onboarding>;
type CodeLocation = "github" | "local" | "none" | "skip" | null;

const STEPS = ["Code location", "Connect agents", "First map", "Invite teammates"] as const;

/**
 * The onboarding wizard (WH-69). Step 1 of the ticket (name/description) is covered by the new-project form
 * before this page is reached, so the wizard itself starts at "where does your code live" and runs through to
 * inviting teammates. Steps 3 ("first map") and 2 ("code location") are merged for the no-code path, since the
 * no-code placeholder (a short description -> one concept node) covers both at once; every other path keeps them
 * separate as the ticket lays out. Every step can be skipped — "Skip to board" always escapes the wizard.
 */
export function OnboardingWizard({
  projectKey,
  projectName,
  hasRepos,
  cmd,
  githubConnect,
  localRepos,
}: {
  projectKey: string;
  projectName: string;
  hasRepos: boolean;
  cmd: Cmd;
  githubConnect: ReactNode;
  localRepos: ReactNode;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [codeLocation, setCodeLocation] = useState<CodeLocation>(hasRepos ? "github" : null);

  const finish = () => router.push(`/p/${projectKey}`);
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const emphasize = codeLocation === "none" || codeLocation === "skip" ? "mcp" : codeLocation === "github" || codeLocation === "local" ? "plugin" : undefined;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="chip bg-accent/15 font-mono text-accent">{projectKey}</span>{" "}
              <span className="font-medium">{projectName}</span>
            </div>
            <button className="text-sm text-muted hover:text-fg" onClick={finish}>
              Skip to board →
            </button>
          </div>
          <ol className="mt-4 flex flex-wrap gap-2 text-xs">
            {STEPS.map((label, i) => (
              <li
                key={label}
                className={clsx(
                  "chip",
                  i === step ? "bg-accent/15 text-accent" : i < step ? "bg-ok/15 text-ok" : "bg-panel-2 text-muted",
                )}
              >
                {i + 1}. {label}
              </li>
            ))}
          </ol>
        </div>

        {step === 0 && (
          <CodeLocationStep
            value={codeLocation}
            onChange={setCodeLocation}
            onNext={next}
            githubConnect={githubConnect}
            localRepos={localRepos}
            projectKey={projectKey}
          />
        )}
        {step === 1 && <ConnectAgentsStep cmd={cmd} emphasize={emphasize} onBack={back} onNext={next} />}
        {step === 2 && <FirstMapStep codeLocation={codeLocation} cmd={cmd} onBack={back} onNext={next} />}
        {step === 3 && <InviteStep onBack={back} onFinish={finish} />}
      </div>
    </div>
  );
}

function StepNav({ onBack, onNext, nextLabel = "Continue" }: { onBack?: () => void; onNext: () => void; nextLabel?: string }) {
  return (
    <div className="flex gap-2">
      {onBack && (
        <button className="btn" onClick={onBack}>
          Back
        </button>
      )}
      <button className="btn btn-primary" onClick={onNext}>
        {nextLabel}
      </button>
    </div>
  );
}

function CodeLocationStep({
  value,
  onChange,
  onNext,
  githubConnect,
  localRepos,
  projectKey,
}: {
  value: CodeLocation;
  onChange: (v: CodeLocation) => void;
  onNext: () => void;
  githubConnect: ReactNode;
  localRepos: ReactNode;
  projectKey: string;
}) {
  const [noCodeState, noCodeAction] = useActionState<FormState, FormData>(createConceptFromDescriptionAction, undefined);
  const options: { id: Exclude<CodeLocation, null>; label: string; hint: string }[] = [
    { id: "github", label: "Connect GitHub", hint: "One or more repositories; pushes and PRs are reported automatically." },
    { id: "local", label: "Local or another Git host", hint: "Link through Claude Code (/wheelhouse:setup) or the CLI." },
    { id: "none", label: "No code yet", hint: "Just an idea so far — write a few sentences and we'll start the map." },
    { id: "skip", label: "Skip for now", hint: "Decide later from the project's Repos tab." },
  ];
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Where does your code live?</h2>
        <p className="mt-1 text-sm text-muted">This decides how we track what lands against this project.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <button
            key={o.id}
            className={clsx(
              "card cursor-pointer p-4 text-left transition-colors hover:border-muted/60 hover:bg-panel-2/60",
              value === o.id && "border-accent ring-1 ring-accent/40",
            )}
            onClick={() => onChange(o.id)}
          >
            <div className="font-medium">{o.label}</div>
            <div className="mt-1 text-xs text-muted">{o.hint}</div>
          </button>
        ))}
      </div>

      {value === "github" && <div>{githubConnect}</div>}
      {value === "local" && <div>{localRepos}</div>}
      {value === "none" && (
        <form action={noCodeAction} className="card space-y-3 p-5">
          <input type="hidden" name="projectKey" value={projectKey} />
          <label className="label" htmlFor="description">
            What are you building? A few sentences is enough.
          </label>
          <textarea className="input" id="description" name="description" rows={4} placeholder="A tool that imports vendor invoices, normalizes them, and..." />
          {noCodeState?.error && <p className="text-sm text-danger">{noCodeState.error}</p>}
          {noCodeState?.ok && <p className="text-sm text-ok">{noCodeState.ok}</p>}
          <SubmitButton className="btn btn-primary">Start the map</SubmitButton>
        </form>
      )}

      <StepNav onNext={onNext} nextLabel={value ? "Continue" : "Skip for now"} />
    </div>
  );
}

function ConnectAgentsStep({ cmd, emphasize, onBack, onNext }: { cmd: Cmd; emphasize?: "plugin" | "mcp" | "cli"; onBack: () => void; onNext: () => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Connect your agents</h2>
        <p className="mt-1 text-sm text-muted">So Claude Code (or any other client) can read the board and map for this project.</p>
      </div>
      <SetupGuide cmd={cmd} emphasize={emphasize} />
      <StepNav onBack={onBack} onNext={onNext} />
    </div>
  );
}

function FirstMapStep({ codeLocation, cmd, onBack, onNext }: { codeLocation: CodeLocation; cmd: Cmd; onBack: () => void; onNext: () => void }) {
  const hasCode = codeLocation === "github" || codeLocation === "local";
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">First map</h2>
        <p className="mt-1 text-sm text-muted">
          {hasCode
            ? "With the repository connected, build the map once so people can understand the codebase without reading it."
            : "No code yet — the concept you wrote in the previous step already seeded the map's concept layer. Connect a repository later and link real code to it without redoing this."}
        </p>
      </div>
      {hasCode && (
        <div className="card space-y-2 p-5">
          <CopyBlock value={cmd.buildMap} multiline />
          <p className="text-sm text-muted">
            Map the schema only if the repo has a database. Run this from Claude Code in the repository, once the setup from the previous step is done.
          </p>
        </div>
      )}
      <StepNav onBack={onBack} onNext={onNext} />
    </div>
  );
}

function InviteStep({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const [state, action] = useActionState<FormState, FormData>(createInviteAction, undefined);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Invite teammates</h2>
        <p className="mt-1 text-sm text-muted">Send a one-time invite link. You can always invite more people later from Team settings.</p>
      </div>
      <form action={action} className="card grid gap-3 p-5 sm:grid-cols-2">
        <input type="hidden" name="kind" value="join_team" />
        <input className="input sm:col-span-2" name="email" type="email" placeholder="Their email" required />
        <Select name="role" defaultValue="member" options={[{ value: "member", label: "member" }, { value: "owner", label: "owner" }]} />
        <input className="input" name="tags" placeholder="tags: backend, design" />
        {state?.error && <p className="text-sm text-danger sm:col-span-2">{state.error}</p>}
        {state?.ok && (
          <div className="sm:col-span-2">
            <p className="text-sm text-ok">{state.ok}</p>
            {state.secret && <SecretBox value={state.secret} />}
          </div>
        )}
        <div className="sm:col-span-2">
          <SubmitButton className="btn btn-primary">Create invite link</SubmitButton>
        </div>
      </form>
      <div className="flex gap-2">
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <button className="btn btn-primary" onClick={onFinish}>
          Done — go to board
        </button>
      </div>
    </div>
  );
}

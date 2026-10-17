import { useState, useTransition } from "react";
import { Dialog } from "radix-ui";
import { linkifyRefs } from "@wheelhouse/core/lib/map-shared";
import { describeFailure } from "../lib/form-state";
import { useServices } from "../lib/services";
import { Markdown } from "./markdown";

type QA = { q: string; a?: string; error?: string; truncated?: boolean };

export function AskDialog(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectKey: string;
  enabled: boolean;
  focus?: { id: string; name: string; layer: string } | null;
  onLink: (href: string) => boolean;
}) {
  const { focus } = props;
  const { api } = useServices();
  const [q, setQ] = useState("");
  const [history, setHistory] = useState<QA[]>([]);
  const [pending, start] = useTransition();

  const ask = (question: string) => {
    if (!question.trim() || pending) return;
    setQ("");
    setHistory((h) => [...h, { q: question }]);
    start(async () => {
      // Claude is called from the server with the server's own key; all that comes back is the answer, or a plain reason it failed.
      let result: QA;
      try {
        const res = await api.map.ask(props.projectKey, question, focus?.id);
        result = { q: question, a: res.answer, truncated: res.truncated };
      } catch (e) {
        result = { q: question, error: describeFailure(e) };
      }
      setHistory((h) => {
        const copy = [...h];
        copy[copy.length - 1] = result;
        return copy;
      });
    });
  };

  const suggestions = focus
    ? [`What does ${focus.name} do and why does it exist?`, `What would break if I changed ${focus.name}?`, `Walk me through how ${focus.name} fits into the main flows.`]
    : ["Explain this system at a high level.", "What are the main moving parts and how do they talk?", "Where should a new teammate start reading?"];

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(94vw,680px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-panel text-fg shadow-2xl">
          <div className="border-b border-line px-5 py-3">
            <Dialog.Title className="font-semibold">Ask the map{focus ? ` about ${focus.name}` : ""}</Dialog.Title>
            <Dialog.Description className="text-xs text-muted">
              Answered by Claude from the knowledge map (not the code), so gaps in the map show up as gaps in the answer. Each question is answered on its own.
            </Dialog.Description>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {!props.enabled && (
              <p className="rounded-md border border-line bg-bg p-3 text-sm text-muted">
                Ask is off. Set <code className="font-mono">ANTHROPIC_API_KEY</code> on the server to enable it.
              </p>
            )}
            {history.length === 0 && props.enabled && (
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button key={s} className="btn text-xs" onClick={() => ask(s)}>{s}</button>
                ))}
              </div>
            )}
            {history.map((h, i) => (
              <div key={i} className="space-y-2">
                <div className="text-sm font-medium">{h.q}</div>
                {h.a ? (
                  <div className="rounded-md bg-bg/60 p-3">
                    <Markdown
                      onLink={(href) => {
                        const handled = props.onLink(href);
                        if (handled) props.onOpenChange(false);
                        return handled;
                      }}
                    >
                      {linkifyRefs(h.a)}
                    </Markdown>
                    {h.truncated && <p className="mt-2 text-xs text-muted">(answer was cut off)</p>}
                  </div>
                ) : h.error ? (
                  <p className="text-sm text-danger">{h.error}</p>
                ) : (
                  <p className="animate-pulse text-sm text-muted">Reading the map…</p>
                )}
              </div>
            ))}
          </div>
          <form
            className="flex gap-2 border-t border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              ask(q);
            }}
          >
            <input
              autoFocus
              className="input"
              disabled={!props.enabled}
              placeholder={focus ? `Ask about ${focus.name}…` : "Ask about the system…"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button className="btn btn-primary shrink-0" disabled={!q.trim() || pending || !props.enabled}>Ask</button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

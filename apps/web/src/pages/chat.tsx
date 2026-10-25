import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router";
import clsx from "clsx";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ChatMessageView, ChatThreadView } from "@wheelhouse/api-client";
import { timeAgo } from "@wheelhouse/shared/time";
import { AutoGrowTextarea } from "../components/auto-grow-textarea";
import { ClaudeIcon, AddIcon, TrashIcon } from "../components/icons";
import { ColumnDivider, useColumnWidth } from "../components/column-divider";
import { Markdown } from "../components/markdown";
import { Loaded } from "../components/query-state";
import { Select, useDialogs } from "../components/ui";
import { atBottom, chatPollInterval, deviceAvailability, endNote, isBusy, liveLine, resolveNewChat, type NewChatForm } from "../lib/chat";
import { describeFailure } from "../lib/form-state";
import { chatOptionsQuery, chatQuery, chatsQuery, useChats } from "../lib/queries";
import { useServices } from "../lib/services";
import { useTeams } from "../lib/session";

const LIST = { key: "wh:chat:list-width", min: 300, max: 560, initial: 300, step: 16 };

/**
 * `/chat`: ask questions about a repository, answered by Claude on one of your own devices (read-only; see docs/chat.md). The threads
 * are on the left, the open one (or the form for a new one) on the right. Threads refresh from the live stream (components/inbox-live-refresh)
 * and by polling while an answer is being made.
 */
export function ChatLayout() {
  const threads = useChats();
  const { width, dividerProps } = useColumnWidth(LIST);
  return (
    <div className="flex h-full">
      <nav aria-label="Chats" style={{ width }} className="hidden shrink-0 flex-col md:flex">
        <div className="p-2">
          <Link to="/chat" className="btn w-full justify-center gap-1">
            <AddIcon aria-hidden /> New chat
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <Loaded query={threads} label="Loading chats" rows={3}>
            {(chats) => (chats.length === 0 ? <p className="px-2 py-1 text-xs text-muted">No chats yet.</p> : <ThreadList chats={chats} />)}
          </Loaded>
        </div>
      </nav>
      <ColumnDivider label="Resize the chat list" {...dividerProps} />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

function ThreadList({ chats }: { chats: ChatThreadView[] }) {
  return (
    <ul className="space-y-0.5">
      {chats.map((c) => (
        <li key={c.id}>
          <NavLink to={`/chat/${c.id}`} className={({ isActive }) => clsx("block rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/50", isActive ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg")}>
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {c.running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-agent" role="img" aria-label="Answering" />}
            </span>
            <span className="block truncate text-xs text-muted">{c.repositoryName ?? "repository removed"} · {timeAgo(c.updatedAt)}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

/** `/chat` on its own: pick where to ask and ask the first question. */
export function NewChatPane() {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const teams = (useTeams().data ?? []).filter((t) => !t.retired);
  const [form, setForm] = useState<NewChatForm>({ teamKey: "", repositoryId: "", deviceId: "", model: "", message: "" });
  const teamKey = teams.some((t) => t.key === form.teamKey) ? form.teamKey : (teams[0]?.key ?? "");
  const options = useQuery({ ...chatOptionsQuery(api, teamKey), enabled: !!teamKey });
  const { form: chosen, problem } = resolveNewChat({ ...form, teamKey }, options.data);
  const { reason } = deviceAvailability(options.data ?? { devices: [] });
  const set = (patch: Partial<NewChatForm>) => setForm({ ...chosen, ...patch });

  const create = useMutation({
    mutationFn: () => api.chats.create({ ...chosen, message: chosen.message.trim() }),
    onSuccess: (data) => {
      queryClient.setQueryData(chatQuery(api, data.chat.id).queryKey, data);
      void queryClient.invalidateQueries({ queryKey: chatsQuery(api).queryKey });
      void navigate(`/chat/${data.chat.id}`);
    },
  });
  const send = () => !problem && !create.isPending && create.mutate();

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col justify-center gap-4 overflow-y-auto px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">Chat with the codebase</h1>
        <p className="mt-1 text-sm text-muted">Ask about a repository. Claude answers on your own device, read-only: it can read the code but not run commands or change files.</p>
      </div>
      {options.isError && <p className="text-sm text-danger" role="alert">{describeFailure(options.error)}</p>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {teams.length > 1 && <Select className="!w-auto" ariaLabel="Team" value={teamKey} options={teams.map((t) => ({ value: t.key, label: t.name }))} onValueChange={(v) => setForm({ ...chosen, teamKey: v, repositoryId: "" })} />}
        {options.data && options.data.repositories.length > 0 && (
          <Select className="!w-auto" ariaLabel="Repository" value={chosen.repositoryId} options={options.data.repositories.map((r) => ({ value: r.id, label: r.name }))} onValueChange={(v) => set({ repositoryId: v })} />
        )}
        {options.data && (
          <Select
            className="!w-auto"
            ariaLabel="Device"
            value={chosen.deviceId}
            placeholder="No device online"
            options={options.data.devices.map((d) => ({ value: d.id, label: d.status === "online" && d.models.length ? d.name : `${d.name} (offline)` }))}
            onValueChange={(v) => set({ deviceId: v })}
          />
        )}
        {chosen.deviceId && (
          <span className="flex items-center gap-1">
            <ClaudeIcon />
            <Select className="!w-auto" ariaLabel="Model" value={chosen.model} options={(options.data?.devices.find((d) => d.id === chosen.deviceId)?.models ?? []).map((m) => ({ value: m, label: m }))} onValueChange={(v) => set({ model: v })} />
          </span>
        )}
      </div>
      {reason && <p className="text-sm text-muted">{reason}{" "}<Link className="text-accent hover:underline" to="/settings/devices">Devices</Link></p>}
      <Composer
        value={chosen.message}
        onChange={(message) => set({ message })}
        onSend={send}
        busy={create.isPending}
        disabled={!options.data || !chosen.deviceId || !chosen.repositoryId}
        label="Ask about the code"
        error={create.isError ? describeFailure(create.error) : null}
        hint={problem && chosen.message.trim() ? problem : null}
        canSend={!problem}
      />
    </div>
  );
}

/** One message box with its Send (or Stop) button; Enter sends, Shift+Enter makes a new line. */
function Composer(props: { value: string; onChange: (v: string) => void; onSend: () => void; busy?: boolean; disabled?: boolean; canSend: boolean; label: string; error?: string | null; hint?: string | null; onStop?: () => void; placeholder?: string; tools?: ReactNode }) {
  return (
    <div className="space-y-1">
      {props.error && <p className="text-sm text-danger" role="alert">{props.error}</p>}
      <div className="card flex items-end gap-2 p-2">
        <AutoGrowTextarea
          className="max-h-48 min-h-6 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none disabled:text-muted"
          aria-label={props.label}
          placeholder={props.placeholder ?? "Ask a question…"}
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (props.canSend && !props.disabled) props.onSend();
            }
          }}
        />
        {props.tools}
        {props.onStop ? (
          <button type="button" className="btn shrink-0" onClick={props.onStop}>Stop</button>
        ) : (
          <button type="button" className="btn btn-primary shrink-0" disabled={props.disabled || props.busy || !props.canSend} onClick={props.onSend}>Send</button>
        )}
      </div>
      {props.hint && <p className="px-1 text-xs text-muted">{props.hint}</p>}
    </div>
  );
}

/** `/chat/:id`: the conversation. */
export function ChatThreadPane() {
  const { id = "" } = useParams();
  const { api } = useServices();
  const query = useQuery({ ...chatQuery(api, id), refetchInterval: (q) => chatPollInterval(q.state.data?.messages) });
  return (
    <Loaded query={query} label="Loading chat" rows={3}>
      {({ chat, messages }) => <Conversation key={chat.id} chat={chat} messages={messages} />}
    </Loaded>
  );
}

function Conversation({ chat, messages }: { chat: ChatThreadView; messages: ChatMessageView[] }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const { confirm, dialogs } = useDialogs();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const busy = messages.some(isBusy);
  const online = chat.deviceStatus === "online";
  // The model for the next question: the thread's, unless the person picks another its device offers (the session carries over).
  const [model, setModel] = useState(chat.model);
  useEffect(() => setModel(chat.model), [chat.id, chat.model]);
  const options = useQuery(chatOptionsQuery(api, chat.teamKey));
  const offered = options.data?.devices.find((d) => d.id === chat.deviceId)?.models ?? [];
  const models = offered.includes(chat.model) ? offered : [chat.model, ...offered];

  // The view follows new text only while the person is at the bottom; scrolling up to read leaves it alone.
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const signature = messages.map((m) => `${m.id}:${m.content.length}:${m.state}:${m.activity.length}`).join("|");
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [signature]);
  useEffect(() => {
    following.current = true;
  }, [chat.id]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["chats"] });
  const send = async () => {
    const message = draft.trim();
    if (!message || busy || sending || !online) return;
    setSending(true);
    setError(null);
    try {
      const added = await api.chats.send(chat.id, message, model !== chat.model ? model : undefined);
      queryClient.setQueryData(chatQuery(api, chat.id).queryKey, { chat: { ...chat, model, running: true }, messages: [...messages, ...added] });
      setDraft("");
      following.current = true;
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setSending(false);
      await refresh();
    }
  };
  const stop = async () => {
    setError(null);
    try {
      await api.chats.cancel(chat.id);
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      await refresh();
    }
  };
  const remove = async () => {
    const ok = await confirm({ title: "Delete this chat?", description: "The conversation is removed for good. An answer still running is stopped.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api.chats.remove(chat.id);
      queryClient.removeQueries({ queryKey: chatQuery(api, chat.id).queryKey });
      await refresh();
      void navigate("/chat", { replace: true });
    } catch (e) {
      setError(describeFailure(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{chat.title}</h1>
          <p className="truncate text-xs text-muted">
            {chat.repositoryName ?? "repository removed"} · {chat.deviceName}{online ? "" : " (offline)"} · {chat.model}
          </p>
        </div>
        <button type="button" className="btn shrink-0" aria-label="Delete chat" onClick={() => void remove()}>
          <TrashIcon aria-hidden />
        </button>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4" onScroll={(e) => (following.current = atBottom(e.currentTarget))}>
        <ol className="mx-auto max-w-3xl space-y-4" aria-label="Messages">
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} />
          ))}
        </ol>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {!online && <p className="mb-1 px-1 text-xs text-muted">{chat.deviceName} is offline. Start the daemon on it to continue this chat.</p>}
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          busy={sending}
          disabled={busy || !online}
          canSend={!!draft.trim()}
          label="Message"
          placeholder={busy ? "Answering…" : "Ask a follow-up…"}
          error={error}
          onStop={busy ? () => void stop() : undefined}
          tools={models.length > 1 && <Select className="!w-auto shrink-0" ariaLabel="Model" value={model} options={models.map((m) => ({ value: m, label: m }))} onValueChange={setModel} />}
        />
      </div>
      {dialogs}
    </div>
  );
}

function MessageRow({ message: m }: { message: ChatMessageView }) {
  if (m.role === "user") {
    return (
      <li className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-panel-2 px-3 py-2 text-sm">{m.content}</p>
      </li>
    );
  }
  const live = liveLine(m);
  const note = endNote(m);
  return (
    <li className="space-y-1 text-sm">
      {m.content && <Markdown>{m.content}</Markdown>}
      {live && <p className="animate-pulse text-xs text-muted" role="status">{live}</p>}
      {note && <p className={clsx("text-xs", m.state === "failed" ? "text-danger" : "text-muted")} role={m.state === "failed" ? "alert" : undefined}>{note}</p>}
    </li>
  );
}

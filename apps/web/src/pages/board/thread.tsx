import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";
import { timeAgo } from "@wheelhouse/shared/time";
import type { ActorRef } from "@wheelhouse/api-client";
import { ActorAvatar } from "../../components/actor-avatar";
import { AgentIcon, MoreIcon } from "../../components/icons";

export type ThreadComment = { id: string; author: ActorRef; body: string; createdAt: Date | string };

const PREVIEW = 4;

/**
 * Discussion as a thread (Reddit/Twitter style): avatar column joined by a
 * connector line, name · time on top, markdown body below. Shows the latest
 * four messages; "show earlier" expands to a scrollable list of everything.
 */
export function DiscussionThread({ comments }: { comments: ThreadComment[] }) {
  const [expanded, setExpanded] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // keep the view pinned to the newest message unless the reader scrolled up

  const hidden = Math.max(0, comments.length - PREVIEW);
  const shown = expanded ? comments : comments.slice(-PREVIEW);

  useEffect(() => {
    if (expanded && scroller.current && stick.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [expanded, comments.length]);

  if (!comments.length) return <p className="text-xs text-muted">No messages yet. Start the discussion below.</p>;

  const list = (
    <ol>
      {shown.map((c, i) => {
        const last = i === shown.length - 1;
        const agent = c.author.kind === "agent";
        return (
          <li key={c.id} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <ActorAvatar actor={c.author} className="size-6" />
              {!last && <div className="my-0.5 w-px flex-1 bg-line" aria-hidden />}
            </div>
            <div className={clsx("min-w-0 flex-1", !last && "pb-2.5")}>
              <div className="flex flex-wrap items-center gap-x-2 text-xs leading-none">
                <span className={clsx("font-medium", agent ? "text-agent" : "text-muted")}>{c.author.name}</span>
                {agent && <span className="chip bg-agent/15 text-[10px] text-agent"><AgentIcon /> agent</span>}
                <span className="text-muted/70" title={new Date(c.createdAt).toLocaleString()}>
                  {timeAgo(c.createdAt)}
                </span>
              </div>
              <div className="md md-compact mt-1 break-words text-muted">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.body}</ReactMarkdown>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );

  return (
    <div>
      {hidden > 0 && !expanded && (
        <button
          className="mb-2.5 flex w-full items-center gap-2 text-left text-xs text-muted hover:text-fg"
          onClick={() => {
            stick.current = true;
            setExpanded(true);
          }}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-line"><MoreIcon /></span>
          Show {hidden} earlier {hidden === 1 ? "message" : "messages"}
        </button>
      )}
      {expanded ? (
        <>
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="max-h-80 overflow-y-auto overflow-x-hidden rounded-md border border-line bg-bg/30 p-3"
          >
            {list}
          </div>
          {comments.length > PREVIEW && (
            <button className="mt-2 text-xs text-muted hover:text-fg" onClick={() => setExpanded(false)}>
              Show less
            </button>
          )}
        </>
      ) : (
        list
      )}
    </div>
  );
}

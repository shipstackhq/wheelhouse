import { createContext, useContext, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { HoverCard } from "radix-ui";
import { MermaidPre } from "./mermaid";

export type GlossaryTerm = { term: string; definition: string };

const GlossaryContext = createContext<GlossaryTerm[]>([]);

/** Provide the team glossary so every <Markdown> below highlights its terms. */
export function GlossaryProvider({ terms, children }: { terms: GlossaryTerm[]; children: React.ReactNode }) {
  return <GlossaryContext.Provider value={terms}>{children}</GlossaryContext.Provider>;
}

// Minimal hast shapes; avoids pulling in @types/hast.
type HNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HNode[] };

const SKIP = new Set(["code", "pre", "a", "abbr"]);

/** rehype plugin: wrap glossary terms in <abbr data-term> (first occurrence per term). */
function rehypeGlossary(terms: GlossaryTerm[]) {
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = sorted.length ? new RegExp(`\\b(${sorted.map((t) => esc(t.term)).join("|")})\\b`, "gi") : null;
  return () => (tree: HNode) => {
    if (!re) return;
    const used = new Set<string>();
    const walk = (node: HNode) => {
      if (!node.children) return;
      const next: HNode[] = [];
      for (const child of node.children) {
        if (child.type === "element" && SKIP.has(child.tagName ?? "")) {
          next.push(child);
          continue;
        }
        if (child.type !== "text" || !child.value) {
          walk(child);
          next.push(child);
          continue;
        }
        let last = 0;
        const text = child.value;
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const key = m[1].toLowerCase();
          if (used.has(key)) continue;
          used.add(key);
          if (m.index > last) next.push({ type: "text", value: text.slice(last, m.index) });
          next.push({ type: "element", tagName: "abbr", properties: { dataTerm: key }, children: [{ type: "text", value: m[1] }] });
          last = m.index + m[1].length;
        }
        if (last === 0) next.push(child);
        else if (last < text.length) next.push({ type: "text", value: text.slice(last) });
      }
      node.children = next;
    };
    walk(tree);
  };
}

function Term({ term, children }: { term: string; children: React.ReactNode }) {
  const terms = useContext(GlossaryContext);
  const t = terms.find((x) => x.term.toLowerCase() === term);
  if (!t) return <>{children}</>;
  return (
    <HoverCard.Root openDelay={150} closeDelay={50}>
      <HoverCard.Trigger asChild>
        <abbr className="cursor-help no-underline decoration-dotted underline-offset-2 [text-decoration-line:underline] decoration-muted">{children}</abbr>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content sideOffset={6} className="z-50 max-w-xs rounded-md border border-line bg-panel p-3 text-sm text-fg shadow-xl">
          <div className="font-semibold">{t.term}</div>
          <div className="mt-1 text-muted">{t.definition}</div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

export function Markdown({
  children,
  className = "md",
  onLink,
}: {
  children: string;
  className?: string;
  /** Intercept in-app links (e.g. "#node:system:API"). Return true if handled. */
  onLink?: (href: string) => boolean;
}) {
  const terms = useContext(GlossaryContext);
  const plugins = useMemo(() => [rehypeGlossary(terms)], [terms]);
  const components: Components = {
    abbr: ({ node, children, ...props }) => {
      const key = (node?.properties?.dataTerm as string | undefined) ?? (props as Record<string, string>)["data-term"];
      return key ? <Term term={key}>{children}</Term> : <abbr {...props}>{children}</abbr>;
    },
    pre: MermaidPre,
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(e) => {
          if (href && onLink?.(href)) e.preventDefault();
        }}
        target={href?.startsWith("http") ? "_blank" : undefined}
        rel="noreferrer"
      >
        {children}
      </a>
    ),
  };
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={plugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

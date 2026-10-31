import { useEffect, useId, useState } from "react";
import type { Components } from "react-markdown";
import { useResolvedTheme } from "./theme-toggle";

type HNode = { tagName?: string; value?: string; properties?: { className?: unknown }; children?: HNode[] };

/** react-markdown's `pre`, drawing ```mermaid blocks as diagrams: `components={{ pre: MermaidPre }}`. */
export const MermaidPre: Components["pre"] = ({ node, children, ...props }) => {
  const code = node?.children?.[0] as HNode | undefined;
  const lang = code?.tagName === "code" ? code.properties?.className : undefined;
  if (Array.isArray(lang) && lang.includes("language-mermaid")) return <Mermaid code={(code?.children?.[0]?.value ?? "").trim()} />;
  return <pre {...props}>{children}</pre>;
};

/**
 * A ```mermaid block drawn as a diagram. Mermaid is large, so it loads only when a page has one; a block it cannot parse stays as code.
 */
export function Mermaid({ code }: { code: string }) {
  const theme = useResolvedTheme();
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default" });
        const { svg } = await mermaid.render(id, code);
        if (live) setSvg(svg);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [code, id, theme]);

  if (failed || svg === null)
    return (
      <pre>
        <code className="language-mermaid">{code}</code>
      </pre>
    );
  return <div className="my-3 flex justify-center overflow-x-auto" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

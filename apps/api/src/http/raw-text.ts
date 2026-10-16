import type { NextFunction, Request, Response } from "express";

/** Request bodies are read as text and parsed by each handler, so authentication can fail before a body is judged. */
export type RawTextRequest = Request & { rawText?: string };

export const MAX_BODY_BYTES = 6 * 1024 * 1024;

export function rawText(limit = MAX_BODY_BYTES) {
  return (req: RawTextRequest, res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE" || req.method === "OPTIONS") return next();
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on("data", (c: Buffer) => {
      if (refused) return;
      size += c.length;
      if (size > limit) {
        refused = true;
        res.status(413).type("text/plain").send("Too large");
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (refused) return;
      req.rawText = Buffer.concat(chunks).toString("utf8");
      next();
    });
    req.on("error", next);
  };
}

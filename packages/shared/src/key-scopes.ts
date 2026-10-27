/** What an API key may do over MCP and /api/v1. A tool names the one scope it needs; people have every scope. */
export const KEY_SCOPES = ["read", "board:write", "map:write", "docs:write", "planning:write"] as const;

export type KeyScope = (typeof KEY_SCOPES)[number];

/** A new key reads, and writes the board and the map; docs and planning are opt-in. */
export const DEFAULT_KEY_SCOPES: KeyScope[] = ["read", "board:write", "map:write"];

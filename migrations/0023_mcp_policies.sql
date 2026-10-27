-- 0023 (C373 Jarvis T3): a hold policy per MCP server (service), set by the owner or the developer. It can only RAISE the class
-- of a tool (money, destructive, outward, write patterns on the server's tool names); lowering stays the owner's per-tool read
-- confirmation (connect_tool_owner_reads, X-03). Expand only.
CREATE TABLE connect_mcp_policies (
  service     TEXT PRIMARY KEY,
  policy      TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

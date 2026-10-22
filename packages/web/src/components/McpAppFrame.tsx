/**
 * A minimal MCP Apps host. It renders an MCP server's ui:// view in a sandboxed
 * iframe and talks to it with the official AppBridge over postMessage. The same
 * views render in any MCP Apps-capable chat host; this lets the demo show them
 * next to our native cards.
 *
 * - The view's tool calls go to /api/apps/call (read-only tools only).
 * - Messages from the view ("Yes, place the order.") go into our normal chat, so
 *   the consent gate still applies.
 */
import { useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface Props {
  uri: string;
  /** Tool whose result this view displays, and its latest result. */
  toolName: string;
  result: CallToolResult | null;
  theme: "light" | "dark";
  onMessage: (text: string) => void;
}

export function McpAppFrame({ uri, toolName, result, theme, onMessage }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<AppBridge | null>(null);
  const ready = useRef(false);
  const [html, setHtml] = useState<string | null>(null);
  const [height, setHeight] = useState(220);
  const [error, setError] = useState<string | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const resultRef = useRef(result);
  resultRef.current = result;

  useEffect(() => {
    fetch(`/api/apps/resource?uri=${encodeURIComponent(uri)}`)
      .then((r) => r.json())
      .then((b) => (b.html ? setHtml(b.html) : setError(b.error ?? "Could not load view")))
      .catch((e) => setError(String(e)));
  }, [uri]);

  // Connect when the iframe has loaded the view's document (not the initial blank one).
  const connect = () => {
    const win = frame.current?.contentWindow;
    if (!html || !win || bridge.current) return;
    const b = new AppBridge(null, { name: "Unrush web host", version: "0.1.0" }, { serverTools: {}, logging: {}, openLinks: {} }, { hostContext: { theme } });
    b.oncalltool = async (params) => {
      const res = await fetch("/api/apps/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
      return (await res.json()) as CallToolResult;
    };
    b.onmessage = async (params) => {
      const text = params.content.map((c) => (c.type === "text" ? c.text : "")).join(" ").trim();
      if (text) onMessageRef.current(text);
      return {};
    };
    // Views may only open Amazon product/search links (the real handoff), in a new tab.
    b.onopenlink = async ({ url }) => {
      if (!/^https:\/\/www\.amazon\.com\//.test(url)) return { isError: true };
      window.open(url, "_blank", "noopener,noreferrer");
      return {};
    };
    b.onsizechange = ({ height: h }) => {
      if (h) setHeight(Math.min(Math.ceil(h) + 4, 900));
    };
    b.oninitialized = () => {
      ready.current = true;
      void b.sendToolInput({ arguments: {} });
      if (resultRef.current) void b.sendToolResult(resultRef.current);
    };
    bridge.current = b;
    void b.connect(new PostMessageTransport(win, win)).catch((e) => setError(String(e)));
  };

  useEffect(
    () => () => {
      ready.current = false;
      void bridge.current?.close().catch(() => {});
      bridge.current = null;
    },
    [],
  );

  // Push fresh tool results into the view as state changes.
  useEffect(() => {
    if (ready.current && result) void bridge.current?.sendToolResult(result);
  }, [result]);

  useEffect(() => {
    if (ready.current) void bridge.current?.sendHostContextChange({ theme });
  }, [theme]);

  return (
    <section className="card app-frame">
      <header className="card-head">
        <div className="card-title">
          <span className="mcp-app-tag">MCP App</span> <code>{uri}</code>
        </div>
        <span className="muted small">linked to {toolName}</span>
      </header>
      {error ? (
        <div className="empty">{error}</div>
      ) : !html ? (
        <div className="empty">Loading view…</div>
      ) : (
        <iframe ref={frame} title={uri} sandbox="allow-scripts" srcDoc={html} onLoad={connect} style={{ height }} />
      )}
    </section>
  );
}

/**
 * Unrush MCP server — Streamable HTTP transport (MCP spec 2025-11-25).
 *
 *   POST   /mcp   JSON-RPC requests (initialize creates a session → Mcp-Session-Id header)
 *   GET    /mcp   SSE stream for server→client messages on an existing session
 *   DELETE /mcp   terminate a session
 *   GET    /health
 */
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { openDb, resolveDbPath } from "./db.js";
import { log } from "./log.js";
import { createUnrushServer } from "./server.js";
import { Unrush, type UnrushOptions } from "./service.js";

/** The spec revision this server is built and judged against. */
export const TARGET_PROTOCOL_VERSION = "2025-11-25";

export interface StartOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  /** Close sessions idle longer than this (default 30 min). Clients that never send DELETE would otherwise leak. */
  sessionIdleMs?: number;
  /** Proactive checker interval (default 60 s). 0 disables the timer (checks still run after every write). */
  proactiveIntervalMs?: number;
  unrush?: UnrushOptions;
}

export interface RunningServer {
  url: string;
  port: number;
  app: Unrush;
  /** Negotiated protocol version per session id (for logs/tests). */
  negotiated: Map<string, string>;
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const db = openDb(resolveDbPath(opts.dbPath));
  const app = new Unrush(db, opts.unrush);
  const interval = opts.proactiveIntervalMs ?? 60_000;
  if (interval > 0) app.proactive.start(interval);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const negotiated = new Map<string, string>();
  const lastSeen = new Map<string, number>();
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const reaper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, seen] of lastSeen) {
      if (seen < cutoff) {
        log("reaping idle session", { session: id });
        void transports.get(id)?.close();
        lastSeen.delete(id);
      }
    }
  }, Math.min(idleMs, 60_000));
  reaper.unref();

  if (LATEST_PROTOCOL_VERSION !== TARGET_PROTOCOL_VERSION) {
    log("⚠ SDK latest protocol version differs from target", { sdk: LATEST_PROTOCOL_VERSION, target: TARGET_PROTOCOL_VERSION });
  }

  // createMcpExpressApp adds JSON parsing + DNS-rebinding (Host header) protection for localhost.
  const web = createMcpExpressApp({ host });

  web.get("/health", (_req, res) => {
    res.json({ ok: true, sessions: transports.size, protocol: TARGET_PROTOCOL_VERSION });
  });

  web.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    try {
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (sessionId || !isInitializeRequest(req.body)) {
          res.status(sessionId ? 404 : 400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: sessionId ? "Unknown or expired session. Re-initialize." : "No session: send an initialize request first." },
            id: null,
          });
          return;
        }

        const requested = req.body.params.protocolVersion;
        const client = req.body.params.clientInfo;
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, t);
            lastSeen.set(id, Date.now());
          },
        });
        transport = t;

        // The SDK's Server has no public getter for the negotiated version, so observe
        // the InitializeResult on its way out — that is the authoritative value.
        const send = t.send.bind(t);
        t.send = async (message: JSONRPCMessage, options) => {
          const result = (message as { result?: { protocolVersion?: string } }).result;
          if (result?.protocolVersion && t.sessionId && !negotiated.has(t.sessionId)) {
            const version = result.protocolVersion;
            negotiated.set(t.sessionId, version);
            const ok = version === TARGET_PROTOCOL_VERSION;
            log(`${ok ? "✓" : "⚠"} session initialized`, {
              session: t.sessionId,
              client: client ? `${client.name}@${client.version}` : "unknown",
              requestedProtocol: requested,
              negotiatedProtocol: version,
              target: TARGET_PROTOCOL_VERSION,
              ...(ok ? {} : { warning: `client negotiated ${version}, not ${TARGET_PROTOCOL_VERSION}` }),
            });
          }
          return send(message, options);
        };

        t.onclose = () => {
          if (t.sessionId) {
            transports.delete(t.sessionId);
            negotiated.delete(t.sessionId);
            lastSeen.delete(t.sessionId);
            log("session closed", { session: t.sessionId });
          }
        };

        const server = createUnrushServer(app);
        await server.connect(t);
      }

      if (transport.sessionId) lastSeen.set(transport.sessionId, Date.now());
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("✗ request failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // GET (SSE stream) and DELETE (terminate) both require an existing session.
  const sessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(sessionId ? 404 : 400).send(sessionId ? "Unknown or expired session" : "Missing Mcp-Session-Id header");
      return;
    }
    lastSeen.set(sessionId!, Date.now());
    await transport.handleRequest(req, res);
  };
  web.get("/mcp", sessionRequest);
  web.delete("/mcp", sessionRequest);

  const httpServer: Server = await new Promise((resolve) => {
    const s = web.listen(opts.port ?? 3001, host, () => resolve(s));
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 3001);
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/mcp`;

  return {
    url,
    port,
    app,
    negotiated,
    async close() {
      clearInterval(reaper);
      app.proactive.stop();
      for (const t of transports.values()) await t.close().catch(() => {});
      transports.clear();
      await new Promise<void>((r) => httpServer.close(() => r()));
      db.close();
    },
  };
}

// Run directly: `tsx src/index.ts`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.MCP_PORT ?? 3001);
  const running = await startServer({ port, host: process.env.MCP_HOST ?? "127.0.0.1" });
  log("Unrush MCP server listening", {
    url: running.url,
    transport: "streamable-http",
    protocol: TARGET_PROTOCOL_VERSION,
    db: resolveDbPath(),
    now: running.app.ctx.clock.now(),
    proactiveCheckEverySec: 60,
  });
  const shutdown = async () => {
    log("shutting down");
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

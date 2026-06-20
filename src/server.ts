import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./mcp.ts";
import { LANDING_HTML } from "./landing.ts";
import { campgroundInfo, listCampgrounds } from "./providers/registry.ts";

const PORT = Number(process.env.PORT ?? 3000);
// The MCP endpoint lives at an unguessable path (the server is unauthenticated).
const MCP_PATH = process.env.MCP_PATH ?? "/burrow/9f3a7c2e1d/mcp";

// Active sessions: an `initialize` mints one; later requests carry mcp-session-id.
const transports = new Map<string, StreamableHTTPServerTransport>();

function buildServer(): McpServer {
  const server = new McpServer({ name: "alberta-parks", version: "0.1.0" });
  registerTools(server);
  return server;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function jsonRpcError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
  );
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // GET (server→client SSE) and DELETE (terminate) must target a live session.
  if (req.method === "GET" || req.method === "DELETE") {
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) return jsonRpcError(res, 400, "Unknown or missing session id");
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return jsonRpcError(res, 400, "Invalid JSON body");
  }

  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (!isInitializeRequest(body)) {
      return jsonRpcError(res, 400, "No valid session; send initialize first");
    }
    // New session.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport!);
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    const server = buildServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, body);
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    if (url.pathname === MCP_PATH) {
      await handleMcp(req, res);
      return;
    }
    if (url.pathname === "/api/campgrounds") {
      try {
        const all = await listCampgrounds();
        const pins = all
          .filter((c) => c.lat != null && c.lng != null)
          .map((c) => ({
            id: c.parkId,
            name: c.name,
            j: c.jurisdiction,
            t: c.type,
            lat: c.lat,
            lng: c.lng,
            url: c.bookingUrl,
          }));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=600" }).end(
          JSON.stringify({ count: pins.length, total: all.length, pins }),
        );
      } catch (e) {
        res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (url.pathname === "/api/campground") {
      const id = url.searchParams.get("id") || "";
      try {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=600" }).end(
          JSON.stringify(await campgroundInfo(id)),
        );
      } catch (e) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LANDING_HTML);
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (url.pathname === "/api/stats") {
      try {
        const all = await listCampgrounds();
        const byJurisdiction: Record<string, { total: number; campground: number; backcountry: number }> = {};
        for (const c of all) {
          const j = (byJurisdiction[c.jurisdiction] ??= { total: 0, campground: 0, backcountry: 0 });
          j.total++;
          j[c.type]++;
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" }).end(
          JSON.stringify({ total: all.length, byJurisdiction }),
        );
      } catch (e) {
        res.writeHead(503, { "content-type": "application/json" }).end(
          JSON.stringify({ error: (e as Error).message }),
        );
      }
      return;
    }
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  } catch (err) {
    console.error("request error:", err);
    if (!res.headersSent) res.writeHead(500).end("Internal server error");
  }
});

httpServer.listen(PORT, () => {
  console.log(`parks-mcp listening on :${PORT}  (MCP at ${MCP_PATH})`);
});

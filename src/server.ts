import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createImageTask, pollTaskUntilDone } from "./manusClient.js";
import {
  handleMetadata,
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleToken,
  isValidAccessToken,
} from "./oauth.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Stateful session storage mapping session IDs to active transports
const transports: Record<string, StreamableHTTPServerTransport> = {};

function buildMcpServer() {
  const server = new McpServer({
    name: "manus-mcp-server",
    version: "1.0.0",
  });

  server.tool(
    "run_agent",
    "Run a Manus task to build an artifact, research a topic, or browse websites. This tool is asynchronous and can take up to several minutes.",
    {
      prompt: z.string().describe("The objective or instructions for the Manus agent"),
    },
    async ({ prompt }) => {
      try {
        console.log(`Starting Manus task: "${prompt}"`);
        const task = await createImageTask(prompt);
        console.log(`Task created with ID: ${task.id}, polling status...`);
        
        const result = await pollTaskUntilDone(task.id);
        return {
          content: [
            {
              type: "text",
              text: `Manus task completed successfully.\n\nResult:\n${result}`,
            },
          ],
        };
      } catch (error: any) {
        console.error("Error executing Manus task:", error);
        return {
          content: [
            {
              type: "text",
              text: `Error executing Manus task: ${error.message || error}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

function isAuthorized(req: express.Request): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.substring(7);
  return isValidAccessToken(token);
}

// Main POST handler for incoming MCP messages
app.post("/mcp", async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  // 1. If an active session transport already exists, reuse it
  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } 
  // 2. If no session exists and it's a fresh initialization request, spin up a new instance
  else if (!sessionId && req.body && req.body.method === "initialize") {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
      }
    };

    const server = buildMcpServer();
    await server.connect(transport);
  } 
  // 3. Otherwise, the request is invalid or the session expired
  else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null
    });
    return;
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET and DELETE route companion for streaming notifications/session termination
const handleSessionRequest = async (req: express.Request, res: express.Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const transport = transports[sessionId];
  try {
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("Session mapping handling error:", err);
  }
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

// --- OAuth 2.0 endpoints (Restored for Claude Handshake Sync) ---
app.get("/.well-known/oauth-authorization-server", handleMetadata);
app.get("/.well-known/oauth-protected-resource", handleMetadata);
app.post("/register", handleRegister);
app.get("/authorize", handleAuthorizeGet);
app.post("/authorize", handleAuthorizePost);
app.post("/token", handleToken);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Manus MCP server listening on port ${port}`);
});

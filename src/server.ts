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

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

function isAuthorized(req: express.Request): boolean {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return false;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return false;
  return isValidAccessToken(token);
}

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "manus-image-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "generate_image",
    {
      title: "Generate image via Manus",
      description:
        "Generates an image using the Manus AI agent from a text prompt, waits for completion, and returns the resulting image URL(s). Use this whenever the user wants an image created.",
      inputSchema: {
        prompt: z
          .string()
          .describe("Detailed description of the image to generate."),
        style: z
          .string()
          .optional()
          .describe("Optional style guidance, e.g. 'photorealistic', 'watercolor', 'flat vector illustration'."),
        aspect_ratio: z
          .string()
          .optional()
          .describe("Optional aspect ratio, e.g. '1:1', '16:9', '9:16'."),
      },
    },
    async ({ prompt, style, aspect_ratio }) => {
      try {
        const taskId = await createImageTask({
          prompt,
          style,
          aspectRatio: aspect_ratio,
        });

        const result = await pollTaskUntilDone(taskId);

        if (result.status.toLowerCase().includes("fail") || result.status.toLowerCase().includes("error")) {
          return {
            content: [
              {
                type: "text",
                text: `Manus task failed (status: ${result.status}). ${result.rawText ?? ""}`,
              },
            ],
            isError: true,
          };
        }

        if (result.files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Manus task completed but returned no files. Raw response text: ${result.rawText ?? "(none)"}`,
              },
            ],
            isError: true,
          };
        }

        const links = result.files
          .map((f) => `- ${f.name}: ${f.url}`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Image generated successfully.\n\n${links}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error generating image via Manus: ${err.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true })); // for the /authorize login form POST

// Health check for Railway
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// --- OAuth 2.0 endpoints (dynamic client registration + auth code + PKCE) ---
app.get("/.well-known/oauth-authorization-server", handleMetadata);
app.get("/.well-known/oauth-protected-resource", handleMetadata);
app.post("/register", handleRegister);
app.get("/authorize", handleAuthorizeGet);
app.post("/authorize", handleAuthorizePost);
app.post("/token", handleToken);

// Streamable HTTP MCP endpoint (stateless: one transport per request is fine
// for a single-tool server like this; simplifies deployment on Railway).
app.post("/mcp", async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET/DELETE on /mcp are used by some clients for session management;
// reject cleanly since this server runs stateless (per-request) transports.
app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server)" });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server)" });
});

app.listen(PORT, () => {
  console.log(`Manus MCP server listening on port ${PORT}`);
});
                    

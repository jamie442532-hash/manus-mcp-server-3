import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { createImageTask, pollTaskUntilDone } from "./manusClient.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "manus-image-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "generate_image",
    {
      title: "Generate image via Manus",
      description: "Generates an image using the Manus AI agent from a text prompt.",
      inputSchema: {
        prompt: z.string().describe("Detailed description of the image to generate."),
        style: z.string().optional().describe("Optional style guidance."),
        aspect_ratio: z.string().optional().describe("Optional aspect ratio, e.g. '1:1', '16:9'."),
      },
    },
    async ({ prompt, style, aspect_ratio }) => {
      try {
        const taskId = await createImageTask({ prompt, style, aspectRatio: aspect_ratio });
        const result = await pollTaskUntilDone(taskId);

        if (result.status.toLowerCase().includes("fail") || result.status.toLowerCase().includes("error")) {
          return { content: [{ type: "text", text: `Manus task failed.` }], isError: true };
        }

        const links = result.files.map((f) => `- ${f.name}: ${f.url}`).join("\n");
        return { content: [{ type: "text", text: `Image generated successfully.\n\n${links}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

const app = express();
const mcpServer = buildMcpServer();
let transport: SSEServerTransport | null = null;

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// 1. Claude connects here via GET to establish the stream
app.get("/sse", async (_req, res) => {
  transport = new SSEServerTransport("/messages", res);
  await mcpServer.connect(transport);
});

// 2. Claude sends messages here via POST
app.post("/messages", express.json(), async (req, res) => {
  if (transport) {
    await transport.handleMessage(req, res);
  } else {
    res.status(400).send("No active SSE session found.");
  }
});

app.listen(PORT, () => {
  console.log(`Manus SSE MCP server listening on port ${PORT}`);
});

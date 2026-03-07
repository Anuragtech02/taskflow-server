import { FastifyInstance } from "fastify";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { authenticateRequest } from "../../plugins/auth.js";
import { config } from "../../config.js";

const { lists, spaces, workspaceMembers } = schema;

const inputSchema = z.object({
  type: z.enum(["text", "image", "file", "url"]),
  content: z.string().min(1),
  listId: z.string().uuid().optional(),
});

const taskSchema = z.object({
  title: z.string(),
  description: z.string(),
  priority: z.enum(["urgent", "high", "medium", "low"]),
  effort: z.string().optional(),
  subtasks: z.array(z.string()).optional(),
});

const IMPROVED_PROMPT = `You are an expert project manager. Analyze the following content and extract actionable tasks that need to be completed.

For each task, provide:
- title: A clear, concise task title (action-oriented)
- description: A brief description explaining what needs to be done
- priority: One of "urgent", "high", "medium", or "low" - be strict and realistic
- effort: Estimated effort in human-readable format (e.g., "15m", "2h", "1d", "1w")
- subtasks: Array of smaller actionable steps needed to complete this task (if applicable)

Guidelines:
- Break down complex requests into multiple specific tasks
- Set realistic priorities based on importance and urgency
- Estimate effort based on typical scope
- Include subtasks for multi-step tasks
- Focus on actionable items, not abstract concepts

Respond ONLY with a valid JSON array, no markdown, no explanations.`;

export default async function aiRoutes(fastify: FastifyInstance) {
  // POST /ai/generate-tasks
  fastify.post("/ai/generate-tasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    if (!config.geminiApiKey) return reply.status(500).send({ error: "GEMINI_API_KEY not configured" });

    try {
      const body = request.body as Record<string, unknown>;
      const { type, content, listId } = inputSchema.parse(body);

      // Verify workspace membership if listId provided
      if (listId) {
        const list = await db.query.lists.findFirst({
          where: eq(lists.id, listId),
          with: { space: true },
        });
        if (!list) return reply.status(404).send({ error: "List not found" });
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(eq(workspaceMembers.workspaceId, list.space.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
        });
        if (!membership) return reply.status(403).send({ error: "Access denied" });
      }

      const genAI = new GoogleGenerativeAI(config.geminiApiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      let result;

      if (type === "url") {
        let parsedUrl: URL;
        try { parsedUrl = new URL(content); } catch { return reply.status(400).send({ error: "Invalid URL format" }); }

        // Block internal/private network URLs (SSRF protection)
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return reply.status(400).send({ error: "Only HTTP/HTTPS URLs are allowed" });
        }
        const hostname = parsedUrl.hostname;
        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" ||
            hostname.startsWith("10.") || hostname.startsWith("172.") || hostname.startsWith("192.168.") ||
            hostname.startsWith("169.254.") || hostname.endsWith(".internal") || hostname.endsWith(".local")) {
          return reply.status(400).send({ error: "Internal URLs are not allowed" });
        }

        try {
          const fetchResponse = await fetch(content, { headers: { "User-Agent": "TaskFlow-AI/1.0" } });
          if (!fetchResponse.ok) return reply.status(400).send({ error: `Failed to fetch URL: ${fetchResponse.status}` });
          const html = await fetchResponse.text();
          const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          const truncated = text.length > 15000 ? text.substring(0, 15000) + "\n\n[Content truncated...]" : text;
          result = await model.generateContent(IMPROVED_PROMPT + `\n\nContent from URL ${content}:\n${truncated}`);
        } catch (e) {
          return reply.status(400).send({ error: `Failed to fetch URL: ${e instanceof Error ? e.message : "Unknown error"}` });
        }
      } else if (content.startsWith("data:")) {
        const match = content.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return reply.status(400).send({ error: "Invalid file data" });
        if (match[2].length > 2 * 1024 * 1024) return reply.status(400).send({ error: "File too large (max 2MB)" });
        result = await model.generateContent([
          IMPROVED_PROMPT + "\n\nExtract actionable tasks from this file:",
          { inlineData: { mimeType: match[1], data: match[2] } },
        ]);
      } else {
        const truncated = content.length > 15000 ? content.substring(0, 15000) + "\n\n[Content truncated...]" : content;
        result = await model.generateContent(IMPROVED_PROMPT + `\n\nContent:\n${truncated}`);
      }

      const text = result.response.text();
      const cleanedText = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

      let tasks;
      try { tasks = JSON.parse(cleanedText); } catch {
        return reply.status(500).send({ error: "AI returned invalid JSON. Please try again." });
      }
      if (!Array.isArray(tasks)) return reply.status(500).send({ error: "AI response format invalid." });

      return { tasks: z.array(taskSchema).parse(tasks), listId: listId || null };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error generating tasks:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}

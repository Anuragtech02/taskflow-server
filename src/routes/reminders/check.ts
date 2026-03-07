import { FastifyInstance } from "fastify";
import { checkAndSendReminders } from "../../lib/reminders.js";
import { config } from "../../config.js";

export default async function reminderCheckRoutes(fastify: FastifyInstance) {
  // POST /reminders/check
  fastify.post("/reminders/check", async (request, reply) => {
    const authHeader = request.headers.authorization;
    const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!config.cronApiKey || apiKey !== config.cronApiKey) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    try {
      const sentCount = await checkAndSendReminders();
      return {
        success: true, remindersSent: sentCount,
        message: sentCount === 0 ? "No pending reminders to send" : `Sent ${sentCount} reminder${sentCount === 1 ? "" : "s"}`,
      };
    } catch (error) {
      console.error("Error checking reminders:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /reminders/check (alias)
  fastify.get("/reminders/check", async (request, reply) => {
    const authHeader = request.headers.authorization;
    const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!config.cronApiKey || apiKey !== config.cronApiKey) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    try {
      const sentCount = await checkAndSendReminders();
      return {
        success: true, remindersSent: sentCount,
        message: sentCount === 0 ? "No pending reminders to send" : `Sent ${sentCount} reminder${sentCount === 1 ? "" : "s"}`,
      };
    } catch (error) {
      console.error("Error checking reminders:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}

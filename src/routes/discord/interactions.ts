import { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { isDiscordConfigured } from "../../lib/discord/api.js";
import { verifyDiscordRequest } from "../../lib/discord/verify.js";
import { EPHEMERAL, handleInteraction, type Interaction } from "../../lib/discord/commands.js";

/**
 * POST /discord/interactions — Discord's slash-command webhook.
 *
 * Signatures are computed over the exact bytes Discord sent, so this plugin
 * swaps in a string JSON parser that keeps the raw body. Fastify encapsulates
 * content-type parsers per registered plugin, so every other route keeps the
 * default JSON parser.
 */
export default async function discordInteractionRoutes(fastify: FastifyInstance) {
  fastify.removeContentTypeParser("application/json");
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  fastify.post("/discord/interactions", async (request, reply) => {
    if (!isDiscordConfigured()) return reply.status(503).send({ error: "Discord integration is not configured" });

    const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? "";
    const ok = verifyDiscordRequest(
      config.discord.publicKey,
      request.headers["x-signature-ed25519"] as string | undefined,
      request.headers["x-signature-timestamp"] as string | undefined,
      rawBody
    );
    if (!ok) return reply.status(401).send({ error: "Invalid request signature" });

    try {
      return await handleInteraction(request.body as Interaction);
    } catch (error) {
      request.log.error({ err: error }, "discord interaction failed");
      // Always answer: an unanswered interaction shows the user a generic
      // "application did not respond" error.
      return { type: 4, data: { content: "Something went wrong handling that command. Try again in a moment.", flags: EPHEMERAL } };
    }
  });
}

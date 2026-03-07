import { FastifyInstance } from "fastify";
import { hash } from "bcryptjs";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { isSubdomainAvailable } from "../../lib/tenant.js";
import { sendWelcomeEmail } from "../../lib/email.js";

const { users, workspaces, workspaceMembers, spaces } = schema;

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 5;
const WINDOW_MS = 60 * 1000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + WINDOW_MS });
    return true;
  }
  if (record.count >= RATE_LIMIT) return false;
  record.count++;
  return true;
}

export default async function registerRoutes(fastify: FastifyInstance) {
  fastify.post("/auth/register", async (request, reply) => {
    const clientIp = request.ip;

    if (!checkRateLimit(clientIp)) {
      return reply.status(429).send({ error: "Too many requests. Please try again later." });
    }

    try {
      const body = request.body as Record<string, unknown>;
      const { name, email, password, organizationName, subdomain } = body as {
        name?: string; email?: string; password?: string; organizationName?: string; subdomain?: string;
      };

      if (!name || !email || !password) {
        return reply.status(400).send({ error: "Missing required fields: name, email, password" });
      }

      const existingUser = await db.query.users.findFirst({ where: eq(users.email, email) });
      if (existingUser) {
        return reply.status(409).send({ error: "User already exists" });
      }

      let finalSubdomain: string | null = null;
      if (subdomain) {
        if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(subdomain)) {
          return reply.status(400).send({ error: "Invalid subdomain format. Use only letters, numbers, and hyphens." });
        }
        const available = await isSubdomainAvailable(subdomain);
        if (!available) {
          return reply.status(409).send({ error: "Subdomain is not available" });
        }
        finalSubdomain = subdomain.toLowerCase();
      }

      const passwordHash = await hash(password, 12);

      const result = await db.transaction(async (tx) => {
        const [newUser] = await tx.insert(users).values({ name, email, passwordHash }).returning();
        const slug = finalSubdomain || organizationName?.toLowerCase().replace(/[^a-z0-9]/g, "-") || newUser.id.slice(0, 8);

        const [newWorkspace] = await tx.insert(workspaces).values({
          name: organizationName || `${name}'s Workspace`,
          slug,
          subdomain: finalSubdomain,
          ownerId: newUser.id,
          plan: "free",
          status: "active",
        }).returning();

        await tx.insert(workspaceMembers).values({ workspaceId: newWorkspace.id, userId: newUser.id, role: "owner" });

        const [defaultSpace] = await tx.insert(spaces).values({
          workspaceId: newWorkspace.id,
          name: "Inbox",
          description: "Your default task space",
          color: "#6366f1",
          icon: "inbox",
          order: 0,
        }).returning();

        return { user: newUser, workspace: newWorkspace, space: defaultSpace };
      });

      sendWelcomeEmail(result.user.email, result.user.name).catch(console.error);

      return reply.status(201).send({
        user: { id: result.user.id, name: result.user.name, email: result.user.email },
        workspace: { id: result.workspace.id, name: result.workspace.name, slug: result.workspace.slug, subdomain: result.workspace.subdomain },
        message: "Account and organization created successfully",
      });
    } catch (error) {
      console.error("Registration error:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}

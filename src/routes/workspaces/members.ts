import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and, ilike, or } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";
import { sendInviteEmail } from "../../lib/email.js";

const { workspaceMembers, users, workspaces } = schema;

export default async function memberRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/members
  fastify.get("/workspaces/:id/members", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    const { q: query } = request.query as { q?: string };

    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const whereClause = query
        ? and(eq(workspaceMembers.workspaceId, workspaceId), or(ilike(users.name, `%${query}%`), ilike(users.email, `%${query}%`)))
        : eq(workspaceMembers.workspaceId, workspaceId);

      const members = await db
        .select({ id: users.id, name: users.name, email: users.email, avatarUrl: users.avatarUrl, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(whereClause);

      return { members };
    } catch (error) {
      console.error("Error fetching workspace members:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /workspaces/:id/members
  fastify.post("/workspaces/:id/members", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    const body = request.body as { email?: string; role?: string };

    try {
      if (!body.email || !body.role) return reply.status(400).send({ error: "Email and role are required" });

      const validRoles = ["admin", "member", "viewer"];
      if (!validRoles.includes(body.role)) return reply.status(400).send({ error: "Invalid role. Must be admin, member, or viewer" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });
      if (membership.role !== "owner" && membership.role !== "admin") {
        return reply.status(403).send({ error: "Only admins and owners can invite members" });
      }

      const userToAdd = await db.query.users.findFirst({ where: eq(users.email, body.email.toLowerCase()) });
      if (!userToAdd) return reply.status(404).send({ error: "User not found with this email" });

      const existingMember = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userToAdd.id)),
      });
      if (existingMember) return reply.status(400).send({ error: "User is already a member of this workspace" });

      await db.insert(workspaceMembers).values({ workspaceId, userId: userToAdd.id, role: body.role });

      const memberWithUser = await db
        .select({ id: users.id, name: users.name, email: users.email, avatarUrl: users.avatarUrl, role: workspaceMembers.role })
        .from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userToAdd.id)))
        .limit(1);

      // Fire-and-forget invite email
      const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { name: true } });
      const inviter = await db.query.users.findFirst({ where: eq(users.id, authResult.userId), columns: { name: true, email: true } });
      sendInviteEmail(userToAdd.email!, workspace?.name ?? "a workspace", inviter?.name || inviter?.email || "Someone").catch(console.error);

      return reply.status(201).send({ member: memberWithUser[0] });
    } catch (error) {
      console.error("Error adding workspace member:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /workspaces/:id/members/:userId
  fastify.patch("/workspaces/:id/members/:userId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId, userId } = request.params as { id: string; userId: string };
    const body = request.body as { role?: string };

    try {
      if (!body.role) return reply.status(400).send({ error: "Role is required" });
      const validRoles = ["admin", "member", "viewer"];
      if (!validRoles.includes(body.role)) return reply.status(400).send({ error: "Invalid role" });

      const currentMembership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!currentMembership || !["owner", "admin"].includes(currentMembership.role)) {
        return reply.status(403).send({ error: "Access denied" });
      }

      const targetMember = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      });
      if (!targetMember) return reply.status(404).send({ error: "Member not found" });
      if (targetMember.role === "owner") return reply.status(400).send({ error: "Cannot change the role of the workspace owner" });

      await db.update(workspaceMembers).set({ role: body.role })
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));

      const memberWithUser = await db
        .select({ id: users.id, name: users.name, email: users.email, avatarUrl: users.avatarUrl, role: workspaceMembers.role })
        .from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
        .limit(1);

      return { member: memberWithUser[0] };
    } catch (error) {
      console.error("Error updating workspace member:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /workspaces/:id/members/:userId
  fastify.delete("/workspaces/:id/members/:userId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId, userId } = request.params as { id: string; userId: string };

    try {
      const currentMembership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!currentMembership || !["owner", "admin"].includes(currentMembership.role)) {
        return reply.status(403).send({ error: "Access denied" });
      }

      const targetMember = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      });
      if (!targetMember) return reply.status(404).send({ error: "Member not found" });
      if (targetMember.role === "owner") return reply.status(400).send({ error: "Cannot remove the workspace owner" });

      await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
      return { success: true };
    } catch (error) {
      console.error("Error removing workspace member:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}

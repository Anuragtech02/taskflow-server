import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, or } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { forms, tasks, lists, workspaceMembers, taskActivities, workspaces } = schema;

const createFormSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  fields: z.array(z.object({
    name: z.string(), label: z.string(),
    type: z.enum(["text", "textarea", "number", "date", "select", "checkbox"]),
    required: z.boolean().default(false),
    options: z.array(z.string()).default([]),
  })).default([]),
  listId: z.string().uuid().optional(),
  isPublic: z.boolean().default(false),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/),
});

export default async function formRoutes(fastify: FastifyInstance) {
  // GET /forms/:slug (public)
  fastify.get("/forms/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    try {
      const form = await db.query.forms.findFirst({ where: eq(forms.slug, slug) });
      if (!form) return reply.status(404).send({ error: "Form not found" });

      let hasAccess = form.isPublic;
      if (!hasAccess) {
        const authResult = await authenticateRequest(request);
        if (authResult) {
          const membership = await db.query.workspaceMembers.findFirst({
            where: and(eq(workspaceMembers.workspaceId, form.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
          });
          hasAccess = !!membership;
        }
      }
      if (!hasAccess) return reply.status(404).send({ error: "Form not found" });

      let listInfo = null;
      if (form.listId) {
        const list = await db.query.lists.findFirst({ where: eq(lists.id, form.listId) });
        if (list) listInfo = { id: list.id, name: list.name };
      }
      return { form: { id: form.id, name: form.name, description: form.description, fields: form.fields, listInfo } };
    } catch (error) {
      console.error("Error fetching form:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /forms/:slug
  fastify.delete("/forms/:slug", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { slug } = request.params as { slug: string };
    try {
      const form = await db.query.forms.findFirst({ where: or(eq(forms.slug, slug), eq(forms.id, slug)) });
      if (!form) return reply.status(404).send({ error: "Form not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, form.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });
      await db.delete(forms).where(eq(forms.id, form.id));
      return { success: true };
    } catch (error) {
      console.error("Error deleting form:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /forms/:slug/submit (public, no auth)
  fastify.post("/forms/:slug/submit", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    try {
      const form = await db.query.forms.findFirst({ where: eq(forms.slug, slug) });
      if (!form) return reply.status(404).send({ error: "Form not found" });
      if (!form.isPublic) return reply.status(404).send({ error: "Form not available" });
      if (!form.listId) return reply.status(400).send({ error: "Form not linked to a list" });

      const body = request.body as Record<string, unknown>;
      const list = await db.query.lists.findFirst({ where: eq(lists.id, form.listId), with: { space: true } });
      if (!list) return reply.status(400).send({ error: "Linked list not found" });

      const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, list.space.workspaceId) });
      if (!workspace) return reply.status(400).send({ error: "Workspace not found" });

      const title = (body.title || body.Name || body.name || `Form submission: ${form.name}`) as string;
      const description: Record<string, any> = {};
      const fields = (form.fields as Array<{ name: string; label: string; type: string }>) || [];
      for (const field of fields) {
        if (body[field.name] !== undefined) description[field.label || field.name] = body[field.name];
      }

      const [task] = await db.insert(tasks).values({
        listId: form.listId, title, description, status: "todo", priority: "none", creatorId: workspace.ownerId,
      }).returning();

      await db.insert(taskActivities).values({ taskId: task.id, userId: workspace.ownerId, action: "created", field: "source", newValue: `form:${form.slug}` });
      return reply.status(201).send({ success: true, task: { id: task.id, title: task.title }, message: "Submission received successfully" });
    } catch (error) {
      console.error("Error submitting form:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /workspaces/:id/forms
  fastify.get("/workspaces/:id/forms", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });
      const workspaceForms = await db.query.forms.findMany({ where: eq(forms.workspaceId, workspaceId) });
      return { forms: workspaceForms };
    } catch (error) {
      console.error("Error fetching forms:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /workspaces/:id/forms
  fastify.post("/workspaces/:id/forms", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = createFormSchema.parse(body);
      const existingForm = await db.query.forms.findFirst({ where: eq(forms.slug, validatedData.slug) });
      if (existingForm) return reply.status(400).send({ error: "Slug already exists" });

      const [form] = await db.insert(forms).values({ ...validatedData, workspaceId }).returning();
      return reply.status(201).send({ form });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating form:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}

import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

const { workspaces } = schema;

export async function getTenantFromRequest(
  hostname: string,
  domain: string = "taskflow.dev"
): Promise<{ workspace: typeof workspaces.$inferSelect | null; isMainApp: boolean }> {
  const host = hostname.split(":")[0];

  if (host.endsWith(`.${domain}`) && host !== `app.${domain}` && host !== domain) {
    const subdomain = host.replace(`.${domain}`, "");
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.subdomain, subdomain),
    });

    if (workspace && workspace.status === "active") {
      return { workspace, isMainApp: false };
    }
  }

  return { workspace: null, isMainApp: true };
}

export async function getTenantBySubdomain(subdomain: string) {
  return db.query.workspaces.findFirst({
    where: eq(workspaces.subdomain, subdomain),
  });
}

export async function getTenantById(workspaceId: string) {
  return db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
}

export async function isSubdomainAvailable(subdomain: string): Promise<boolean> {
  const existing = await db.query.workspaces.findFirst({
    where: eq(workspaces.subdomain, subdomain),
  });
  if (existing) return false;

  const reserved = ["app", "www", "admin", "api", "auth", "dashboard", "mail"];
  if (reserved.includes(subdomain.toLowerCase())) return false;

  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(subdomain)) return false;

  return true;
}

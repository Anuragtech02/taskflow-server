import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { ServerResponse } from "http";

type SSEConnection = ServerResponse;

// Store active connections per workspace: Map<workspaceId, Map<connection, userId>>
const workspaceConnections = new Map<string, Map<SSEConnection, string>>();

export function addConnection(workspaceId: string, connection: SSEConnection, userId: string) {
  if (!workspaceConnections.has(workspaceId)) {
    workspaceConnections.set(workspaceId, new Map());
  }
  workspaceConnections.get(workspaceId)!.set(connection, userId);
}

export function removeConnection(workspaceId: string, connection: SSEConnection) {
  const connections = workspaceConnections.get(workspaceId);
  if (connections) {
    connections.delete(connection);
    if (connections.size === 0) {
      workspaceConnections.delete(workspaceId);
    }
  }
}

export function getConnectionCount(workspaceId: string): number {
  return workspaceConnections.get(workspaceId)?.size ?? 0;
}

export function getActiveUsers(workspaceId: string): string[] {
  const connections = workspaceConnections.get(workspaceId);
  if (!connections) return [];
  return Array.from(new Set(connections.values()));
}

export type SSEEventType =
  | "task_created"
  | "task_updated"
  | "task_deleted"
  | "comment_added"
  | "sprint_updated"
  | "notification"
  | "presence_update";

export interface SSEEvent {
  type: SSEEventType;
  data: Record<string, unknown>;
}

export function broadcastToWorkspace(workspaceId: string, event: SSEEvent) {
  const connections = workspaceConnections.get(workspaceId);
  if (!connections || connections.size === 0) return;

  const message = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;

  for (const [connection] of connections) {
    try {
      connection.write(message);
    } catch {
      connections.delete(connection);
    }
  }

  if (connections.size === 0) {
    workspaceConnections.delete(workspaceId);
  }
}

export function sendToUser(workspaceId: string, userId: string, event: SSEEvent) {
  const connections = workspaceConnections.get(workspaceId);
  if (!connections || connections.size === 0) return;

  const message = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;

  for (const [connection, connUserId] of connections) {
    if (connUserId !== userId) continue;
    try {
      connection.write(message);
    } catch {
      connections.delete(connection);
    }
  }

  if (connections.size === 0) {
    workspaceConnections.delete(workspaceId);
  }
}

/**
 * Close every live stream a user has open on a workspace. Membership is only
 * checked when a stream opens, so this must be called when someone is removed
 * from the workspace — otherwise an open tab keeps receiving its events.
 */
export function disconnectUser(workspaceId: string, userId: string): number {
  const connections = workspaceConnections.get(workspaceId);
  if (!connections) return 0;
  let closed = 0;
  for (const [connection, connUserId] of connections) {
    if (connUserId !== userId) continue;
    connections.delete(connection);
    closed++;
    try { connection.end(); } catch { /* already gone */ }
    try { connection.destroy(); } catch { /* already gone */ }
  }
  if (connections.size === 0) workspaceConnections.delete(workspaceId);
  return closed;
}

async function ssePlugin(fastify: FastifyInstance) {
  fastify.decorate("sse", {
    addConnection,
    removeConnection,
    getConnectionCount,
    getActiveUsers,
    broadcastToWorkspace,
    sendToUser,
    disconnectUser,
  });
}

declare module "fastify" {
  interface FastifyInstance {
    sse: {
      addConnection: typeof addConnection;
      removeConnection: typeof removeConnection;
      getConnectionCount: typeof getConnectionCount;
      getActiveUsers: typeof getActiveUsers;
      broadcastToWorkspace: typeof broadcastToWorkspace;
      sendToUser: typeof sendToUser;
      disconnectUser: typeof disconnectUser;
    };
  }
}

export default fp(ssePlugin, { name: "sse" });

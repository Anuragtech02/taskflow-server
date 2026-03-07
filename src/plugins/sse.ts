import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { ServerResponse } from "http";

type SSEConnection = ServerResponse;

// Store active connections per workspace
const workspaceConnections = new Map<string, Set<SSEConnection>>();

export function addConnection(workspaceId: string, connection: SSEConnection) {
  if (!workspaceConnections.has(workspaceId)) {
    workspaceConnections.set(workspaceId, new Set());
  }
  workspaceConnections.get(workspaceId)!.add(connection);
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

export type SSEEventType =
  | "task_created"
  | "task_updated"
  | "task_deleted"
  | "comment_added"
  | "sprint_updated"
  | "notification";

export interface SSEEvent {
  type: SSEEventType;
  data: Record<string, unknown>;
}

export function broadcastToWorkspace(workspaceId: string, event: SSEEvent) {
  const connections = workspaceConnections.get(workspaceId);
  if (!connections || connections.size === 0) return;

  const message = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;

  for (const connection of connections) {
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

async function ssePlugin(fastify: FastifyInstance) {
  fastify.decorate("sse", {
    addConnection,
    removeConnection,
    getConnectionCount,
    broadcastToWorkspace,
  });
}

declare module "fastify" {
  interface FastifyInstance {
    sse: {
      addConnection: typeof addConnection;
      removeConnection: typeof removeConnection;
      getConnectionCount: typeof getConnectionCount;
      broadcastToWorkspace: typeof broadcastToWorkspace;
    };
  }
}

export default fp(ssePlugin, { name: "sse" });

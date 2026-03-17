import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskFlowClient } from "../client.js";
import { formatDocuments, formatDocument } from "../format.js";

export function registerDocumentTools(server: McpServer, client: TaskFlowClient) {
  server.tool(
    "get_documents",
    "List all documents in a space",
    { spaceId: z.string().uuid().describe("The space ID") },
    async ({ spaceId }) => {
      const data = await client.getDocuments(spaceId);
      return {
        content: [{ type: "text", text: formatDocuments(data) }],
      };
    }
  );

  server.tool(
    "get_document",
    "Get a document's full details including content and child documents",
    { documentId: z.string().uuid().describe("The document ID") },
    async ({ documentId }) => {
      const data = await client.getDocument(documentId);
      return {
        content: [{ type: "text", text: formatDocument(data) }],
      };
    }
  );

  server.tool(
    "create_document",
    "Create a new document in a space",
    {
      spaceId: z.string().uuid().describe("The space ID to create the document in"),
      title: z.string().describe("Document title"),
      content: z.string().optional().describe("Document content (plain text)"),
      parentDocumentId: z
        .string()
        .uuid()
        .optional()
        .describe("Parent document ID to nest under"),
    },
    async ({ spaceId, title, content, parentDocumentId }) => {
      const data = await client.createDocument(spaceId, {
        title,
        content,
        parentDocumentId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "update_document",
    "Update an existing document's title or content",
    {
      documentId: z.string().uuid().describe("The document ID to update"),
      title: z.string().optional().describe("New title"),
      content: z.string().optional().describe("New content (plain text — replaces existing content)"),
      parentDocumentId: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe("Move under a parent document, or null to make it a root document"),
    },
    async ({ documentId, title, content, parentDocumentId }) => {
      const data = await client.updateDocument(documentId, {
        title,
        content,
        parentDocumentId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_document",
    "Delete a document and all its child documents",
    { documentId: z.string().uuid().describe("The document ID to delete") },
    async ({ documentId }) => {
      await client.deleteDocument(documentId);
      return {
        content: [{ type: "text", text: "Document deleted successfully." }],
      };
    }
  );
}

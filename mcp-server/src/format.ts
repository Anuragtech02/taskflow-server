/**
 * Strips null/empty fields and flattens nested objects to keep
 * MCP responses compact and avoid filling up LLM context.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function summarizeTask(task: any) {
  const summary: Record<string, any> = {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
  };

  if (task.dueDate) summary.dueDate = task.dueDate;
  if (task.startDate) summary.startDate = task.startDate;
  if (task.parentTaskId) summary.parentTaskId = task.parentTaskId;

  // Flatten assignees to names
  if (task.assignees?.length) {
    summary.assignees = task.assignees.map(
      (a: any) => a.user?.name || a.userId
    );
  }

  // Flatten creator to name
  if (task.creator) {
    summary.createdBy = task.creator.name;
  }

  if (task.createdAt) summary.createdAt = task.createdAt;

  // Flatten description to plain text if present
  if (task.description?.content) {
    const text = extractText(task.description);
    if (text) summary.description = text;
  }

  if (task.blockedBy?.length) summary.blockedBy = task.blockedBy;
  if (task.blocks?.length) summary.blocks = task.blocks;
  if (task.timeEstimate) summary.timeEstimate = task.timeEstimate;
  if (task.timeSpent) summary.timeSpent = task.timeSpent;

  return summary;
}

function extractText(doc: any): string {
  if (!doc?.content) return "";
  return doc.content
    .map((node: any) => {
      if (node.type === "text") return node.text || "";
      if (node.content) return extractText(node);
      return "";
    })
    .join("")
    .trim();
}

export function formatTasks(data: any): string {
  const tasks = data?.tasks || data;
  if (!Array.isArray(tasks)) return JSON.stringify(data);
  return JSON.stringify({ tasks: tasks.map(summarizeTask) }, null, 2);
}

export function formatTask(data: any): string {
  const task = data?.task || data;
  if (!task?.id) return JSON.stringify(data);

  const summary = summarizeTask(task);

  // Include comments for single task detail
  if (task.comments?.length) {
    summary.comments = task.comments.map((c: any) => ({
      by: c.user?.name || c.userId,
      text: c.content,
      at: c.createdAt,
    }));
  }

  // Include activity count
  if (task.activity?.length) {
    summary.activityCount = task.activity.length;
  }

  return JSON.stringify({ task: summary }, null, 2);
}

export function formatDocuments(data: any): string {
  const docs = data?.documents || data;
  if (!Array.isArray(docs)) return JSON.stringify(data);
  return JSON.stringify({
    documents: docs.map((doc: any) => {
      const summary: Record<string, any> = {
        id: doc.id,
        title: doc.title,
        updatedAt: doc.updatedAt,
      };
      if (doc.parentDocumentId) summary.parentDocumentId = doc.parentDocumentId;
      if (doc.icon) summary.icon = doc.icon;
      if (doc.creator) summary.createdBy = doc.creator.name;
      return summary;
    }),
  }, null, 2);
}

export function formatDocument(data: any): string {
  const doc = data?.document || data;
  if (!doc?.id) return JSON.stringify(data);

  const summary: Record<string, any> = {
    id: doc.id,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };

  if (doc.parentDocumentId) summary.parentDocumentId = doc.parentDocumentId;
  if (doc.icon) summary.icon = doc.icon;
  if (doc.creator) summary.createdBy = doc.creator.name;

  // Extract content to plain text
  if (doc.content?.content) {
    const text = extractText(doc.content);
    if (text) summary.content = text;
  }

  // Include child documents
  if (data?.children?.length) {
    summary.children = data.children.map((c: any) => ({
      id: c.id,
      title: c.title,
    }));
  }

  return JSON.stringify({ document: summary }, null, 2);
}

export function formatSearchResults(data: any): string {
  const tasks = data?.tasks || data;
  if (!Array.isArray(tasks)) return JSON.stringify(data);
  return JSON.stringify(
    {
      tasks: tasks.map((t: any) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        listId: t.listId,
        assignees: t.assignees?.length
          ? t.assignees.map((a: any) => a.user?.name || a.userId)
          : undefined,
      })),
    },
    null,
    2
  );
}

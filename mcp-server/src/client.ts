export class TaskFlowClient {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.TASKFLOW_API_KEY || "";
    this.baseUrl = (process.env.TASKFLOW_URL || "http://localhost:3000").replace(
      /\/$/,
      ""
    );

    if (!this.apiKey) {
      throw new Error("TASKFLOW_API_KEY environment variable is required");
    }
  }

  private async request(
    path: string,
    options: RequestInit = {}
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...options.headers as Record<string, string>,
    };
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`TaskFlow API error ${res.status}: ${body}`);
    }

    return res.json();
  }

  async listWorkspaces() {
    return this.request("/workspaces");
  }

  async listLists(workspaceId: string) {
    return this.request(`/workspaces/${workspaceId}/lists`);
  }

  async listMembers(workspaceId: string) {
    return this.request(`/workspaces/${workspaceId}/members`);
  }

  async searchTasks(workspaceId: string, query: string) {
    return this.request(
      `/workspaces/${workspaceId}/search?q=${encodeURIComponent(query)}`
    );
  }

  async getTasks(listId: string) {
    return this.request(`/lists/${listId}/tasks`);
  }

  async getTask(taskId: string) {
    return this.request(`/tasks/${taskId}`);
  }

  async createTask(
    listId: string,
    data: {
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      dueDate?: string;
      parentTaskId?: string;
    }
  ) {
    const body: Record<string, unknown> = { title: data.title };

    if (data.description !== undefined) {
      body.description = this.textToDoc(data.description);
    }
    if (data.status !== undefined) body.status = data.status;
    if (data.priority !== undefined) body.priority = data.priority;
    if (data.dueDate !== undefined) body.dueDate = data.dueDate;
    if (data.parentTaskId !== undefined) body.parentTaskId = data.parentTaskId;

    return this.request(`/lists/${listId}/tasks`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateTask(
    taskId: string,
    data: {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      dueDate?: string | null;
      listId?: string;
      parentTaskId?: string | null;
    }
  ) {
    const body: Record<string, unknown> = {};

    if (data.title !== undefined) body.title = data.title;
    if (data.description !== undefined) {
      body.description = this.textToDoc(data.description);
    }
    if (data.status !== undefined) body.status = data.status;
    if (data.priority !== undefined) body.priority = data.priority;
    if (data.dueDate !== undefined) body.dueDate = data.dueDate;
    if (data.listId !== undefined) body.listId = data.listId;
    if (data.parentTaskId !== undefined) body.parentTaskId = data.parentTaskId;

    return this.request(`/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async addComment(taskId: string, content: string) {
    return this.request(`/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  async assignTask(taskId: string, userId: string) {
    return this.request(`/tasks/${taskId}/assignees`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }

  async unassignTask(taskId: string, userId: string) {
    return this.request(`/tasks/${taskId}/assignees?userId=${userId}`, {
      method: "DELETE",
    });
  }

  private textToDoc(text: string) {
    const lines = text.split("\n");
    return {
      type: "doc",
      content: lines.map((line) =>
        line.trim()
          ? { type: "paragraph", content: [{ type: "text", text: line }] }
          : { type: "paragraph" }
      ),
    };
  }

  async getDocuments(spaceId: string) {
    return this.request(`/spaces/${spaceId}/documents`);
  }

  async getDocument(documentId: string) {
    return this.request(`/documents/${documentId}`);
  }

  async createDocument(
    spaceId: string,
    data: {
      title: string;
      content?: string;
      parentDocumentId?: string;
    }
  ) {
    const body: Record<string, unknown> = { title: data.title };
    if (data.content !== undefined) {
      body.content = this.textToDoc(data.content);
    }
    if (data.parentDocumentId !== undefined) body.parentDocumentId = data.parentDocumentId;

    return this.request(`/spaces/${spaceId}/documents`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async updateDocument(
    documentId: string,
    data: {
      title?: string;
      content?: string;
      parentDocumentId?: string | null;
    }
  ) {
    const body: Record<string, unknown> = {};
    if (data.title !== undefined) body.title = data.title;
    if (data.content !== undefined) {
      body.content = this.textToDoc(data.content);
    }
    if (data.parentDocumentId !== undefined) body.parentDocumentId = data.parentDocumentId;

    return this.request(`/documents/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async deleteDocument(documentId: string) {
    return this.request(`/documents/${documentId}`, {
      method: "DELETE",
    });
  }
}

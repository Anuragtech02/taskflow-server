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
    return this.request("/api/workspaces");
  }

  async listLists(workspaceId: string) {
    return this.request(`/api/workspaces/${workspaceId}/lists`);
  }

  async listMembers(workspaceId: string) {
    return this.request(`/api/workspaces/${workspaceId}/members`);
  }

  async searchTasks(workspaceId: string, query: string) {
    return this.request(
      `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent(query)}`
    );
  }

  async getTasks(listId: string) {
    return this.request(`/api/lists/${listId}/tasks`);
  }

  async getTask(taskId: string) {
    return this.request(`/api/tasks/${taskId}`);
  }

  async createTask(
    listId: string,
    data: {
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      dueDate?: string;
    }
  ) {
    const body: Record<string, unknown> = { title: data.title };

    if (data.description !== undefined) {
      body.description = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: data.description }],
          },
        ],
      };
    }
    if (data.status !== undefined) body.status = data.status;
    if (data.priority !== undefined) body.priority = data.priority;
    if (data.dueDate !== undefined) body.dueDate = data.dueDate;

    return this.request(`/api/lists/${listId}/tasks`, {
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
    }
  ) {
    const body: Record<string, unknown> = {};

    if (data.title !== undefined) body.title = data.title;
    if (data.description !== undefined) {
      body.description = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: data.description }],
          },
        ],
      };
    }
    if (data.status !== undefined) body.status = data.status;
    if (data.priority !== undefined) body.priority = data.priority;
    if (data.dueDate !== undefined) body.dueDate = data.dueDate;
    if (data.listId !== undefined) body.listId = data.listId;

    return this.request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async addComment(taskId: string, content: string) {
    return this.request(`/api/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  async assignTask(taskId: string, userId: string) {
    return this.request(`/api/tasks/${taskId}/assignees`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }

  async unassignTask(taskId: string, userId: string) {
    return this.request(`/api/tasks/${taskId}/assignees?userId=${userId}`, {
      method: "DELETE",
    });
  }
}

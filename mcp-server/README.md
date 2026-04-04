# TaskFlow MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets AI assistants like Claude manage tasks, documents, and assignments in your TaskFlow workspace.

## Installation

### Claude Code

```bash
claude mcp add taskflow -- npx -y taskflow-mcp-server
```

Then set the required environment variables (see [Configuration](#configuration)).

Or add it manually to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "npx",
      "args": ["-y", "taskflow-mcp-server"],
      "env": {
        "TASKFLOW_API_KEY": "your-api-key",
        "TASKFLOW_URL": "https://your-taskflow-instance.com"
      }
    }
  }
}
```

### Claude Desktop

Add to your config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "npx",
      "args": ["-y", "taskflow-mcp-server"],
      "env": {
        "TASKFLOW_API_KEY": "your-api-key",
        "TASKFLOW_URL": "https://your-taskflow-instance.com"
      }
    }
  }
}
```

### Cursor / Windsurf / Other MCP Clients

Use the same configuration format as above. Refer to your editor's documentation for where to place the MCP server config.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `TASKFLOW_API_KEY` | Yes | Your TaskFlow API key |
| `TASKFLOW_URL` | No | TaskFlow backend URL (defaults to `http://localhost:3000`) |

## Available Tools

### Workspaces

| Tool | Description |
|---|---|
| `list_workspaces` | List all workspaces you belong to |
| `list_lists` | Get all lists in a workspace, grouped by space and folder |
| `list_members` | List all members of a workspace (useful for assigning tasks) |

### Tasks

| Tool | Description |
|---|---|
| `get_tasks` | Get all tasks in a list |
| `get_task` | Get full task details including comments, assignees, and activity |
| `create_task` | Create a new task with title, description, status, priority, due date, or as a sub-task |
| `update_task` | Update task fields or move it to a different list |
| `search_tasks` | Search tasks by title or description across a workspace |
| `assign_task` | Assign or unassign a user from a task |
| `add_comment` | Add a comment to a task |

### Documents

| Tool | Description |
|---|---|
| `get_documents` | List all documents in a space |
| `get_document` | Get a document's full content and child documents |
| `create_document` | Create a new document in a space, optionally nested under a parent |
| `update_document` | Update a document's title or content |
| `delete_document` | Delete a document and all its children |

## Example Usage

Once configured, you can ask Claude things like:

- "Show me all tasks in the backend sprint list"
- "Create a task to fix the login bug with high priority"
- "Assign the auth refactor task to Sarah"
- "Search for tasks related to payments"
- "Write a design doc for the new notification system"

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Start built server
npm start
```

## License

MIT

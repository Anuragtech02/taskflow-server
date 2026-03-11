import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  integer,
  boolean,
  jsonb,
  primaryKey,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Users ────────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash"),
  avatarUrl: text("avatar_url"),
  emailNotifications: boolean("email_notifications").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Workspaces ───────────────────────────────────────────────────────────────
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  subdomain: varchar("subdomain", { length: 63 }).unique(), // For multi-tenant subdomains
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  logoUrl: text("logo_url"),
  plan: varchar("plan", { length: 20 }).default("free"), // free, pro, enterprise
  status: varchar("status", { length: 20 }).default("active"), // active, suspended, trial
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Workspace Members ────────────────────────────────────────────────────────
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 50 }).notNull().default("member"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("wm_workspace_idx").on(t.workspaceId),
    index("wm_user_idx").on(t.userId),
  ]
);

// ─── Spaces ───────────────────────────────────────────────────────────────────
export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    color: varchar("color", { length: 7 }).default("#6366f1"),
    icon: varchar("icon", { length: 50 }).default("folder"),
    order: integer("order").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("spaces_workspace_idx").on(t.workspaceId)]
);

// ─── Folders ──────────────────────────────────────────────────────────────────
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    order: integer("order").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("folders_space_idx").on(t.spaceId)]
);

// ─── Lists ────────────────────────────────────────────────────────────────────
export const lists = pgTable(
  "lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    folderId: uuid("folder_id").references(() => folders.id, {
      onDelete: "cascade",
    }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    order: integer("order").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("lists_folder_idx").on(t.folderId),
    index("lists_space_idx").on(t.spaceId),
  ]
);

// ─── Tasks ────────────────────────────────────────────────────────────────────
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 500 }).notNull(),
    description: jsonb("description").default({}),
    status: varchar("status", { length: 50 }).default("todo"),
    priority: varchar("priority", { length: 20 }).default("none"),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dueDate: timestamp("due_date"),
    startDate: timestamp("start_date"),
    timeEstimate: integer("time_estimate"),
    timeSpent: integer("time_spent").default(0),
    order: integer("order").default(0),
    customFields: jsonb("custom_fields").default({}),
    parentTaskId: uuid("parent_task_id"),
    blockedBy: jsonb("blocked_by").default([]),
    blocks: jsonb("blocks").default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    archivedAt: timestamp("archived_at"),
  },
  (t) => [
    index("tasks_list_idx").on(t.listId),
    index("tasks_creator_idx").on(t.creatorId),
    index("tasks_status_idx").on(t.status),
    index("tasks_priority_idx").on(t.priority),
    index("tasks_parent_idx").on(t.parentTaskId),
    index("tasks_due_date_idx").on(t.dueDate),
    index("tasks_start_date_idx").on(t.startDate),
    index("tasks_archived_at_idx").on(t.archivedAt),
  ]
);

// ─── Task Assignees ───────────────────────────────────────────────────────────
export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index("ta_task_idx").on(t.taskId),
    index("ta_user_idx").on(t.userId),
  ]
);

// ─── Task Comments ────────────────────────────────────────────────────────────
export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("comments_task_idx").on(t.taskId)]
);

// ─── Task Activities ──────────────────────────────────────────────────────────
export const taskActivities = pgTable(
  "task_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 50 }).notNull(),
    field: varchar("field", { length: 50 }),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("activities_task_idx").on(t.taskId)]
);

// ─── Custom Field Definitions ─────────────────────────────────────────────────
export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    options: jsonb("options").default({}),
    order: integer("order").default(0),
  },
  (t) => [index("cfd_list_idx").on(t.listId)]
);

// ─── Time Entries ─────────────────────────────────────────────────────────────
export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startTime: timestamp("start_time").notNull(),
    endTime: timestamp("end_time"),
    duration: integer("duration"),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("te_task_idx").on(t.taskId),
    index("te_user_idx").on(t.userId),
  ]
);

// ─── Statuses ─────────────────────────────────────────────────────────────────
export const statuses = pgTable(
  "statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    color: varchar("color", { length: 7 }).default("#6366f1"),
    order: integer("order").default(0),
    isDefault: boolean("is_default").default(false),
  },
  (t) => [index("statuses_list_idx").on(t.listId)]
);

// ─── Labels ───────────────────────────────────────────────────────────────────
export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    color: varchar("color", { length: 7 }).default("#6366f1"),
  },
  (t) => [index("labels_workspace_idx").on(t.workspaceId)]
);

// ─── Task Labels ──────────────────────────────────────────────────────────────
export const taskLabels = pgTable(
  "task_labels",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.labelId] })]
);

// ─── Sprints ──────────────────────────────────────────────────────────────────
export const sprints = pgTable(
  "sprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    startDate: timestamp("start_date").notNull(),
    endDate: timestamp("end_date").notNull(),
    status: varchar("status", { length: 20 }).default("planned"),
    goal: text("goal"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("sprints_workspace_idx").on(t.workspaceId)]
);

// ─── Sprint Tasks ─────────────────────────────────────────────────────────────
export const sprintTasks = pgTable(
  "sprint_tasks",
  {
    sprintId: uuid("sprint_id")
      .notNull()
      .references(() => sprints.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.sprintId, t.taskId] })]
);

// ─── Views ────────────────────────────────────────────────────────────────────
export const views = pgTable(
  "views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id").references(() => lists.id, {
      onDelete: "cascade",
    }),
    spaceId: uuid("space_id").references(() => spaces.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    filters: jsonb("filters").default({}),
    sort: jsonb("sort").default({}),
  },
  (t) => [
    index("views_list_idx").on(t.listId),
    index("views_space_idx").on(t.spaceId),
  ]
);

// ─── Notifications ─────────────────────────────────────────────────────────────
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 50 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message"),
    read: boolean("read").default(false),
    entityType: varchar("entity_type", { length: 50 }),
    entityId: uuid("entity_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_read_idx").on(t.read),
    index("notifications_created_idx").on(t.createdAt),
  ]
);

// ─── Reminders ─────────────────────────────────────────────────────────────────
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    remindAt: timestamp("remind_at").notNull(),
    type: varchar("type", { length: 20 }).default("notification"), // notification, email, both
    sent: boolean("sent").default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("reminders_task_idx").on(t.taskId),
    index("reminders_user_idx").on(t.userId),
    index("reminders_sent_idx").on(t.sent),
    index("reminders_remind_at_idx").on(t.remindAt),
  ]
);

// ═══════════════════════════════════════════════════════════════════════════════
// RELATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const usersRelations = relations(users, ({ many }) => ({
  ownedWorkspaces: many(workspaces),
  workspaceMembers: many(workspaceMembers),
  createdTasks: many(tasks),
  taskAssignees: many(taskAssignees),
  taskComments: many(taskComments),
  taskActivities: many(taskActivities),
  timeEntries: many(timeEntries),
  notifications: many(notifications),
  reminders: many(reminders),
  apiKeys: many(apiKeys),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(users, {
    fields: [workspaces.ownerId],
    references: [users.id],
  }),
  members: many(workspaceMembers),
  spaces: many(spaces),
  labels: many(labels),
  sprints: many(sprints),
}));

export const workspaceMembersRelations = relations(
  workspaceMembers,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceMembers.workspaceId],
      references: [workspaces.id],
    }),
    user: one(users, {
      fields: [workspaceMembers.userId],
      references: [users.id],
    }),
  })
);

export const spacesRelations = relations(spaces, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [spaces.workspaceId],
    references: [workspaces.id],
  }),
  folders: many(folders),
  lists: many(lists),
  views: many(views),
}));

export const foldersRelations = relations(folders, ({ one, many }) => ({
  space: one(spaces, {
    fields: [folders.spaceId],
    references: [spaces.id],
  }),
  lists: many(lists),
}));

export const listsRelations = relations(lists, ({ one, many }) => ({
  folder: one(folders, {
    fields: [lists.folderId],
    references: [folders.id],
  }),
  space: one(spaces, {
    fields: [lists.spaceId],
    references: [spaces.id],
  }),
  tasks: many(tasks),
  customFieldDefinitions: many(customFieldDefinitions),
  statuses: many(statuses),
  views: many(views),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  list: one(lists, {
    fields: [tasks.listId],
    references: [lists.id],
  }),
  creator: one(users, {
    fields: [tasks.creatorId],
    references: [users.id],
  }),
  parentTask: one(tasks, {
    fields: [tasks.parentTaskId],
    references: [tasks.id],
    relationName: "subtasks",
  }),
  subtasks: many(tasks, { relationName: "subtasks" }),
  assignees: many(taskAssignees),
  comments: many(taskComments),
  activities: many(taskActivities),
  timeEntries: many(timeEntries),
  taskLabels: many(taskLabels),
  attachments: many(taskAttachments),
  reminders: many(reminders),
}));

export const taskAssigneesRelations = relations(taskAssignees, ({ one }) => ({
  task: one(tasks, {
    fields: [taskAssignees.taskId],
    references: [tasks.id],
  }),
  user: one(users, {
    fields: [taskAssignees.userId],
    references: [users.id],
  }),
}));

export const taskCommentsRelations = relations(taskComments, ({ one }) => ({
  task: one(tasks, {
    fields: [taskComments.taskId],
    references: [tasks.id],
  }),
  user: one(users, {
    fields: [taskComments.userId],
    references: [users.id],
  }),
}));

export const taskActivitiesRelations = relations(
  taskActivities,
  ({ one }) => ({
    task: one(tasks, {
      fields: [taskActivities.taskId],
      references: [tasks.id],
    }),
    user: one(users, {
      fields: [taskActivities.userId],
      references: [users.id],
    }),
  })
);

// ─── Task Attachments ─────────────────────────────────────────────────────────
export const taskAttachments = pgTable(
  "task_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    fileKey: text("file_key").notNull(),
    fileSize: integer("file_size").notNull(),
    mimeType: text("mime_type").notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("attachments_task_idx").on(t.taskId)]
);

export const taskAttachmentsRelations = relations(taskAttachments, ({ one }) => ({
  task: one(tasks, {
    fields: [taskAttachments.taskId],
    references: [tasks.id],
  }),
  uploadedByUser: one(users, {
    fields: [taskAttachments.uploadedBy],
    references: [users.id],
  }),
}));

export const customFieldDefinitionsRelations = relations(
  customFieldDefinitions,
  ({ one }) => ({
    list: one(lists, {
      fields: [customFieldDefinitions.listId],
      references: [lists.id],
    }),
  })
);

export const timeEntriesRelations = relations(timeEntries, ({ one }) => ({
  task: one(tasks, {
    fields: [timeEntries.taskId],
    references: [tasks.id],
  }),
  user: one(users, {
    fields: [timeEntries.userId],
    references: [users.id],
  }),
}));

export const statusesRelations = relations(statuses, ({ one }) => ({
  list: one(lists, {
    fields: [statuses.listId],
    references: [lists.id],
  }),
}));

export const labelsRelations = relations(labels, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [labels.workspaceId],
    references: [workspaces.id],
  }),
  taskLabels: many(taskLabels),
}));

export const taskLabelsRelations = relations(taskLabels, ({ one }) => ({
  task: one(tasks, {
    fields: [taskLabels.taskId],
    references: [tasks.id],
  }),
  label: one(labels, {
    fields: [taskLabels.labelId],
    references: [labels.id],
  }),
}));

export const sprintsRelations = relations(sprints, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [sprints.workspaceId],
    references: [workspaces.id],
  }),
  sprintTasks: many(sprintTasks),
}));

export const sprintTasksRelations = relations(sprintTasks, ({ one }) => ({
  sprint: one(sprints, {
    fields: [sprintTasks.sprintId],
    references: [sprints.id],
  }),
  task: one(tasks, {
    fields: [sprintTasks.taskId],
    references: [tasks.id],
  }),
}));

export const viewsRelations = relations(views, ({ one }) => ({
  list: one(lists, {
    fields: [views.listId],
    references: [lists.id],
  }),
  space: one(spaces, {
    fields: [views.spaceId],
    references: [spaces.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));

export const remindersRelations = relations(reminders, ({ one }) => ({
  task: one(tasks, {
    fields: [reminders.taskId],
    references: [tasks.id],
  }),
  user: one(users, {
    fields: [reminders.userId],
    references: [users.id],
  }),
}));

// ─── API Keys ─────────────────────────────────────────────────────────────────
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    keyHash: varchar("key_hash", { length: 255 }).notNull(),
    keyPrefix: varchar("key_prefix", { length: 20 }).notNull().default(""),
    name: varchar("name", { length: 255 }).notNull(),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("api_keys_user_idx").on(t.userId),
    index("api_keys_hash_idx").on(t.keyHash),
  ]
);

// ─── Automations ───────────────────────────────────────────────────────────────
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    triggerType: varchar("trigger_type", { length: 50 }).notNull(),
    triggerConfig: jsonb("trigger_config").default({}),
    actionType: varchar("action_type", { length: 50 }).notNull(),
    actionConfig: jsonb("action_config").default({}),
    enabled: boolean("enabled").default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("automations_workspace_idx").on(t.workspaceId)]
);

// ─── Documents ────────────────────────────────────────────────────────────────
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id").references(() => spaces.id, {
      onDelete: "cascade",
    }),
    title: varchar("title", { length: 255 }).notNull(),
    content: jsonb("content").default({}),
    icon: varchar("icon", { length: 50 }).default("file-text"),
    coverUrl: text("cover_url"),
    parentDocumentId: uuid("parent_document_id"),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ydocState: customType<{ data: Buffer }>({
      dataType() { return "bytea"; },
    })("ydoc_state"),
    isPublic: boolean("is_public").default(false),
    lastVersionAt: timestamp("last_version_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("documents_workspace_idx").on(t.workspaceId),
    index("documents_space_idx").on(t.spaceId),
    index("documents_parent_idx").on(t.parentDocumentId),
  ]
);

// ─── Document Shares ─────────────────────────────────────────────────────────
export const documentShares = pgTable(
  "document_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull().default("viewer"), // viewer | editor | commenter
    shareToken: varchar("share_token", { length: 64 }).unique(),
    shareType: varchar("share_type", { length: 20 }).notNull().default("user"), // user | link
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("doc_shares_document_idx").on(t.documentId),
    index("doc_shares_user_idx").on(t.userId),
    index("doc_shares_token_idx").on(t.shareToken),
  ]
);

// ─── Document Comments ───────────────────────────────────────────────────────
export const documentComments = pgTable(
  "document_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    markId: varchar("mark_id", { length: 64 }),
    quotedText: text("quoted_text"),
    parentCommentId: uuid("parent_comment_id"),
    resolved: boolean("resolved").default(false),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("doc_comments_document_idx").on(t.documentId),
    index("doc_comments_mark_idx").on(t.markId),
    index("doc_comments_parent_idx").on(t.parentCommentId),
  ]
);

// ─── Document Versions ───────────────────────────────────────────────────────
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    content: jsonb("content").default({}),
    ydocState: customType<{ data: Buffer }>({
      dataType() { return "bytea"; },
    })("ydoc_state"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("doc_versions_document_idx").on(t.documentId),
    index("doc_versions_number_idx").on(t.documentId, t.versionNumber),
  ]
);

// ─── Forms ────────────────────────────────────────────────────────────────────
export const forms = pgTable(
  "forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    listId: uuid("list_id").references(() => lists.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    fields: jsonb("fields").default([]),
    isPublic: boolean("is_public").default(false),
    slug: varchar("slug", { length: 255 }).notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("forms_workspace_idx").on(t.workspaceId),
    index("forms_list_idx").on(t.listId),
  ]
);

// ─── Goals (OKRs) ─────────────────────────────────────────────────────────────
export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    targetDate: timestamp("target_date"),
    status: varchar("status", { length: 20 }).default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("goals_workspace_idx").on(t.workspaceId)]
);

// ─── Key Results ─────────────────────────────────────────────────────────────
export const keyResults = pgTable(
  "key_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    targetValue: integer("target_value").notNull(),
    currentValue: integer("current_value").default(0),
    linkedTaskId: uuid("linked_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
  },
  (t) => [index("key_results_goal_idx").on(t.goalId)]
);

// ═══════════════════════════════════════════════════════════════════════════════
// RELATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

export const automationsRelations = relations(automations, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [automations.workspaceId],
    references: [workspaces.id],
  }),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [documents.workspaceId],
    references: [workspaces.id],
  }),
  space: one(spaces, {
    fields: [documents.spaceId],
    references: [spaces.id],
  }),
  parent: one(documents, {
    fields: [documents.parentDocumentId],
    references: [documents.id],
    relationName: "children",
  }),
  children: many(documents, { relationName: "children" }),
  creator: one(users, {
    fields: [documents.creatorId],
    references: [users.id],
  }),
  shares: many(documentShares),
  comments: many(documentComments),
  versions: many(documentVersions),
}));

export const documentSharesRelations = relations(documentShares, ({ one }) => ({
  document: one(documents, {
    fields: [documentShares.documentId],
    references: [documents.id],
  }),
  user: one(users, {
    fields: [documentShares.userId],
    references: [users.id],
  }),
}));

export const documentCommentsRelations = relations(documentComments, ({ one, many }) => ({
  document: one(documents, {
    fields: [documentComments.documentId],
    references: [documents.id],
  }),
  user: one(users, {
    fields: [documentComments.userId],
    references: [users.id],
  }),
  parent: one(documentComments, {
    fields: [documentComments.parentCommentId],
    references: [documentComments.id],
    relationName: "replies",
  }),
  replies: many(documentComments, { relationName: "replies" }),
  resolver: one(users, {
    fields: [documentComments.resolvedBy],
    references: [users.id],
    relationName: "resolvedComments",
  }),
}));

export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, {
    fields: [documentVersions.documentId],
    references: [documents.id],
  }),
  creator: one(users, {
    fields: [documentVersions.createdBy],
    references: [users.id],
  }),
}));

export const formsRelations = relations(forms, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [forms.workspaceId],
    references: [workspaces.id],
  }),
  list: one(lists, {
    fields: [forms.listId],
    references: [lists.id],
  }),
}));

// ─── Goals Relations ─────────────────────────────────────────────────────────
export const goalsRelations = relations(goals, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [goals.workspaceId],
    references: [workspaces.id],
  }),
  keyResults: many(keyResults),
}));

// ─── Key Results Relations ───────────────────────────────────────────────────
export const keyResultsRelations = relations(keyResults, ({ one }) => ({
  goal: one(goals, {
    fields: [keyResults.goalId],
    references: [goals.id],
  }),
  linkedTask: one(tasks, {
    fields: [keyResults.linkedTaskId],
    references: [tasks.id],
  }),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
export type Space = typeof spaces.$inferSelect;
export type NewSpace = typeof spaces.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskComment = typeof taskComments.$inferSelect;
export type NewTaskComment = typeof taskComments.$inferInsert;
export type TaskActivity = typeof taskActivities.$inferSelect;
export type NewTaskActivity = typeof taskActivities.$inferInsert;
export type CustomFieldDefinition = typeof customFieldDefinitions.$inferSelect;
export type NewCustomFieldDefinition = typeof customFieldDefinitions.$inferInsert;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;
export type Status = typeof statuses.$inferSelect;
export type NewStatus = typeof statuses.$inferInsert;
export type Label = typeof labels.$inferSelect;
export type NewLabel = typeof labels.$inferInsert;
export type Sprint = typeof sprints.$inferSelect;
export type NewSprint = typeof sprints.$inferInsert;
export type View = typeof views.$inferSelect;
export type NewView = typeof views.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type Automation = typeof automations.$inferSelect;
export type NewAutomation = typeof automations.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Form = typeof forms.$inferSelect;
export type NewForm = typeof forms.$inferInsert;
export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
export type KeyResult = typeof keyResults.$inferSelect;
export type NewKeyResult = typeof keyResults.$inferInsert;
export type TaskAttachment = typeof taskAttachments.$inferSelect;
export type NewTaskAttachment = typeof taskAttachments.$inferInsert;
export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type DocumentShare = typeof documentShares.$inferSelect;
export type NewDocumentShare = typeof documentShares.$inferInsert;
export type DocumentComment = typeof documentComments.$inferSelect;
export type NewDocumentComment = typeof documentComments.$inferInsert;
export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;

-- Automations table
CREATE TABLE "automations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
  "name" varchar(255) NOT NULL,
  "trigger_type" varchar(50) NOT NULL,
  "trigger_config" jsonb DEFAULT '{}'::jsonb,
  "action_type" varchar(50) NOT NULL,
  "action_config" jsonb DEFAULT '{}'::jsonb,
  "enabled" boolean DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX "automations_workspace_idx" ON "automations" USING btree ("workspace_id");

-- Documents table
CREATE TABLE "documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
  "space_id" uuid REFERENCES "public"."spaces"("id") ON DELETE cascade,
  "title" varchar(255) NOT NULL,
  "content" jsonb DEFAULT '{}'::jsonb,
  "icon" varchar(50) DEFAULT 'file-text',
  "cover_url" text,
  "parent_document_id" uuid,
  "creator_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX "documents_workspace_idx" ON "documents" USING btree ("workspace_id");
CREATE INDEX "documents_space_idx" ON "documents" USING btree ("space_id");
CREATE INDEX "documents_parent_idx" ON "documents" USING btree ("parent_document_id");

-- Forms table
CREATE TABLE "forms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
  "list_id" uuid REFERENCES "public"."lists"("id") ON DELETE cascade,
  "name" varchar(255) NOT NULL,
  "description" text,
  "fields" jsonb DEFAULT '[]'::jsonb,
  "is_public" boolean DEFAULT false,
  "slug" varchar(255) NOT NULL UNIQUE,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX "forms_workspace_idx" ON "forms" USING btree ("workspace_id");
CREATE INDEX "forms_list_idx" ON "forms" USING btree ("list_id");

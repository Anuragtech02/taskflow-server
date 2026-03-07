ALTER TABLE "tasks" ADD COLUMN "blocked_by" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "blocks" jsonb DEFAULT '[]'::jsonb;
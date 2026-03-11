ALTER TABLE "tasks" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
CREATE INDEX "tasks_archived_at_idx" ON "tasks" USING btree ("archived_at");
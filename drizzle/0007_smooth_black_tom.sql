ALTER TABLE "tasks" ADD COLUMN "start_date" timestamp;--> statement-breakpoint
CREATE INDEX "tasks_start_date_idx" ON "tasks" USING btree ("start_date");
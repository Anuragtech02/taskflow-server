CREATE TABLE "sprint_retro_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sprint_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"category" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"converted_task_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sprint_retro_items" ADD CONSTRAINT "sprint_retro_items_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_retro_items" ADD CONSTRAINT "sprint_retro_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_retro_items" ADD CONSTRAINT "sprint_retro_items_converted_task_id_tasks_id_fk" FOREIGN KEY ("converted_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sprint_retro_items_sprint_idx" ON "sprint_retro_items" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "sprint_retro_items_user_idx" ON "sprint_retro_items" USING btree ("user_id");
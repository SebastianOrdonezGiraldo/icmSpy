CREATE TABLE "instagram_attempts" (
	"run_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"kind" text NOT NULL,
	"request_cursor" text,
	"operation_key" "bytea" NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"epoch" integer NOT NULL,
	"error" text,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "instagram_attempts_pk" PRIMARY KEY("run_id","attempt_no"),
	CONSTRAINT "instagram_attempts_run_attempt_kind_key_uq" UNIQUE("run_id","attempt_no","kind","operation_key"),
	CONSTRAINT "instagram_attempts_attempt_no_check" CHECK ("instagram_attempts"."attempt_no" > 0),
	CONSTRAINT "instagram_attempts_kind_check" CHECK ("instagram_attempts"."kind" in ('resolve', 'page')),
	CONSTRAINT "instagram_attempts_resolve_cursor_check" CHECK ("instagram_attempts"."kind" <> 'resolve' or "instagram_attempts"."request_cursor" is null),
	CONSTRAINT "instagram_attempts_operation_key_check" CHECK ("instagram_attempts"."operation_key" = sha256(convert_to(case when kind = 'resolve' then 'R' when request_cursor is null then 'N' else 'S' || request_cursor end, 'UTF8'))),
	CONSTRAINT "instagram_attempts_status_check" CHECK ("instagram_attempts"."status" in ('reserved', 'succeeded', 'failed', 'uncertain')),
	CONSTRAINT "instagram_attempts_error_check" CHECK (("instagram_attempts"."status" = 'failed') = ("instagram_attempts"."error" is not null)),
	CONSTRAINT "instagram_attempts_finished_check" CHECK (("instagram_attempts"."status" = 'reserved') = ("instagram_attempts"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "instagram_pages" (
	"run_id" uuid NOT NULL,
	"page_no" integer NOT NULL,
	"attempt_no" integer NOT NULL,
	"attempt_kind" text DEFAULT 'page' NOT NULL,
	"operation_key" "bytea" NOT NULL,
	"next_cursor" text,
	"limited" boolean NOT NULL,
	"received" integer NOT NULL,
	"new_unique" integer NOT NULL,
	"duplicates" integer NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instagram_pages_pk" PRIMARY KEY("run_id","page_no"),
	CONSTRAINT "instagram_pages_run_operation_uq" UNIQUE("run_id","operation_key"),
	CONSTRAINT "instagram_pages_run_attempt_uq" UNIQUE("run_id","attempt_no"),
	CONSTRAINT "instagram_pages_page_no_check" CHECK ("instagram_pages"."page_no" > 0),
	CONSTRAINT "instagram_pages_attempt_kind_check" CHECK ("instagram_pages"."attempt_kind" = 'page'),
	CONSTRAINT "instagram_pages_counts_check" CHECK ("instagram_pages"."received" >= 0 and "instagram_pages"."new_unique" >= 0 and "instagram_pages"."duplicates" >= 0 and "instagram_pages"."received" = "instagram_pages"."new_unique" + "instagram_pages"."duplicates")
);
--> statement-breakpoint
CREATE TABLE "instagram_run_followers" (
	"run_id" uuid NOT NULL,
	"follower_pk" text NOT NULL,
	"ord" integer NOT NULL,
	"username" text NOT NULL,
	"is_private" boolean NOT NULL,
	"privacy_conflict" boolean DEFAULT false NOT NULL,
	"first_page_no" integer NOT NULL,
	CONSTRAINT "instagram_run_followers_pk" PRIMARY KEY("run_id","follower_pk"),
	CONSTRAINT "instagram_run_followers_run_ord_uq" UNIQUE("run_id","ord"),
	CONSTRAINT "instagram_run_followers_ord_check" CHECK ("instagram_run_followers"."ord" > 0),
	CONSTRAINT "instagram_run_followers_conflict_check" CHECK (not "instagram_run_followers"."privacy_conflict" or "instagram_run_followers"."is_private")
);
--> statement-breakpoint
CREATE TABLE "instagram_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"requested" integer NOT NULL,
	"budget_max_calls" integer NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"unique_count" integer DEFAULT 0 NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"list_state" text DEFAULT 'not_started' NOT NULL,
	"cursor" text,
	"target_pk" text,
	"target_username" text,
	"target_follower_count" integer,
	"target_is_private" boolean,
	"target_is_verified" boolean,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instagram_runs_requested_check" CHECK ("instagram_runs"."requested" > 0),
	CONSTRAINT "instagram_runs_budget_check" CHECK ("instagram_runs"."budget_max_calls" > 0),
	CONSTRAINT "instagram_runs_counters_check" CHECK ("instagram_runs"."attempt_count" >= 0 and "instagram_runs"."page_count" >= 0 and "instagram_runs"."unique_count" >= 0 and "instagram_runs"."epoch" >= 0 and "instagram_runs"."revision" >= 0),
	CONSTRAINT "instagram_runs_attempts_within_budget" CHECK ("instagram_runs"."attempt_count" <= "instagram_runs"."budget_max_calls"),
	CONSTRAINT "instagram_runs_pages_within_attempts" CHECK ("instagram_runs"."page_count" <= "instagram_runs"."attempt_count"),
	CONSTRAINT "instagram_runs_list_state_check" CHECK ("instagram_runs"."list_state" in ('not_started', 'open', 'limited', 'exhausted', 'cursor_repeated', 'cursor_cycle')),
	CONSTRAINT "instagram_runs_target_check" CHECK (("instagram_runs"."target_pk" is null and "instagram_runs"."target_username" is null and "instagram_runs"."target_follower_count" is null and "instagram_runs"."target_is_private" is null and "instagram_runs"."target_is_verified" is null) or ("instagram_runs"."target_pk" is not null and "instagram_runs"."target_username" is not null and "instagram_runs"."target_is_private" is not null and "instagram_runs"."target_is_verified" is not null))
);
--> statement-breakpoint
ALTER TABLE "instagram_attempts" ADD CONSTRAINT "instagram_attempts_run_id_instagram_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."instagram_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_pages" ADD CONSTRAINT "instagram_pages_run_id_instagram_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."instagram_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_pages" ADD CONSTRAINT "instagram_pages_attempt_fk" FOREIGN KEY ("run_id","attempt_no","attempt_kind","operation_key") REFERENCES "public"."instagram_attempts"("run_id","attempt_no","kind","operation_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_run_followers" ADD CONSTRAINT "instagram_run_followers_run_id_instagram_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."instagram_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_run_followers" ADD CONSTRAINT "instagram_run_followers_page_fk" FOREIGN KEY ("run_id","first_page_no") REFERENCES "public"."instagram_pages"("run_id","page_no") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instagram_attempts_active_operation_uq" ON "instagram_attempts" USING btree ("run_id","operation_key") WHERE "instagram_attempts"."status" = 'reserved';--> statement-breakpoint
CREATE UNIQUE INDEX "instagram_attempts_resolved_once_uq" ON "instagram_attempts" USING btree ("run_id") WHERE "instagram_attempts"."kind" = 'resolve' and "instagram_attempts"."status" = 'succeeded';
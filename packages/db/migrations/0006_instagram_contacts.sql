CREATE TABLE "instagram_follower_contacts" (
	"run_id" uuid NOT NULL,
	"follower_pk" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"original" text NOT NULL,
	"source" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instagram_follower_contacts_pk" PRIMARY KEY("run_id","follower_pk","kind","value"),
	CONSTRAINT "instagram_follower_contacts_kind_check" CHECK ("instagram_follower_contacts"."kind" in ('email', 'phone')),
	CONSTRAINT "instagram_follower_contacts_source_check" CHECK ("instagram_follower_contacts"."source" in ('button', 'biography')),
	CONSTRAINT "instagram_follower_contacts_value_check" CHECK ("instagram_follower_contacts"."value" <> '')
);
--> statement-breakpoint
ALTER TABLE "instagram_attempts" DROP CONSTRAINT "instagram_attempts_kind_check";--> statement-breakpoint
ALTER TABLE "instagram_attempts" DROP CONSTRAINT "instagram_attempts_resolve_cursor_check";--> statement-breakpoint
ALTER TABLE "instagram_attempts" DROP CONSTRAINT "instagram_attempts_operation_key_check";--> statement-breakpoint
ALTER TABLE "instagram_attempts" ADD COLUMN "profile_pk" text;--> statement-breakpoint
ALTER TABLE "instagram_run_followers" ADD COLUMN "enrichment" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
-- Datos existentes: un seguidor privado nunca queda pendiente de consultar.
UPDATE "instagram_run_followers" SET "enrichment" = 'private' WHERE "is_private";--> statement-breakpoint
ALTER TABLE "instagram_run_followers" ADD COLUMN "enriched_attempt_no" integer;--> statement-breakpoint
ALTER TABLE "instagram_runs" ADD COLUMN "enrich_profiles" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instagram_follower_contacts" ADD CONSTRAINT "instagram_follower_contacts_follower_fk" FOREIGN KEY ("run_id","follower_pk") REFERENCES "public"."instagram_run_followers"("run_id","follower_pk") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_follower_contacts" ADD CONSTRAINT "instagram_follower_contacts_attempt_fk" FOREIGN KEY ("run_id","attempt_no") REFERENCES "public"."instagram_attempts"("run_id","attempt_no") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_run_followers" ADD CONSTRAINT "instagram_run_followers_enriched_attempt_fk" FOREIGN KEY ("run_id","enriched_attempt_no") REFERENCES "public"."instagram_attempts"("run_id","attempt_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_attempts" ADD CONSTRAINT "instagram_attempts_profile_pk_check" CHECK (("instagram_attempts"."kind" = 'profile') = ("instagram_attempts"."profile_pk" is not null));--> statement-breakpoint
ALTER TABLE "instagram_attempts" ADD CONSTRAINT "instagram_attempts_kind_check" CHECK ("instagram_attempts"."kind" in ('resolve', 'page', 'profile'));--> statement-breakpoint
ALTER TABLE "instagram_attempts" ADD CONSTRAINT "instagram_attempts_resolve_cursor_check" CHECK ("instagram_attempts"."kind" = 'page' or "instagram_attempts"."request_cursor" is null);--> statement-breakpoint
ALTER TABLE "instagram_attempts" ADD CONSTRAINT "instagram_attempts_operation_key_check" CHECK ("instagram_attempts"."operation_key" = sha256(convert_to(case when kind = 'resolve' then 'R' when kind = 'profile' then 'P' || profile_pk when request_cursor is null then 'N' else 'S' || request_cursor end, 'UTF8')));--> statement-breakpoint
ALTER TABLE "instagram_run_followers" ADD CONSTRAINT "instagram_run_followers_enrichment_check" CHECK ("instagram_run_followers"."enrichment" in ('pending', 'done', 'private', 'not_found'));--> statement-breakpoint
ALTER TABLE "instagram_run_followers" ADD CONSTRAINT "instagram_run_followers_private_check" CHECK (not ("instagram_run_followers"."is_private" and "instagram_run_followers"."enrichment" = 'pending'));--> statement-breakpoint
ALTER TABLE "instagram_run_followers" ADD CONSTRAINT "instagram_run_followers_enriched_attempt_check" CHECK (("instagram_run_followers"."enrichment" in ('done', 'not_found') and "instagram_run_followers"."enriched_attempt_no" is not null) or ("instagram_run_followers"."enrichment" = 'pending' and "instagram_run_followers"."enriched_attempt_no" is null) or "instagram_run_followers"."enrichment" = 'private');
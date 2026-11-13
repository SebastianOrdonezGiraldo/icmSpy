CREATE TABLE "search_run_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_run_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid,
	"source_id" uuid NOT NULL,
	"source_record_id" uuid,
	"company_is_new" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_run_results_run_company_site_uq" UNIQUE NULLS NOT DISTINCT("search_run_id","company_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "search_run_results" ADD CONSTRAINT "search_run_results_search_run_id_search_runs_id_fk" FOREIGN KEY ("search_run_id") REFERENCES "public"."search_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_run_results" ADD CONSTRAINT "search_run_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_run_results" ADD CONSTRAINT "search_run_results_site_id_company_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."company_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_run_results" ADD CONSTRAINT "search_run_results_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_run_results" ADD CONSTRAINT "search_run_results_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_run_results_run_company_idx" ON "search_run_results" USING btree ("search_run_id","company_id");
CREATE TABLE "company_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"provider_code" text,
	"name" text NOT NULL,
	"address" text,
	"city_code" text,
	"city" text,
	"department" text,
	"source_cutoff_at" timestamp with time zone,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_point_sites" (
	"contact_point_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	CONSTRAINT "contact_point_sites_contact_point_id_site_id_pk" PRIMARY KEY("contact_point_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "search_runs" ADD COLUMN "stats" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "search_runs" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "search_runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "company_sites" ADD CONSTRAINT "company_sites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_sites" ADD CONSTRAINT "company_sites_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_point_sites" ADD CONSTRAINT "contact_point_sites_contact_point_id_contact_points_id_fk" FOREIGN KEY ("contact_point_id") REFERENCES "public"."contact_points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_point_sites" ADD CONSTRAINT "contact_point_sites_site_id_company_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."company_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_sites_source_external_uq" ON "company_sites" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "company_sites_company_idx" ON "company_sites" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_sites_source_provider_idx" ON "company_sites" USING btree ("source_id","provider_code");--> statement-breakpoint
CREATE INDEX "contact_point_sites_site_idx" ON "contact_point_sites" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_provenance_entity_field_record_uq" ON "data_provenance" USING btree ("entity_type","entity_id","field","source_record_id");--> statement-breakpoint
CREATE INDEX "search_runs_adapter_created_idx" ON "search_runs" USING btree ("adapter","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "search_runs_active_uq" ON "search_runs" USING btree ("adapter",md5("query"::text)) WHERE "search_runs"."status" in ('queued', 'running');
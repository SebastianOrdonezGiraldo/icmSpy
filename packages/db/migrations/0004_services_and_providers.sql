ALTER TYPE "public"."company_type" ADD VALUE 'profesional_independiente';--> statement-breakpoint
CREATE TABLE "search_run_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_run_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid,
	"source_id" uuid NOT NULL,
	"source_record_id" uuid,
	"match_type" text NOT NULL,
	"concept_kind" text,
	"service_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_run_matches_uq" UNIQUE NULLS NOT DISTINCT("search_run_id","company_id","site_id","source_id","match_type","service_code"),
	CONSTRAINT "search_run_matches_type_check" CHECK ("search_run_matches"."match_type" in ('service', 'related', 'name'))
);
--> statement-breakpoint
CREATE TABLE "site_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_record_id" uuid,
	"service_code" text NOT NULL,
	"service_name" text NOT NULL,
	"status" text,
	"modalities" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_url" text,
	"source_cutoff_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_services_site_source_code_uq" UNIQUE("site_id","source_id","service_code")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "identification_type" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "identification_number" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "provider_class" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "person_kind" text;--> statement-breakpoint
ALTER TABLE "search_run_matches" ADD CONSTRAINT "search_run_matches_search_run_id_search_runs_id_fk" FOREIGN KEY ("search_run_id") REFERENCES "public"."search_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_run_matches" ADD CONSTRAINT "search_run_matches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_run_matches" ADD CONSTRAINT "search_run_matches_site_id_company_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."company_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_run_matches" ADD CONSTRAINT "search_run_matches_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_run_matches" ADD CONSTRAINT "search_run_matches_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_services" ADD CONSTRAINT "site_services_site_id_company_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."company_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_services" ADD CONSTRAINT "site_services_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_services" ADD CONSTRAINT "site_services_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_run_matches_run_company_idx" ON "search_run_matches" USING btree ("search_run_id","company_id");--> statement-breakpoint
CREATE INDEX "site_services_code_idx" ON "site_services" USING btree ("service_code");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_identification_uq" ON "companies" USING btree ("identification_type","identification_number") WHERE "companies"."identification_type" is not null and "companies"."identification_number" is not null;--> statement-breakpoint
-- Datos existentes (evidencia determinista; nada se presume):
-- 1. `nit` solo se rellenaba cuando REPS declaraba tipoid = NI: esas empresas
--    quedan con identificación NI y el mismo número.
UPDATE "companies"
SET "identification_type" = 'NI', "identification_number" = "nit"
WHERE "nit" IS NOT NULL AND "identification_type" IS NULL;
--> statement-breakpoint
-- 2. Clase de prestador tal como la publica el original REPS más reciente de sus sedes.
UPDATE "companies" AS c
SET "provider_class" = x."clase"
FROM (
  SELECT DISTINCT ON (s."company_id") s."company_id", sr."payload"->>'claseprestador' AS "clase"
  FROM "company_sites" AS s
  JOIN "sources" AS src ON src."id" = s."source_id" AND src."key" = 'reps'
  JOIN "source_records" AS sr ON sr."source_id" = s."source_id" AND sr."external_id" = s."external_id"
  WHERE sr."payload" ? 'claseprestador'
  ORDER BY s."company_id", sr."fetched_at" DESC
) AS x
WHERE x."company_id" = c."id" AND c."provider_class" IS NULL;
--> statement-breakpoint
-- 3. Las búsquedas anteriores (consulta v2) solo encontraban por nombre: sus
--    resultados quedan registrados como coincidencias de nombre.
INSERT INTO "search_run_matches" ("search_run_id", "company_id", "site_id", "source_id", "source_record_id", "match_type")
SELECT r."search_run_id", r."company_id", r."site_id", r."source_id", r."source_record_id", 'name'
FROM "search_run_results" AS r
JOIN "search_runs" AS sr ON sr."id" = r."search_run_id"
WHERE sr."query"->>'v' = '2'
ON CONFLICT DO NOTHING;

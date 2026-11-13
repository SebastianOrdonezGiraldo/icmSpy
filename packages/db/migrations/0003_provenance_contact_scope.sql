ALTER TABLE "data_provenance" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "data_provenance" ADD CONSTRAINT "data_provenance_scope_check" CHECK ("data_provenance"."scope" is null or "data_provenance"."scope" in ('company', 'site'));--> statement-breakpoint
-- Ámbito de los contactos ya incorporados desde REPS. Evidencia determinista: el
-- adaptador REPS (apps/api/src/modules/discovery/adapters/reps.ts, resolveRepsRow)
-- declara email_prestador y telefonoprestador como contactos del prestador
-- ("company") y email_sede y t_lefonosede como contactos de la sede ("site").
-- Solo se tocan filas de procedencia de contactos cuyo original es de REPS; el
-- resto queda en null (sin evidencia, no se presume ningún ámbito).
UPDATE "data_provenance" AS d
SET "scope" = CASE WHEN d."field" IN ('email_prestador', 'telefonoprestador') THEN 'company' ELSE 'site' END
FROM "source_records" AS sr
JOIN "sources" AS s ON s."id" = sr."source_id"
WHERE d."source_record_id" = sr."id"
  AND s."key" = 'reps'
  AND d."entity_type" = 'contact_point'
  AND d."field" IN ('email_prestador', 'telefonoprestador', 'email_sede', 't_lefonosede')
  AND d."scope" IS NULL;

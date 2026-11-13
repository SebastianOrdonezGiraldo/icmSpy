import {
  companies,
  companySites,
  contactPointSites,
  contactPoints,
  type DbExecutor,
  dataProvenance,
  searchRunResults,
  sources,
} from "@icmspy/db";
import type { SearchResultItem, SearchRunResultsResponse } from "@icmspy/shared";
import { and, asc, countDistinct, eq, inArray, sql } from "drizzle-orm";

/**
 * Empresas que encontró una ejecución, paginadas por empresa. Sale de
 * `search_run_results`, no del catálogo: incluye las empresas que ya existían
 * y nada que la ejecución no haya encontrado.
 *
 * Contactos: los generales de la empresa (publicados con ámbito "company" en la
 * procedencia, aunque también estén vinculados a alguna sede) y los de las
 * sedes que coincidieron. Los exclusivos de otras sedes de la misma empresa no
 * se muestran aquí (están en la ficha). Consultar no crea ni modifica nada.
 */
export async function getSearchRunResults(
  db: DbExecutor,
  searchRunId: string,
  page: number,
  pageSize: number,
): Promise<SearchRunResultsResponse> {
  const byRun = eq(searchRunResults.searchRunId, searchRunId);
  const [totals] = await db
    .select({ total: countDistinct(searchRunResults.companyId) })
    .from(searchRunResults)
    .where(byRun);
  const total = totals?.total ?? 0;
  if (total === 0) return { items: [], page, pageSize, total };

  const rows = await db
    .select({
      companyId: companies.id,
      legalName: companies.legalName,
      nit: companies.nit,
      city: companies.city,
      department: companies.department,
      isNew: sql<boolean>`bool_or(${searchRunResults.companyIsNew})`,
      sourceKeys: sql<string[]>`array_agg(distinct ${sources.key} order by ${sources.key})`,
    })
    .from(searchRunResults)
    .innerJoin(companies, eq(companies.id, searchRunResults.companyId))
    .innerJoin(sources, eq(sources.id, searchRunResults.sourceId))
    .where(byRun)
    .groupBy(companies.id)
    .orderBy(asc(companies.legalName), asc(companies.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const companyIds = rows.map((r) => r.companyId);

  const sites = await db
    .select({
      companyId: searchRunResults.companyId,
      id: companySites.id,
      name: companySites.name,
      externalId: companySites.externalId,
      address: companySites.address,
      city: companySites.city,
      department: companySites.department,
    })
    .from(searchRunResults)
    .innerJoin(companySites, eq(companySites.id, searchRunResults.siteId))
    .where(and(byRun, inArray(searchRunResults.companyId, companyIds)))
    .orderBy(asc(companySites.city), asc(companySites.name), asc(companySites.externalId));

  const points = await db
    .select({
      id: contactPoints.id,
      companyId: contactPoints.companyId,
      kind: contactPoints.kind,
      value: contactPoints.value,
      valueNormalized: contactPoints.valueNormalized,
      validationStatus: contactPoints.validationStatus,
    })
    .from(contactPoints)
    .where(inArray(contactPoints.companyId, companyIds))
    .orderBy(asc(contactPoints.kind), asc(contactPoints.valueNormalized));
  const links = points.length
    ? await db
        .select()
        .from(contactPointSites)
        .where(
          inArray(
            contactPointSites.contactPointId,
            points.map((p) => p.id),
          ),
        )
    : [];
  const linksByPoint = new Map<string, string[]>();
  for (const l of links) {
    linksByPoint.set(l.contactPointId, [...(linksByPoint.get(l.contactPointId) ?? []), l.siteId]);
  }

  // Contactos que alguna fuente publicó como de la empresa (no de una sede). Se
  // lee de la procedencia de cualquier registro y ejecución: estar vinculado
  // también a una sede no le quita el ámbito general. Una fila por contacto.
  const companyWide = new Set(
    points.length
      ? (
          await db
            .selectDistinct({ id: dataProvenance.entityId })
            .from(dataProvenance)
            .where(
              and(
                eq(dataProvenance.entityType, "contact_point"),
                eq(dataProvenance.scope, "company"),
                inArray(
                  dataProvenance.entityId,
                  points.map((p) => p.id),
                ),
              ),
            )
        ).map((r) => r.id)
      : [],
  );

  const items: SearchResultItem[] = rows.map((r) => {
    const ownMatched = sites.filter((s) => s.companyId === r.companyId);
    const ownMatchedIds = new Set(ownMatched.map((s) => s.id));
    return {
      ...r,
      isNew: Boolean(r.isNew),
      matchedSites: ownMatched.map(({ companyId: _c, ...s }) => s),
      contacts: points
        .filter((p) => p.companyId === r.companyId)
        .map(({ companyId: _c, ...p }) => ({
          ...p,
          companyWide: companyWide.has(p.id),
          // Solo sedes que coincidieron; un vínculo con otra sede no se muestra.
          siteIds: (linksByPoint.get(p.id) ?? []).filter((id) => ownMatchedIds.has(id)),
        }))
        // General de la empresa, o publicado en una sede que coincidió. Los exclusivos
        // de otras sedes quedan fuera (están en la ficha de la empresa).
        .filter((p) => p.companyWide || p.siteIds.length > 0),
    };
  });
  return { items, page, pageSize, total };
}

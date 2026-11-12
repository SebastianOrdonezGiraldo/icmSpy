import {
  companies,
  contactPoints,
  type Db,
  dataProvenance,
  sourceRecords,
  sources,
} from "@icmspy/db";
import type {
  CompanyDetail,
  CompanyListQuery,
  CompanyListResponse,
  ContactPointDetail,
} from "@icmspy/shared";
import { and, asc, count, eq, exists, ilike, inArray, or, type SQL, sql } from "drizzle-orm";

function buildFilters(db: Db, q: CompanyListQuery): SQL | undefined {
  const filters: (SQL | undefined)[] = [];
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, "\\$&")}%`;
    filters.push(
      or(
        ilike(companies.legalName, like),
        ilike(companies.tradeName, like),
        eq(companies.nit, q.q),
      ),
    );
  }
  if (q.type) filters.push(eq(companies.companyType, q.type));
  if (q.department) filters.push(ilike(companies.department, q.department));
  if (q.city) filters.push(ilike(companies.city, q.city));
  if (q.hasEmail) {
    filters.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(contactPoints)
          .where(and(eq(contactPoints.companyId, companies.id), eq(contactPoints.kind, "email"))),
      ),
    );
  }
  return and(...filters);
}

export async function listCompanies(db: Db, q: CompanyListQuery): Promise<CompanyListResponse> {
  const where = buildFilters(db, q);
  const [items, totals] = await Promise.all([
    db
      .select({
        id: companies.id,
        nit: companies.nit,
        legalName: companies.legalName,
        tradeName: companies.tradeName,
        domain: companies.domain,
        city: companies.city,
        department: companies.department,
        companyType: companies.companyType,
        contactCount: sql<number>`(select count(*)::int from ${contactPoints} where ${contactPoints.companyId} = ${companies.id})`,
      })
      .from(companies)
      .where(where)
      .orderBy(asc(companies.legalName), asc(companies.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ total: count() }).from(companies).where(where),
  ]);
  return { items, page: q.page, pageSize: q.pageSize, total: totals[0]?.total ?? 0 };
}

export async function getCompany(db: Db, id: string): Promise<CompanyDetail | null> {
  const [company] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  if (!company) return null;

  const points = await db
    .select()
    .from(contactPoints)
    .where(eq(contactPoints.companyId, id))
    .orderBy(asc(contactPoints.kind), asc(contactPoints.value));

  const provenance = points.length
    ? await db
        .select({
          entityId: dataProvenance.entityId,
          url: dataProvenance.url,
          observedAt: dataProvenance.observedAt,
          sourceKey: sources.key,
        })
        .from(dataProvenance)
        .innerJoin(sourceRecords, eq(sourceRecords.id, dataProvenance.sourceRecordId))
        .innerJoin(sources, eq(sources.id, sourceRecords.sourceId))
        .where(
          and(
            eq(dataProvenance.entityType, "contact_point"),
            inArray(
              dataProvenance.entityId,
              points.map((p) => p.id),
            ),
          ),
        )
    : [];

  const byPoint = new Map<string, ContactPointDetail["sources"]>();
  for (const p of provenance) {
    const list = byPoint.get(p.entityId) ?? [];
    list.push({ sourceKey: p.sourceKey, url: p.url, observedAt: p.observedAt.toISOString() });
    byPoint.set(p.entityId, list);
  }

  return {
    id: company.id,
    nit: company.nit,
    legalName: company.legalName,
    tradeName: company.tradeName,
    domain: company.domain,
    city: company.city,
    cityCode: company.cityCode,
    department: company.department,
    companyType: company.companyType,
    ciiuCodes: company.ciiuCodes,
    createdAt: company.createdAt.toISOString(),
    contactPoints: points.map((p) => ({
      id: p.id,
      kind: p.kind,
      value: p.value,
      isRoleAddress: p.isRoleAddress,
      validationStatus: p.validationStatus,
      isPrimary: p.isPrimary,
      sources: byPoint.get(p.id) ?? [],
    })),
  };
}

import type { CompanyDetail, ContactPointDetail } from "@icmspy/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import { formatDate, formatPhone, SOURCE_FIELD_LABELS, SOURCE_LABELS } from "@/lib/format";

export function CompanyPage() {
  const { id } = useParams({ from: "/app/companies/$id" });
  const { data, isPending, isError } = useQuery({
    queryKey: ["company", id],
    queryFn: () => apiGet<CompanyDetail>(`/companies/${id}`),
  });

  if (isPending) return <p className="text-muted-foreground">Cargando…</p>;
  if (isError) return <p className="text-destructive">No se encontró la empresa.</p>;

  const siteNames = new Map(data.sites.map((s) => [s.id, s.name]));
  const cutoffs = [...new Set(data.sites.map((s) => s.sourceCutoffAt).filter(Boolean))];

  return (
    <div className="space-y-4">
      <Link to="/" className="text-sm text-muted-foreground hover:underline">
        ← Empresas
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{data.tradeName ?? data.legalName}</h1>
        <p className="text-sm text-muted-foreground">
          {[data.legalName, data.nit && `NIT ${data.nit}`, data.city, data.department]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {data.sites.length > 0 && (
        <Card className="overflow-x-auto p-4">
          <h2 className="font-medium">Sedes ({data.sites.length})</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Según {SOURCE_LABELS[data.sites[0]?.sourceKey ?? ""] ?? data.sites[0]?.sourceKey}
            {cutoffs.length > 0 && `, corte al ${cutoffs.map((c) => formatDate(c)).join(" / ")}`}.
            No confirma que la habilitación siga vigente hoy.
          </p>
          <table className="mt-2 w-full text-sm">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Sede</th>
                <th className="py-2 pr-4 font-medium">Municipio</th>
                <th className="py-2 pr-4 font-medium">Dirección</th>
                <th className="py-2 font-medium">Código</th>
              </tr>
            </thead>
            <tbody>
              {data.sites.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">{s.name}</td>
                  <td className="py-2 pr-4">
                    {[s.city, s.department].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="py-2 pr-4">{s.address ?? "—"}</td>
                  <td className="py-2">
                    {s.sourceUrl ? (
                      <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                        {s.externalId}
                      </a>
                    ) : (
                      s.externalId
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="font-medium">Contactos</h2>
        {data.contactPoints.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Sin contactos todavía.</p>
        ) : (
          <ul className="mt-2 divide-y text-sm">
            {data.contactPoints.map((p) => (
              <li key={p.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-20 text-muted-foreground">{p.kind}</span>
                  <span className="font-medium">{p.value}</span>
                  {p.kind === "phone" &&
                    p.valueNormalized.replace(/\D/g, "") !== p.value.replace(/\D/g, "") && (
                      <span className="text-muted-foreground" title="Número para marcar hoy">
                        → {formatPhone(p.valueNormalized)}
                      </span>
                    )}
                  <span
                    className="rounded bg-muted px-1.5 py-0.5 text-xs"
                    title="Estado de verificación: unknown = sin verificar"
                  >
                    {p.validationStatus}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {p.siteIds.length > 0
                    ? `Sede: ${p.siteIds.map((id) => siteNames.get(id) ?? "—").join(", ")}`
                    : "De la empresa"}
                </p>
                <Sources sources={p.sources} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Agrupa la procedencia por fuente y campo; cada registro original queda enlazado. */
function Sources({ sources }: { sources: ContactPointDetail["sources"] }) {
  if (sources.length === 0) {
    return <p className="text-xs text-muted-foreground">Fuente: sin registrar</p>;
  }
  const groups = new Map<string, ContactPointDetail["sources"]>();
  for (const s of sources) {
    const key = `${s.sourceKey}|${s.field}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return (
    <p className="text-xs text-muted-foreground">
      Fuente:{" "}
      {[...groups.entries()].map(([key, list], gi) => {
        const first = list[0];
        if (!first) return null;
        const urls = [...new Set(list.map((s) => s.url).filter((u): u is string => Boolean(u)))];
        return (
          <span key={key}>
            {gi > 0 && "; "}
            {SOURCE_LABELS[first.sourceKey] ?? first.sourceKey}
            {first.field && ` · ${SOURCE_FIELD_LABELS[first.field] ?? first.field}`}
            {urls.length > 0 && " · "}
            {urls.map((url, i) => (
              <span key={url}>
                {i > 0 && ", "}
                <a href={url} target="_blank" rel="noreferrer" className="underline">
                  {urls.length === 1 ? "ver registro" : `registro ${i + 1}`}
                </a>
              </span>
            ))}
          </span>
        );
      })}
    </p>
  );
}

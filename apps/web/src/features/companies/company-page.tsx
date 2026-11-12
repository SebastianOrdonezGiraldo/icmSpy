import type { CompanyDetail } from "@icmspy/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api";

export function CompanyPage() {
  const { id } = useParams({ from: "/app/companies/$id" });
  const { data, isPending, isError } = useQuery({
    queryKey: ["company", id],
    queryFn: () => apiGet<CompanyDetail>(`/companies/${id}`),
  });

  if (isPending) return <p className="text-muted-foreground">Cargando…</p>;
  if (isError) return <p className="text-destructive">No se encontró la empresa.</p>;

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
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {p.validationStatus}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Fuente:{" "}
                  {p.sources.length === 0
                    ? "sin registrar"
                    : p.sources.map((s, i) => (
                        <span key={`${s.sourceKey}-${s.observedAt}`}>
                          {i > 0 && ", "}
                          {s.url ? (
                            <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                              {s.sourceKey}
                            </a>
                          ) : (
                            s.sourceKey
                          )}
                        </span>
                      ))}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

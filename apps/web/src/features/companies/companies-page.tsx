import { COMPANY_TYPES, type CompanyListResponse } from "@icmspy/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiGet } from "@/lib/api";
import { useCompanyFilters } from "./filters-store";

export function CompaniesPage() {
  const { q, type, hasEmail, page, set, setPage } = useCompanyFilters();
  const filters = { q: q.trim() || undefined, type: type || undefined, hasEmail, page };

  const { data, isPending, isError } = useQuery({
    queryKey: ["companies", filters],
    queryFn: () => apiGet<CompanyListResponse>("/companies", filters),
    placeholderData: keepPreviousData,
  });

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Empresas</h1>
        {data && <span className="text-sm text-muted-foreground">{data.total} {data.total === 1 ? "resultado" : "resultados"}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-xs"
          placeholder="Buscar por nombre o NIT"
          value={q}
          onChange={(e) => set({ q: e.target.value })}
        />
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          aria-label="Tipo de empresa"
          value={type}
          onChange={(e) => set({ type: e.target.value as typeof type })}
        >
          <option value="">Todos los tipos</option>
          {COMPANY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hasEmail}
            onChange={(e) => set({ hasEmail: e.target.checked })}
          />
          Solo con correo
        </label>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Empresa</th>
              <th className="px-4 py-2 font-medium">NIT</th>
              <th className="px-4 py-2 font-medium">Tipo</th>
              <th className="px-4 py-2 font-medium">Ciudad</th>
              <th className="px-4 py-2 text-right font-medium">Contactos</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((c) => (
              <tr key={c.id} className="border-b last:border-0 hover:bg-muted/50">
                <td className="px-4 py-2">
                  <Link
                    to="/companies/$id"
                    params={{ id: c.id }}
                    className="font-medium hover:underline"
                  >
                    {c.tradeName ?? c.legalName}
                  </Link>
                </td>
                <td className="px-4 py-2">{c.nit ?? "—"}</td>
                <td className="px-4 py-2">{c.companyType}</td>
                <td className="px-4 py-2">
                  {[c.city, c.department].filter(Boolean).join(", ") || "—"}
                </td>
                <td className="px-4 py-2 text-right">{c.contactCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {isPending && <p className="p-6 text-center text-muted-foreground">Cargando…</p>}
        {isError && (
          <p className="p-6 text-center text-destructive">No se pudieron cargar las empresas.</p>
        )}
        {data?.items.length === 0 && (
          <p className="p-6 text-center text-muted-foreground">
            Todavía no hay empresas. Aparecerán aquí cuando se importe la primera fuente.
          </p>
        )}
      </Card>

      <div className="flex items-center justify-end gap-3 text-sm">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Anterior
        </Button>
        <span>
          Página {page} de {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => setPage(page + 1)}
        >
          Siguiente
        </Button>
      </div>
    </div>
  );
}

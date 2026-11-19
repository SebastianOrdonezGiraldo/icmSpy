import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError, apiGet, apiPost } from "@/lib/api";

/**
 * Demo de la recolección de Instagram con DATOS DE PRUEBA: cuentas, seguidores y contactos son
 * sintéticos (proveedor y directorio inventados). Pegue la URL de un perfil, pulse «Buscar» y
 * siga el progreso; el resultado queda en la URL (?demo=…) para volver a verlo al recargar.
 */

interface DemoConfig {
  enabled: boolean;
  requested: number;
  budget: number;
  examples: { label: string; profileUrl: string }[];
}

interface DemoRow {
  position: number;
  username: string;
  profileUrl: string;
  isPrivate: boolean;
  enrichment: "con_contacto" | "sin_contacto" | "privado" | "pendiente" | "no_encontrado";
  email: string | null;
  emailSource: "button" | "biography" | null;
  phone: string | null;
  phoneSource: "button" | "biography" | null;
}

const SOURCE_LABEL = { button: "botón", biography: "biografía" } as const;

interface DemoResult {
  runId: string;
  username: string;
  profileUrl: string;
  status: "queued" | "running" | "done";
  stopReason: string | null;
  stopText: string | null;
  detail: string | null;
  progress: {
    collected: number;
    requested: number;
    profilesDone: number;
    profilesToQuery: number;
    attempts: number;
    budget: number;
  };
  summary: {
    rows: number;
    privateSkipped: number;
    withEmail: number;
    withPhone: number;
    withoutContact: number;
    pending: number;
    notFound: number;
  };
  rows: DemoRow[];
}

export function InstagramDemo({ runId }: { runId?: string }) {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const config = useQuery({
    queryKey: ["instagram-demo", "config"],
    queryFn: () => apiGet<DemoConfig>("/instagram-demo/config"),
  });
  const search = useMutation({
    mutationFn: (profileUrl: string) =>
      apiPost<{ runId: string }>("/instagram-demo/searches", { profileUrl }),
    onSuccess: ({ runId: id }) => navigate({ to: "/instagram", search: { demo: id } }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) search.mutate(url.trim());
  };

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">Buscar seguidores de un perfil</h2>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
          Demo con datos de prueba
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Las cuentas, los seguidores y los contactos de esta demo son ficticios: no se consulta
        Instagram ni ningún servicio externo. Se analizan {config.data?.requested ?? 50} seguidores
        por búsqueda y se consulta el perfil de cada seguidor público (botones de contacto y
        biografía); los perfiles privados no se consultan.
      </p>

      {config.data && !config.data.enabled && (
        <p className="text-sm text-destructive">
          La demo está desactivada. Arranque la API y el worker con INSTAGRAM_PROVIDER=fake.
        </p>
      )}

      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <Input
          aria-label="URL del perfil de Instagram"
          placeholder="https://www.instagram.com/usuario/"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit" disabled={!url.trim() || search.isPending || !config.data?.enabled}>
          {search.isPending ? "Buscando…" : "Buscar"}
        </Button>
      </form>
      {search.isError && (
        <p className="text-sm text-destructive">
          {search.error instanceof ApiError
            ? search.error.message
            : "No se pudo iniciar la búsqueda."}
        </p>
      )}

      {config.data?.examples && (
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="text-muted-foreground">Ejemplos:</span>
          {config.data.examples.map((ex) => (
            <button
              key={ex.profileUrl}
              type="button"
              className="rounded border px-2 py-0.5 hover:bg-secondary"
              onClick={() => setUrl(ex.profileUrl)}
              title={ex.profileUrl}
            >
              {ex.label}
            </button>
          ))}
        </div>
      )}

      {runId && <DemoRun runId={runId} />}
    </Card>
  );
}

function DemoRun({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const { data, isError, error } = useQuery({
    queryKey: ["instagram-demo", "search", runId],
    queryFn: () => apiGet<DemoResult>(`/instagram-demo/searches/${runId}`),
    refetchInterval: (q) => (q.state.data?.status === "done" ? false : 1000),
  });

  if (isError) {
    return (
      <p className="text-sm text-destructive">
        {error instanceof ApiError && error.status === 404
          ? "Esa búsqueda no existe en esta base."
          : "No se pudo leer la búsqueda."}
      </p>
    );
  }
  if (!data) return <p className="text-sm text-muted-foreground">Cargando la búsqueda…</p>;

  const { progress, summary } = data;
  // Dos etapas: listado de seguidores y consulta de los perfiles públicos seleccionados.
  const total = progress.requested + progress.profilesToQuery;
  const pct = Math.round(((progress.collected + progress.profilesDone) / Math.max(total, 1)) * 100);
  const statusText =
    data.status === "queued"
      ? "En cola: esperando al worker…"
      : data.status === "running"
        ? progress.collected < progress.requested
          ? "Buscando seguidores…"
          : "Consultando los perfiles públicos…"
        : data.stopText;

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">
            Perfil:{" "}
            <a className="underline" href={data.profileUrl} target="_blank" rel="noreferrer">
              @{data.username}
            </a>
          </p>
          <p className="text-sm" data-testid="demo-status">
            {statusText}
            {data.detail ? ` — ${data.detail}` : ""}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate({ to: "/instagram", search: {} })}
        >
          Nueva búsqueda
        </Button>
      </div>

      <div>
        <div className="h-2 w-full overflow-hidden rounded bg-secondary">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {progress.collected} de {progress.requested} seguidores · {progress.profilesDone} de{" "}
          {progress.profilesToQuery} perfiles consultados · {progress.attempts} de {progress.budget}{" "}
          llamadas
        </p>
      </div>

      {data.rows.length > 0 && (
        <>
          {data.status === "done" && (
            <p className="text-sm">
              {summary.rows} seguidores: {summary.withEmail} con correo, {summary.withPhone} con
              teléfono, {summary.withoutContact} sin contacto publicado y {summary.privateSkipped}{" "}
              privados sin enriquecer
              {summary.notFound > 0 ? `; ${summary.notFound} perfiles no disponibles` : ""}
              {summary.pending > 0 ? `; ${summary.pending} quedaron sin consultar` : ""}.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">#</th>
                  <th className="py-2 pr-4 font-medium">Usuario de Instagram</th>
                  <th className="py-2 pr-4 font-medium">Correo comercial</th>
                  <th className="py-2 font-medium">Teléfono comercial</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.username} className="border-b last:border-0">
                    <td className="py-1.5 pr-4 text-muted-foreground">{r.position}</td>
                    <td className="py-1.5 pr-4">@{r.username}</td>
                    {r.enrichment === "privado" ? (
                      <td colSpan={2} className="py-1.5 text-muted-foreground italic">
                        Perfil privado — sin enriquecer
                      </td>
                    ) : r.enrichment === "sin_contacto" ? (
                      <td colSpan={2} className="py-1.5 text-muted-foreground">
                        Sin contacto publicado
                      </td>
                    ) : r.enrichment === "pendiente" ? (
                      <td colSpan={2} className="py-1.5 text-muted-foreground">
                        Pendiente de consultar…
                      </td>
                    ) : r.enrichment === "no_encontrado" ? (
                      <td colSpan={2} className="py-1.5 text-muted-foreground">
                        Perfil no disponible
                      </td>
                    ) : (
                      <>
                        <td className="py-1.5 pr-4">
                          <ContactCell value={r.email} source={r.emailSource} />
                        </td>
                        <td className="py-1.5">
                          <ContactCell value={r.phone} source={r.phoneSource} />
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ContactCell({
  value,
  source,
}: {
  value: string | null;
  source: "button" | "biography" | null;
}) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span>
      {value}
      {source && (
        <span className="ml-1 text-xs text-muted-foreground">({SOURCE_LABEL[source]})</span>
      )}
    </span>
  );
}

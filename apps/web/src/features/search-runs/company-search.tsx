import {
  type CreateSearchRunResponse,
  canonicalCriteria,
  DIVIPOLA,
  getDepartment,
  KEYWORD_MAX_LENGTH,
  type SearchCriteria,
  type SearchResultItem,
  type SearchRunDto,
  type SearchRunResultsResponse,
  searchCriteriaSchema,
} from "@icmspy/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiGet, apiPost } from "@/lib/api";
import { formatDate, formatDateTime, formatPhone, SOURCE_LABELS } from "@/lib/format";

/** Pasado este tiempo en cola sin empezar, se avisa que el proceso de fondo puede no estar activo. */
const STALE_QUEUE_MS = 60_000;
const PAGE_SIZE = 20;

const runKey = (id: string) => ["search-run", id] as const;
const RECENT_KEY = ["search-runs", "recent"] as const;

function isActive(run: SearchRunDto | undefined) {
  return run?.status === "queued" || run?.status === "running";
}

function n(value: number | undefined) {
  return (value ?? 0).toLocaleString("es-CO");
}

/**
 * Buscador de empresas: palabra clave + departamento + municipio opcional.
 * La ejecución que se muestra va en la URL (?run=…): al recargar se recupera
 * y los resultados de una búsqueda nunca se mezclan con los de otra.
 */
export function CompanySearch() {
  const { run: runParam } = useSearch({ from: "/app/" });
  const navigate = useNavigate({ from: "/" });

  const recent = useQuery({
    queryKey: RECENT_KEY,
    queryFn: () => apiGet<SearchRunDto[]>("/search-runs", { limit: 6 }),
    staleTime: 0,
  });
  // Sin ?run=, se muestra la última búsqueda (recuperación al volver a la página).
  const runId = runParam ?? recent.data?.[0]?.id;

  const run = useQuery({
    queryKey: runKey(runId ?? "none"),
    queryFn: () => apiGet<SearchRunDto>(`/search-runs/${runId}`),
    enabled: Boolean(runId),
    staleTime: 0,
    // Mientras la búsqueda está pendiente o en curso, se consulta su estado cada 3 s.
    refetchInterval: (q) => (isActive(q.state.data) ? 3000 : false),
  });

  return (
    <div className="space-y-4">
      <SearchForm
        shown={run.data}
        onCreated={(created) => navigate({ search: { run: created.id } })}
      />
      {run.isError && (
        <p className="text-sm text-destructive">No se pudo consultar el estado de la búsqueda.</p>
      )}
      {run.data && <RunView key={run.data.id} run={run.data} />}
      <RecentSearches runs={recent.data} currentId={runId} />
    </div>
  );
}

// --- Formulario ---------------------------------------------------------------

interface FormState {
  keyword: string;
  departmentCode: string;
  municipalityCode: string;
}

const EMPTY_FORM: FormState = { keyword: "", departmentCode: "", municipalityCode: "" };

function SearchForm({
  shown,
  onCreated,
}: {
  shown: SearchRunDto | undefined;
  onCreated: (run: SearchRunDto) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  // Al abrir una búsqueda (recarga o búsqueda reciente), el formulario muestra sus criterios.
  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!shown || prefilledFor.current === shown.id) return;
    prefilledFor.current = shown.id;
    if (shown.criteria.legacy) return;
    setForm({
      keyword: shown.criteria.keyword ?? "",
      departmentCode: shown.criteria.departmentCode,
      municipalityCode: shown.criteria.municipalityCode ?? "",
    });
    setErrors({});
  }, [shown]);

  const start = useMutation({
    mutationFn: (criteria: SearchCriteria) =>
      apiPost<CreateSearchRunResponse>("/search-runs", criteria),
    onSuccess: (res) => {
      queryClient.setQueryData(runKey(res.run.id), res.run);
      void queryClient.invalidateQueries({ queryKey: RECENT_KEY });
      prefilledFor.current = res.run.id;
      onCreated(res.run);
    },
  });

  const department = form.departmentCode ? getDepartment(form.departmentCode) : undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (start.isPending) return;
    const parsed = searchCriteriaSchema.safeParse({
      keyword: form.keyword,
      departmentCode: form.departmentCode,
      municipalityCode: form.municipalityCode || null,
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof FormState;
        next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    start.mutate(parsed.data);
  }

  // ¿Los criterios del formulario ya no son los de la búsqueda mostrada?
  const parsed = searchCriteriaSchema.safeParse({
    keyword: form.keyword,
    departmentCode: form.departmentCode,
    municipalityCode: form.municipalityCode || null,
  });
  const differs =
    shown &&
    !shown.criteria.legacy &&
    parsed.success &&
    JSON.stringify(canonicalCriteria(parsed.data)) !==
      JSON.stringify({
        keywordTerms: shown.criteria.keyword?.split(" ") ?? [],
        departmentCode: shown.criteria.departmentCode,
        municipalityCode: shown.criteria.municipalityCode,
      });

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="font-medium">Buscar empresas</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Consulta automáticamente las fuentes oficiales disponibles y trae las empresas cuyo nombre
          o el de alguna de sus sedes contiene todas las palabras escritas (sin importar mayúsculas
          ni tildes), con sedes en el lugar elegido.
        </p>
      </div>
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-[2fr_1.5fr_1.5fr_auto]" noValidate>
        <div className="space-y-1">
          <Label htmlFor="search-keyword">Palabra clave</Label>
          <Input
            id="search-keyword"
            placeholder="Ej.: odontológica"
            maxLength={KEYWORD_MAX_LENGTH}
            value={form.keyword}
            onChange={(e) => setForm((f) => ({ ...f, keyword: e.target.value }))}
          />
          {errors.keyword && <p className="text-sm text-destructive">{errors.keyword}</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor="search-department">Departamento</Label>
          <select
            id="search-department"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={form.departmentCode}
            onChange={(e) =>
              // Cambiar el departamento descarta el municipio anterior.
              setForm((f) => ({ ...f, departmentCode: e.target.value, municipalityCode: "" }))
            }
          >
            <option value="">Elige un departamento</option>
            {DIVIPOLA.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
          </select>
          {errors.departmentCode && (
            <p className="text-sm text-destructive">{errors.departmentCode}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="search-municipality">Ciudad o municipio</Label>
          <select
            id="search-municipality"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
            value={form.municipalityCode}
            disabled={!department}
            onChange={(e) => setForm((f) => ({ ...f, municipalityCode: e.target.value }))}
          >
            <option value="">Todos los municipios</option>
            {department?.municipalities.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          {errors.municipalityCode && (
            <p className="text-sm text-destructive">{errors.municipalityCode}</p>
          )}
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={start.isPending} className="w-full md:w-auto">
            {start.isPending ? "Iniciando…" : "Buscar empresas"}
          </Button>
        </div>
      </form>
      {start.isError && (
        <p className="text-sm text-destructive">
          No se pudo iniciar la búsqueda: {start.error.message}
        </p>
      )}
      {differs && (
        <p className="text-sm text-amber-700">
          Los resultados de abajo son de la búsqueda {shown.criteria.label}. Pulsa “Buscar empresas”
          para aplicar los nuevos criterios.
        </p>
      )}
    </Card>
  );
}

// --- Estado y resultados de una ejecución ------------------------------------

function RunView({ run }: { run: SearchRunDto }) {
  const queryClient = useQueryClient();
  // Al terminar una búsqueda que se vio en curso, se recargan catálogo y recientes.
  const lastStatus = useRef(run.status);
  useEffect(() => {
    if (lastStatus.current !== run.status && run.status === "done") {
      void queryClient.invalidateQueries({ queryKey: ["companies"] });
      void queryClient.invalidateQueries({ queryKey: ["company"] });
    }
    if (lastStatus.current !== run.status) {
      void queryClient.invalidateQueries({ queryKey: RECENT_KEY });
    }
    lastStatus.current = run.status;
  }, [run.status, queryClient]);

  return (
    <Card className="space-y-3 p-4" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Búsqueda: {run.criteria.label}</h2>
        <span className="text-xs text-muted-foreground">
          Iniciada el {formatDateTime(run.createdAt)}
        </span>
      </div>
      <RunStatus run={run} />
      <Coverage run={run} />
      {run.status === "done" && run.hasResults && <Results run={run} />}
      {run.status === "done" && !run.hasResults && (
        <p className="text-sm text-muted-foreground">
          Esta ejecución es de la búsqueda fija anterior al buscador y no guardó su lista de
          resultados. Sus empresas están en el catálogo de abajo.
        </p>
      )}
    </Card>
  );
}

/** Hora actual que se refresca sola: el sondeo no re-renderiza si los datos no cambian. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function RunStatus({ run }: { run: SearchRunDto }) {
  const s = run.stats;
  const now = useNow(5000);
  if (run.status === "queued") {
    const waitingMs = now - new Date(run.updatedAt).getTime();
    return (
      <div className="space-y-1 text-sm">
        <p>En cola: esperando a que empiece…</p>
        {run.error && <p className="text-amber-700">{run.error}</p>}
        {!run.error && waitingMs > STALE_QUEUE_MS && (
          <p className="text-amber-700">
            Todavía no ha empezado. Si no avanza en unos minutos, el servicio que ejecuta las
            búsquedas puede estar detenido: avisa al administrador.
          </p>
        )}
      </div>
    );
  }
  if (run.status === "running") {
    return (
      <p className="text-sm">
        {s.phase === "saving"
          ? `Guardando ${n(s.recordsMatched)} coincidencias…`
          : `Consultando fuentes: ${n(s.recordsRead)}${
              s.recordsExpected !== undefined ? ` de ${n(s.recordsExpected)}` : ""
            } registros leídos…`}
        {s.attempt && s.attempt > 1 && (
          <span className="text-muted-foreground">
            {" "}
            (intento {s.attempt} de {s.maxAttempts})
          </span>
        )}
      </p>
    );
  }
  if (run.status === "failed") {
    return (
      <p className="text-sm text-destructive">
        La búsqueda falló{run.finishedAt ? ` (${formatDateTime(run.finishedAt)})` : ""}:{" "}
        {run.error ?? "error desconocido"}. Esta búsqueda no incorporó datos ni resultados.
      </p>
    );
  }
  if (!run.hasResults) {
    return (
      <p className="text-sm">
        Terminada el {formatDateTime(run.finishedAt)}: {n(s.recordsRead)} sedes leídas,{" "}
        {n(s.companiesNew)} empresas nuevas.
      </p>
    );
  }
  return (
    <div className="text-sm">
      <p>
        Terminada el {formatDateTime(run.finishedAt)}:{" "}
        <strong>
          {n(s.companiesMatched)}{" "}
          {s.companiesMatched === 1 ? "empresa encontrada" : "empresas encontradas"}
        </strong>{" "}
        ({n(s.companiesNew)} nuevas, {n(s.companiesExisting)} ya estaban en el catálogo) con{" "}
        {n(s.sitesMatched)} sedes coincidentes.
      </p>
      <ul className="mt-1 list-inside list-disc text-muted-foreground">
        <li>
          {n(s.recordsRead)} registros leídos en las fuentes para el lugar elegido;{" "}
          {n(s.recordsMatched)} contienen la palabra clave.
        </li>
        <li>
          Contactos: {n(s.contactsNew)} nuevos y {n(s.contactsExisting)} ya registrados.
          {(s.contactsSuppressed ?? 0) > 0 &&
            ` ${n(s.contactsSuppressed)} omitidos por la lista de supresión.`}
          {(s.contactsDiscarded ?? 0) > 0 &&
            ` ${n(s.contactsDiscarded)} valores no se pudieron interpretar.`}
        </li>
      </ul>
    </div>
  );
}

function Coverage({ run }: { run: SearchRunDto }) {
  const perSource = run.stats.sources ?? [];
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {run.sources.map((source) => {
        const st = perSource.find((p) => p.key === source.key) ?? run.stats;
        return (
          <p key={source.key}>
            <span className="font-medium">Fuente: {source.name}.</span> {source.coverage}{" "}
            {(st.sourceCutoffAt || st.sourceCutoffRaw) &&
              `Corte de los datos: ${st.sourceCutoffAt ? formatDate(st.sourceCutoffAt) : st.sourceCutoffRaw}`}
            {st.sourceUpdatedAt && `, publicados el ${formatDate(st.sourceUpdatedAt)}`}
            {(st.sourceCutoffAt || st.sourceUpdatedAt) &&
              ". Es una publicación periódica: no confirma que la habilitación siga vigente hoy. "}
            {st.sourceUrl && (
              <a href={st.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                Ver fuente
              </a>
            )}
          </p>
        );
      })}
      <p>
        La búsqueda compara palabras con los nombres publicados; no sabe a qué se dedica cada
        empresa. INVIMA y otras fuentes no se consultan todavía.
      </p>
    </div>
  );
}

function Results({ run }: { run: SearchRunDto }) {
  // RunView se monta con key = id de la ejecución: la página vuelve a 1 al cambiar de búsqueda.
  const [page, setPage] = useState(1);
  const results = useQuery({
    queryKey: ["search-run-results", run.id, page],
    queryFn: () =>
      apiGet<SearchRunResultsResponse>(`/search-runs/${run.id}/results`, {
        page,
        pageSize: PAGE_SIZE,
      }),
    // Mientras carga otra página de ESTA búsqueda se mantiene la anterior; nunca la de otra.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === run.id ? previous : undefined,
  });
  const data = results.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  if (results.isError) {
    return <p className="text-sm text-destructive">No se pudieron cargar los resultados.</p>;
  }
  if (!data) return <p className="text-sm text-muted-foreground">Cargando resultados…</p>;
  if (data.total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Sin resultados: ninguna institución con sede en{" "}
        {run.criteria.municipalityName ?? run.criteria.departmentName} tiene en su nombre todas las
        palabras “{run.criteria.keyword}”. Prueba con menos palabras o con una raíz más corta (por
        ejemplo, “odonto”).
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border">
        {data.items.map((item) => (
          <ResultRow key={item.companyId} item={item} />
        ))}
      </ul>
      <div className="flex items-center justify-end gap-3 text-sm">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Anterior
        </Button>
        <span>
          Página {page} de {pages} · {n(data.total)} empresas
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

function ResultRow({ item }: { item: SearchResultItem }) {
  const siteName = new Map(item.matchedSites.map((s) => [s.id, s.name]));
  return (
    <li className="space-y-1 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/companies/$id"
          params={{ id: item.companyId }}
          className="font-medium hover:underline"
        >
          {item.legalName}
        </Link>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {item.isNew ? "Nueva en esta búsqueda" : "Ya estaba en el catálogo"}
        </span>
        <span className="text-xs text-muted-foreground">
          {[item.nit && `NIT ${item.nit}`, [item.city, item.department].filter(Boolean).join(", ")]
            .filter(Boolean)
            .join(" · ")}
          {" · "}Fuente: {item.sourceKeys.map((k) => SOURCE_LABELS[k] ?? k).join(", ")}
        </span>
      </div>
      <div className="text-xs">
        <span className="text-muted-foreground">
          {item.matchedSites.length === 1 ? "Sede coincidente: " : "Sedes coincidentes: "}
        </span>
        {item.matchedSites
          .map((s) => `${s.name} (${[s.city, s.address].filter(Boolean).join(", ")})`)
          .join("; ")}
      </div>
      {item.contacts.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sin contactos publicados.</p>
      ) : (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {item.contacts.map((c) => (
            <li key={c.id}>
              <span className="text-muted-foreground">
                {c.kind === "email" ? "Correo" : "Teléfono"}:{" "}
              </span>
              {c.kind === "phone" ? formatPhone(c.valueNormalized) : c.value}
              <span className="text-muted-foreground"> ({contactScopeLabel(c, siteName)})</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function RecentSearches({
  runs,
  currentId,
}: {
  runs: SearchRunDto[] | undefined;
  currentId: string | undefined;
}) {
  if (!runs || runs.length < 2) return null;
  const statusLabel: Record<SearchRunDto["status"], string> = {
    queued: "en cola",
    running: "en curso",
    done: "terminada",
    failed: "fallida",
  };
  return (
    <div className="text-sm">
      <span className="text-muted-foreground">Búsquedas recientes: </span>
      {runs.map((r, i) => (
        <span key={r.id}>
          {i > 0 && " · "}
          {r.id === currentId ? (
            <span className="font-medium">{r.criteria.label}</span>
          ) : (
            <Link to="/" search={{ run: r.id }} className="underline">
              {r.criteria.label}
            </Link>
          )}{" "}
          <span className="text-xs text-muted-foreground">({statusLabel[r.status]})</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Ámbito visible de un contacto: general de la empresa, de sedes coincidentes o
 * ambos. Un contacto general nunca se presenta como exclusivo de una sede.
 */
export function contactScopeLabel(
  c: Pick<SearchResultItem["contacts"][number], "companyWide" | "siteIds">,
  siteName: Map<string, string>,
): string {
  const sites = c.siteIds.map((id) => siteName.get(id) ?? "sede").join(", ");
  if (c.companyWide && c.siteIds.length) return `empresa; también en la sede ${sites}`;
  if (c.companyWide) return "empresa";
  return `sede ${sites}`;
}

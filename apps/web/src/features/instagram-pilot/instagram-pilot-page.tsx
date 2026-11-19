import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiGet } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { InstagramDemo } from "./instagram-demo";

/** Visor de solo lectura de las ejecuciones del piloto local de Instagram. */

interface RunItem {
  runId: string;
  target: string;
  status: string;
  stopReason: string | null;
  stopReasonText: string;
  updatedAt: string | null;
  counters: Record<string, number>;
  contacts: number;
}

interface Follower {
  position: number;
  user_id: string;
  username: string;
  profile_url: string;
  status: string;
  full_name: string | null;
  biography: string | null;
  external_url: string | null;
  category: string | null;
  contacts_status: string;
  profile_contacts: number;
}

interface Contact {
  user_id: string;
  username: string;
  profile_url: string;
  kind: string;
  original: string;
  normalized: string | null;
  e164: string | null;
  status: string;
  extension: string | null;
  source: string;
  field: string;
  source_url: string;
  evidence: string;
  attribution: string;
  profiles_sharing: number;
}

interface RunDetail {
  summary: Record<string, unknown> & {
    status: string;
    stop_reason: string | null;
    stop_reason_text: string;
    stop_detail: string | null;
    resumable: boolean;
    target: { username: string; profile_url: string; followers_count_reported: number | null };
    config: { limit_total: number; include_web: boolean };
    counters: Record<string, number>;
    contact_buttons: { note: string; keys_with_value: Record<string, number> };
    versions: Record<string, string>;
  };
  followers: Follower[];
  contacts: Contact[];
}

const COUNTER_LABELS: [string, string][] = [
  ["rows_received", "Filas recibidas"],
  ["unique_followers", "Seguidores únicos"],
  ["duplicates", "Duplicados"],
  ["private_skipped", "Privados omitidos"],
  ["public_consulted", "Públicos consultados"],
  ["inaccessible", "Inaccesibles"],
  ["failed", "Fallos"],
  ["pending", "Pendientes"],
  ["public_with_profile_contacts", "Con contacto en el perfil"],
  ["public_without_profile_contacts", "Sin contacto en el perfil"],
];

const KIND_LABELS: Record<string, string> = {
  email: "Correo",
  phone: "Teléfono",
  whatsapp: "WhatsApp",
};
const CONTACT_STATUS_LABELS: Record<string, string> = {
  email_syntax_ok: "correo",
  e164_valid: "internacional válido",
  international_unverified: "con prefijo, sin validar",
  ambiguous_no_country: "sin país (ambiguo)",
  link_without_number: "enlace sin número",
};
const FIELD_LABELS: Record<string, string> = {
  biography: "biografía",
  external_url: "enlace del perfil",
  bio_links: "enlaces de la bio",
  website_home: "web: portada",
  website_contact: "web: contacto",
};
const ATTRIBUTION_LABELS: Record<string, string> = {
  profile_owner: "publicado en su perfil",
  website_same_domain: "web, mismo dominio",
  website_unverified: "web, sin confirmar titular",
  third_party_suspected: "posible tercero (no atribuido)",
};
const FOLLOWER_STATUS_LABELS: Record<string, string> = {
  found: "con contacto",
  none_found: "sin contacto",
  not_consulted: "no consultado",
  private_skipped: "privado (omitido)",
  inaccessible: "inaccesible",
  failed: "fallo",
};

export function InstagramPilotPage() {
  const { run, demo } = useSearch({ from: "/app/instagram" });
  if (run) return <RunView runId={run} />;
  return (
    <div className="space-y-6">
      <InstagramDemo runId={demo} />
      <RunList />
    </div>
  );
}

function RunList() {
  const navigate = useNavigate();
  const { data, isPending, isError } = useQuery({
    queryKey: ["instagram-pilot", "runs"],
    queryFn: () => apiGet<{ enabled: boolean; runs: RunItem[] }>("/instagram-pilot/runs"),
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-4">
      <Header />
      {isPending && <p className="text-muted-foreground">Cargando…</p>}
      {isError && <p className="text-destructive">No se pudo leer el piloto.</p>}
      {data && !data.enabled && (
        <Card className="p-4 text-sm">
          El visor está desactivado. Configure <code>INSTAGRAM_PILOT_RUNS_DIR</code> en la API con
          la carpeta de ejecuciones del piloto.
        </Card>
      )}
      {data?.enabled && data.runs.length === 0 && (
        <Card className="p-4 text-sm text-muted-foreground">
          Todavía no hay ejecuciones terminadas. Se actualiza solo cada 15 s.
        </Card>
      )}
      {data?.enabled && data.runs.length > 0 && (
        <Card className="overflow-x-auto p-4">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Perfil objetivo</th>
                <th className="py-2 pr-4 font-medium">Estado</th>
                <th className="py-2 pr-4 text-right font-medium">Seguidores</th>
                <th className="py-2 pr-4 text-right font-medium">Públicos</th>
                <th className="py-2 pr-4 text-right font-medium">Contactos</th>
                <th className="py-2 font-medium">Actualizado</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr
                  key={r.runId}
                  className="cursor-pointer border-b last:border-0 hover:bg-muted/50"
                  onClick={() => navigate({ to: "/instagram", search: { run: r.runId } })}
                >
                  <td className="py-2 pr-4 font-medium">@{r.target}</td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={r.status} />{" "}
                    <span className="text-xs text-muted-foreground">{r.stopReason}</span>
                  </td>
                  <td className="py-2 pr-4 text-right">{r.counters.unique_followers ?? 0}</td>
                  <td className="py-2 pr-4 text-right">{r.counters.public_consulted ?? 0}</td>
                  <td className="py-2 pr-4 text-right">{r.contacts}</td>
                  <td className="py-2">{formatDateTime(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Piloto Instagram</h1>
      <p className="text-sm text-muted-foreground">
        Solo lectura de las ejecuciones locales del piloto. Son datos personales de seguidores (Ley
        1581): uso interno, sin incorporarlos a empresas ni contactos.
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "bg-green-100 text-green-800"
      : status === "error"
        ? "bg-red-100 text-red-800"
        : "bg-amber-100 text-amber-800";
  const label = status === "completed" ? "completa" : status === "stopped" ? "detenida" : status;
  return <span className={`rounded px-1.5 py-0.5 text-xs ${color}`}>{label}</span>;
}

function RunView({ runId }: { runId: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["instagram-pilot", "run", runId],
    queryFn: () => apiGet<RunDetail>(`/instagram-pilot/runs/${encodeURIComponent(runId)}`),
  });
  const [tab, setTab] = useState<"contacts" | "followers">("contacts");

  if (isPending) return <p className="text-muted-foreground">Cargando…</p>;
  if (isError) return <p className="text-destructive">No se encontró la ejecución.</p>;
  const s = data.summary;
  const buttonKeys = Object.keys(s.contact_buttons.keys_with_value ?? {});

  return (
    <div className="space-y-4">
      <Link to="/instagram" className="text-sm text-muted-foreground hover:underline">
        ← Ejecuciones
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">
          Seguidores de{" "}
          <a
            href={s.target.profile_url}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            @{s.target.username}
          </a>
        </h1>
        <p className="text-sm text-muted-foreground">
          <StatusBadge status={s.status} /> {s.stop_reason_text}
          {s.stop_detail ? ` (${s.stop_detail})` : ""} · límite {s.config.limit_total} · seguidores
          declarados {s.target.followers_count_reported ?? "—"}
          {s.resumable && " · se puede reanudar"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {COUNTER_LABELS.map(([key, label]) => (
          <Card key={key} className="p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-xl font-semibold">{s.counters[key] ?? 0}</div>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {s.contact_buttons.note}
        {buttonKeys.length > 0 && ` Claves vistas: ${buttonKeys.join(", ")}.`}
      </p>

      <div className="flex gap-2 border-b text-sm">
        {(
          [
            ["contacts", `Contactos (${data.contacts.length})`],
            ["followers", `Seguidores (${data.followers.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 ${tab === key ? "border-foreground font-medium" : "border-transparent text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "contacts" ? (
        <ContactsTable contacts={data.contacts} />
      ) : (
        <FollowersTable followers={data.followers} />
      )}
    </div>
  );
}

function ContactsTable({ contacts }: { contacts: Contact[] }) {
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f
      ? contacts.filter((c) =>
          [c.username, c.original, c.normalized].some((v) => v?.toLowerCase().includes(f)),
        )
      : contacts;
  }, [contacts, filter]);

  if (contacts.length === 0)
    return (
      <Card className="p-4 text-sm text-muted-foreground">
        No se encontraron contactos publicados.
      </Card>
    );

  return (
    <Card className="space-y-3 overflow-x-auto p-4">
      <Input
        placeholder="Filtrar por perfil o valor…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <table className="w-full text-sm">
        <thead className="border-b text-left text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">Perfil</th>
            <th className="py-2 pr-4 font-medium">Tipo</th>
            <th className="py-2 pr-4 font-medium">Valor</th>
            <th className="py-2 pr-4 font-medium">Estado</th>
            <th className="py-2 pr-4 font-medium">Dónde</th>
            <th className="py-2 font-medium">Evidencia</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={`${c.user_id}|${c.kind}|${c.original}|${c.source}|${c.field}|${c.source_url}`}
              className="border-b align-top last:border-0"
            >
              <td className="py-2 pr-4">
                <a
                  href={c.profile_url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  @{c.username}
                </a>
              </td>
              <td className="py-2 pr-4">{KIND_LABELS[c.kind] ?? c.kind}</td>
              <td className="py-2 pr-4 font-mono text-xs">
                {c.e164 ?? c.normalized ?? c.original}
                {c.extension && ` ext. ${c.extension}`}
                {c.profiles_sharing > 1 && (
                  <div className="font-sans text-muted-foreground">
                    en {c.profiles_sharing} perfiles
                  </div>
                )}
              </td>
              <td className="py-2 pr-4 text-xs">{CONTACT_STATUS_LABELS[c.status] ?? c.status}</td>
              <td className="py-2 pr-4 text-xs">
                {FIELD_LABELS[c.field] ?? c.field}
                <div
                  className={
                    c.attribution === "third_party_suspected"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {ATTRIBUTION_LABELS[c.attribution] ?? c.attribution}
                </div>
              </td>
              <td className="max-w-xs py-2 text-xs text-muted-foreground">{c.evidence}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function FollowersTable({ followers }: { followers: Follower[] }) {
  return (
    <Card className="overflow-x-auto p-4">
      <table className="w-full text-sm">
        <thead className="border-b text-left text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">#</th>
            <th className="py-2 pr-4 font-medium">Perfil</th>
            <th className="py-2 pr-4 font-medium">Nombre</th>
            <th className="py-2 pr-4 font-medium">Categoría</th>
            <th className="py-2 pr-4 font-medium">Contactos</th>
            <th className="py-2 font-medium">Biografía</th>
          </tr>
        </thead>
        <tbody>
          {followers.map((f) => (
            <tr key={f.user_id} className="border-b align-top last:border-0">
              <td className="py-2 pr-4 text-muted-foreground">{f.position}</td>
              <td className="py-2 pr-4">
                <a
                  href={f.profile_url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  @{f.username}
                </a>
              </td>
              <td className="py-2 pr-4">{f.full_name ?? "—"}</td>
              <td className="py-2 pr-4 text-xs">{f.category ?? "—"}</td>
              <td className="py-2 pr-4 text-xs">
                {FOLLOWER_STATUS_LABELS[f.contacts_status] ?? f.contacts_status}
                {f.profile_contacts > 0 && ` (${f.profile_contacts})`}
              </td>
              <td className="max-w-sm whitespace-pre-line py-2 text-xs text-muted-foreground">
                {f.biography || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

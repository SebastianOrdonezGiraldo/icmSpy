"""Salidas de una ejecución: followers.jsonl, contacts.csv, summary.json, report.md y run.log.

Se regeneran completas desde la base SQLite (fuente de verdad) y se escriben de forma atómica.
"""

from __future__ import annotations

import csv
import io
import json
import os
import platform
import sys
from collections import Counter
from importlib import metadata
from pathlib import Path

from . import MAX_WEBSITES, __version__
from .errors import REASON_TEXT, RESUMABLE
from .store import ENRICHED, FAILED, INACCESSIBLE, PENDING, PRIVATE_SKIPPED, Store
from .url import canonical_profile_url

CSV_COLUMNS = [
    "run_id", "user_id", "username", "profile_url", "kind", "original", "normalized", "e164", "status",
    "extension", "method", "source", "field", "source_url", "observed_at", "evidence", "attribution",
    "profiles_sharing",
]
TEXT_PHONE_COLUMNS = {"original", "normalized", "e164", "extension", "user_id"}
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r", "\n")


def versions() -> dict:
    def v(name: str) -> str:
        try:
            return metadata.version(name)
        except metadata.PackageNotFoundError:
            return "no instalado"

    return {
        "pilot": __version__,
        "python": platform.python_version(),
        "instaloader": v("instaloader"),
        "phonenumbers": v("phonenumbers"),
        "urllib3": v("urllib3"),
        "requests": v("requests"),
        "os": f"{platform.system()} {platform.release()}",
    }


def csv_safe(value, column: str = "") -> str:
    """Celda segura para hojas de cálculo: sin fórmulas, sin NUL, teléfonos como texto."""
    if value is None:
        return ""
    s = str(value).replace("\x00", "")
    if not s:
        return s
    if s.startswith(FORMULA_PREFIXES):
        return "'" + s
    if column in TEXT_PHONE_COLUMNS and s[0].isdigit():
        return "'" + s  # evita que Excel lo convierta en número y pierda ceros o dígitos
    return s


def atomic_write(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    mode = "wb" if isinstance(data, bytes) else "w"
    kwargs = {} if isinstance(data, bytes) else {"encoding": "utf-8", "newline": ""}
    with open(tmp, mode, **kwargs) as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def counters(store: Store) -> dict:
    run = store.get_run()
    by_status = Counter(dict(store.db.execute("SELECT status, count(*) FROM followers GROUP BY status").fetchall()))
    with_contacts = store.db.execute(
        "SELECT count(DISTINCT c.user_id) FROM contacts c JOIN followers f USING(user_id) "
        "WHERE f.status=? AND c.source='instagram_profile'", (ENRICHED,)).fetchone()[0]
    return {
        "rows_received": run.rows_received,
        "unique_followers": store.unique_followers(),
        "duplicates": run.duplicates,
        "private_skipped": by_status.get(PRIVATE_SKIPPED, 0),
        "public_consulted": by_status.get(ENRICHED, 0),
        "inaccessible": by_status.get(INACCESSIBLE, 0),
        "failed": by_status.get(FAILED, 0),
        "pending": by_status.get(PENDING, 0),
        "public_with_profile_contacts": with_contacts,
        "public_without_profile_contacts": by_status.get(ENRICHED, 0) - with_contacts,
    }


def contact_stats(store: Store) -> dict:
    db = store.db
    rows = db.execute("SELECT kind, status, source, field, attribution, normalized, original, user_id FROM contacts").fetchall()
    sharing: dict[tuple[str, str], set[str]] = {}
    for r in rows:
        sharing.setdefault((r["kind"], r["normalized"] or r["original"]), set()).add(r["user_id"])
    return {
        "observations": len(rows),
        "unique_values": len(sharing),
        "values_in_several_profiles": sum(1 for s in sharing.values() if len(s) > 1),
        "by_kind": dict(Counter(r["kind"] for r in rows)),
        "by_status": dict(Counter(f"{r['kind']}:{r['status']}" for r in rows)),
        "by_source_field": dict(Counter(f"{r['source']}:{r['field']}" for r in rows)),
        "by_attribution": dict(Counter(r["attribution"] for r in rows)),
        "rejected_numbers": dict(
            db.execute("SELECT reason, sum(count) FROM rejected_numbers GROUP BY reason").fetchall()),
    }


def contact_key_stats(store: Store) -> dict:
    """Nombres de claves de botones de contacto vistas en las respuestas (sin valores)."""
    counter: Counter[str] = Counter()
    profiles_with_raw = 0
    for (keys,) in store.db.execute("SELECT contact_keys FROM followers WHERE status=?", (ENRICHED,)):
        profiles_with_raw += 1
        for k in json.loads(keys or "[]"):
            counter[k] += 1
    return {"profiles_inspected": profiles_with_raw, "keys_with_value": dict(counter)}


def web_stats(store: Store) -> dict:
    rows = store.db.execute("SELECT page, outcome, detail FROM web_fetches").fetchall()
    return {
        "max_sites": MAX_WEBSITES,
        "sites_attempted": store.websites_attempted(),
        "pages": dict(Counter(f"{r['page']}:{r['outcome']}" for r in rows)),
    }


def build_summary(store: Store) -> dict:
    run = store.get_run()
    return {
        "run_id": run.run_id,
        "target": {
            "username": run.target_username,
            "user_id": run.target_userid,
            "profile_url": canonical_profile_url(run.target_username),
            "followers_count_reported": run.target_followers_count,
        },
        "session_username": run.session_username,
        "config": {"limit_total": run.limit_total, "include_web": run.include_web},
        "status": run.status,
        "stop_reason": run.stop_reason,
        "stop_reason_text": REASON_TEXT.get(run.stop_reason or "", ""),
        "stop_detail": run.stop_detail,
        "resumable": run.stop_reason in RESUMABLE and run.status != "completed",
        "cursor": {"exhausted": run.cursor_exhausted, "generation": run.cursor_generation,
                   "saved": run.cursor_state is not None},
        "sessions": run.sessions,
        "created_at": run.created_at,
        "updated_at": store.db.execute("SELECT updated_at FROM runs").fetchone()[0],
        "counters": counters(store),
        "contacts": contact_stats(store),
        "contact_buttons": {
            "exposed_by_instaloader": False,
            "note": "Instaloader 4.16 no expone botones de contacto (correo/teléfono del perfil profesional). "
                    "Solo se registran nombres de claves presentes en la respuesta, sin extraer sus valores.",
            **contact_key_stats(store),
        },
        "web": web_stats(store),
        "versions": versions(),
        "paid_dependencies": "ninguna",
    }


def write_followers_jsonl(store: Store, path: Path) -> None:
    buf = io.StringIO()
    history: dict[str, list[str]] = {}
    for r in store.db.execute("SELECT user_id, username FROM username_history ORDER BY observed_at"):
        history.setdefault(r["user_id"], []).append(r["username"])
    counts = dict(store.db.execute(
        "SELECT user_id, count(*) FROM contacts WHERE source='instagram_profile' GROUP BY user_id").fetchall())
    for r in store.db.execute("SELECT * FROM followers ORDER BY position"):
        status = r["status"]
        if status == ENRICHED:
            contacts_status = "found" if counts.get(r["user_id"]) else "none_found"
        elif status == PENDING:
            contacts_status = "not_consulted"
        else:
            contacts_status = status
        public = status == ENRICHED
        record = {
            "position": r["position"],
            "user_id": r["user_id"],
            "username": r["username"],
            "profile_url": canonical_profile_url(r["username"]),
            "status": status,
            "status_detail": r["status_detail"],
            "is_private": None if r["is_private"] is None else bool(r["is_private"]),
            "is_verified": None if r["is_verified"] is None else bool(r["is_verified"]),
            "full_name": r["full_name"] if status != PRIVATE_SKIPPED else None,
            "biography": r["biography"] if public else None,
            "external_url": r["external_url"] if public else None,
            "bio_links": json.loads(r["bio_links"]) if public and r["bio_links"] else [],
            "category": r["category"] if public else None,
            "is_business": None if not public or r["is_business"] is None else bool(r["is_business"]),
            "contact_button_keys_present": json.loads(r["contact_keys"]) if public and r["contact_keys"] else [],
            "contacts_status": contacts_status,
            "profile_contacts": counts.get(r["user_id"], 0),
            "first_seen_at": r["first_seen_at"],
            "observed_at": r["observed_at"],
            "times_seen": r["times_seen"],
            "usernames_seen": history.get(r["user_id"], [r["username"]]),
        }
        buf.write(json.dumps(record, ensure_ascii=False) + "\n")
    atomic_write(path, buf.getvalue())


def write_contacts_csv(store: Store, path: Path) -> int:
    rows = store.db.execute(
        "SELECT c.*, f.username FROM contacts c JOIN followers f USING(user_id) ORDER BY f.position, c.id").fetchall()
    sharing: dict[tuple[str, str], set[str]] = {}
    for r in rows:
        sharing.setdefault((r["kind"], r["normalized"] or r["original"]), set()).add(r["user_id"])
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    writer.writerow(CSV_COLUMNS)
    for r in rows:
        values = {k: r[k] for k in r.keys() if k in CSV_COLUMNS}
        values["profile_url"] = canonical_profile_url(r["username"])
        values["profiles_sharing"] = len(sharing[(r["kind"], r["normalized"] or r["original"])])
        writer.writerow([csv_safe(values.get(col), col) for col in CSV_COLUMNS])
    atomic_write(path, ("﻿" + buf.getvalue()).encode("utf-8"))
    return len(rows)


def write_contacts_jsonl(store: Store, path: Path) -> None:
    """Mismos datos que contacts.csv, sin el saneamiento para hojas de cálculo (para el visor)."""
    rows = store.db.execute(
        "SELECT c.*, f.username FROM contacts c JOIN followers f USING(user_id) ORDER BY f.position, c.id").fetchall()
    sharing: dict[tuple[str, str], set[str]] = {}
    for r in rows:
        sharing.setdefault((r["kind"], r["normalized"] or r["original"]), set()).add(r["user_id"])
    buf = io.StringIO()
    for r in rows:
        record = {k: r[k] for k in r.keys() if k in CSV_COLUMNS}
        record["profile_url"] = canonical_profile_url(r["username"])
        record["profiles_sharing"] = len(sharing[(r["kind"], r["normalized"] or r["original"])])
        buf.write(json.dumps(record, ensure_ascii=False) + "\n")
    atomic_write(path, buf.getvalue())


def write_log(store: Store, path: Path) -> None:
    lines = [f"{r['at']} {r['level'].upper():7} {r['code']} {r['detail'] or ''}".rstrip()
             for r in store.db.execute("SELECT * FROM events ORDER BY id")]
    atomic_write(path, "\n".join(lines) + "\n")


def render_markdown(summary: dict, paths: dict[str, str]) -> str:
    c = summary["counters"]
    k = summary["contacts"]
    w = summary["web"]
    b = summary["contact_buttons"]
    v = summary["versions"]
    lines = [
        f"# Piloto Instagram — ejecución {summary['run_id']}",
        "",
        f"- Objetivo: `{summary['target']['username']}` (ID {summary['target']['user_id']}), "
        f"seguidores declarados: {summary['target']['followers_count_reported']}",
        f"- Estado: **{summary['status']}** — motivo: `{summary['stop_reason']}` — {summary['stop_reason_text']}",
        f"- Detalle: {summary['stop_detail'] or '—'}",
        f"- Límite acumulado: {summary['config']['limit_total']} · webs: "
        f"{'sí' if summary['config']['include_web'] else 'no'} · sesiones de trabajo: {summary['sessions']}",
        f"- Reanudable: {'sí' if summary['resumable'] else 'no'} · cursor guardado: "
        f"{'sí' if summary['cursor']['saved'] else 'no'} · lista agotada: {'sí' if summary['cursor']['exhausted'] else 'no'}",
        f"- Creado: {summary['created_at']} · última actualización: {summary['updated_at']} (UTC)",
        "",
        "## Seguidores",
        "",
        "| Métrica | Valor |",
        "| --- | ---: |",
        f"| Filas recibidas | {c['rows_received']} |",
        f"| Seguidores únicos (por ID) | {c['unique_followers']} |",
        f"| Duplicados | {c['duplicates']} |",
        f"| Privados omitidos | {c['private_skipped']} |",
        f"| Públicos consultados | {c['public_consulted']} |",
        f"| Inaccesibles | {c['inaccessible']} |",
        f"| Fallos | {c['failed']} |",
        f"| Pendientes | {c['pending']} |",
        f"| Públicos con algún contacto en el perfil | {c['public_with_profile_contacts']} |",
        f"| Públicos sin contacto en el perfil | {c['public_without_profile_contacts']} |",
        "",
        "## Contactos (solo cantidades)",
        "",
        f"- Observaciones: {k['observations']} · valores distintos: {k['unique_values']} · "
        f"valores en varios perfiles: {k['values_in_several_profiles']}",
        f"- Por tipo: {json.dumps(k['by_kind'], ensure_ascii=False)}",
        f"- Por estado: {json.dumps(k['by_status'], ensure_ascii=False)}",
        f"- Por origen: {json.dumps(k['by_source_field'], ensure_ascii=False)}",
        f"- Atribución: {json.dumps(k['by_attribution'], ensure_ascii=False)}",
        f"- Secuencias numéricas descartadas como teléfono: {json.dumps(k['rejected_numbers'], ensure_ascii=False)}",
        "",
        "## Botones de contacto",
        "",
        f"- {b['note']}",
        f"- Perfiles revisados: {b['profiles_inspected']} · claves con valor presentes: "
        f"{json.dumps(b['keys_with_value'], ensure_ascii=False) or '{}'}",
        "",
        "## Sitios web",
        "",
        f"- Sitios consultados: {w['sites_attempted']} de máximo {w['max_sites']} · páginas: "
        f"{json.dumps(w['pages'], ensure_ascii=False)}",
        "",
        "## Versiones",
        "",
        f"- Piloto {v['pilot']} · Python {v['python']} · Instaloader {v['instaloader']} · phonenumbers "
        f"{v['phonenumbers']} · urllib3 {v['urllib3']} · requests {v['requests']} · {v['os']}",
        f"- Dependencias de pago: {summary['paid_dependencies']}",
        "",
        "## Archivos",
        "",
        *[f"- {name}: `{p}`" for name, p in paths.items()],
        "",
        "Los contactos y biografías están solo en los archivos de datos (fuera del repositorio). "
        "Este informe y el registro contienen únicamente cantidades.",
        "",
    ]
    return "\n".join(lines)


def write_outputs(store: Store, run_dir: Path) -> dict[str, str]:
    run_dir = Path(run_dir)
    paths = {
        "base": str(store.path),
        "followers": str(run_dir / "followers.jsonl"),
        "contacts": str(run_dir / "contacts.csv"),
        "contacts_jsonl": str(run_dir / "contacts.jsonl"),
        "summary": str(run_dir / "summary.json"),
        "report": str(run_dir / "report.md"),
        "log": str(run_dir / "run.log"),
    }
    write_followers_jsonl(store, Path(paths["followers"]))
    write_contacts_csv(store, Path(paths["contacts"]))
    write_contacts_jsonl(store, Path(paths["contacts_jsonl"]))
    summary = build_summary(store)
    summary["files"] = paths
    atomic_write(Path(paths["summary"]), json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    atomic_write(Path(paths["report"]), render_markdown(summary, paths))
    write_log(store, Path(paths["log"]))
    return paths


def console_summary(summary: dict) -> str:
    c = summary["counters"]
    k = summary["contacts"]
    return (
        f"Estado: {summary['status']} ({summary['stop_reason']}) — {summary['stop_reason_text']}\n"
        f"Filas {c['rows_received']} · únicos {c['unique_followers']} · duplicados {c['duplicates']} · "
        f"privados omitidos {c['private_skipped']} · públicos consultados {c['public_consulted']} · "
        f"inaccesibles {c['inaccessible']} · fallos {c['failed']} · pendientes {c['pending']}\n"
        f"Contactos: {k['observations']} observaciones, {k['unique_values']} valores distintos "
        f"({json.dumps(k['by_kind'], ensure_ascii=False)})"
    )


if sys.version_info < (3, 11):  # pragma: no cover
    raise RuntimeError("Se requiere Python 3.11 o superior.")

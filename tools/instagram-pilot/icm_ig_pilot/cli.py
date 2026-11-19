"""Línea de comandos: login, run, resume, report.

Ejemplo (PowerShell, desde tools\\instagram-pilot):
    .venv\\Scripts\\python.exe -m icm_ig_pilot login --user MI_CUENTA
    .venv\\Scripts\\python.exe -m icm_ig_pilot run --target https://www.instagram.com/perfil/ --user MI_CUENTA
"""

from __future__ import annotations

import argparse
import getpass
import os
import signal
import sys
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from . import DEFAULT_LIMIT, DEFAULT_MAX_MINUTES, MAX_FOLLOWERS
from .errors import CURSOR_EXPIRED, REASON_TEXT, SESSION_INVALID, TARGET_PRIVATE, PilotStop
from .url import TargetError, parse_target

EXIT_OK, EXIT_STOPPED, EXIT_USAGE, EXIT_BUSY = 0, 3, 2, 4


def state_root() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.path.join(Path.home(), ".local", "share")
    return Path(base) / "icmSpy" / "instagram-pilot"


def default_session_file(user: str) -> Path:
    return state_root() / "sessions" / f"session-{user}"


def _repo_root() -> Path | None:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / ".git").exists():
            return parent
    return None


def ensure_outside_repo(path: Path, what: str) -> Path:
    resolved = path.expanduser().resolve()
    repo = _repo_root()
    if repo is not None and (resolved == repo or repo in resolved.parents):
        raise SystemExit(f"{what} debe estar fuera del repositorio ({repo}). Ruta rechazada: {resolved}")
    return resolved


@contextmanager
def single_instance():
    """Un solo proceso del piloto a la vez (bloqueo de archivo liberado por el SO al salir)."""
    root = state_root()
    root.mkdir(parents=True, exist_ok=True)
    fh = open(root / "pilot.lock", "a+b")
    try:
        try:
            if os.name == "nt":
                import msvcrt

                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("Ya hay otra ejecución del piloto activa. Espere a que termine.", file=sys.stderr)
            raise SystemExit(EXIT_BUSY) from None
        yield
    finally:
        fh.close()


def install_interrupt(guard) -> None:
    def handler(signum, frame):
        if guard.stop_requested:
            raise KeyboardInterrupt
        guard.stop_requested = True
        print("\nDeteniendo tras la unidad en curso (Ctrl+C otra vez para cortar ya)...", file=sys.stderr)

    signal.signal(signal.SIGINT, handler)


def _make_gateway(max_minutes: float):
    from .gateway import Guard, InstaloaderGateway

    guard = Guard(deadline=time.monotonic() + max_minutes * 60)
    return guard, InstaloaderGateway(guard)


def _load_session(gateway, user: str, session_file: Path) -> str:
    if not session_file.exists():
        raise SystemExit(f"No hay sesión guardada en {session_file}. Ejecute primero el comando 'login'.")
    gateway.load_session(user, session_file)
    method = gateway.verify_identity(user)
    print(f"Sesión verificada para {user} ({method}).")
    return user


# --- comandos ----------------------------------------------------------------------------------

def cmd_login(args) -> int:
    import instaloader.exceptions as ie

    user = args.user.strip().lower()
    session_file = ensure_outside_repo(Path(args.session_file) if args.session_file else default_session_file(user),
                                       "El archivo de sesión")
    if args.paste_sessionid:
        return _login_with_pasted_cookies(user, session_file)
    with single_instance():
        guard, gw = _make_gateway(10)
        try:
            password = getpass.getpass(f"Contraseña de Instagram para {user} (no se muestra ni se guarda): ")
            try:
                gw.loader.login(user, password)
            except ie.TwoFactorAuthRequiredException:
                code = getpass.getpass("Código de verificación en dos pasos (no se muestra): ").strip()
                gw.loader.two_factor_login(code)
            finally:
                password = None  # noqa: F841 - no se conserva
        except ie.BadCredentialsException:
            print("Usuario o contraseña incorrectos. No se reintenta automáticamente.", file=sys.stderr)
            return EXIT_STOPPED
        except (ie.ConnectionException, ie.LoginException) as err:
            text = str(err).lower()
            if "checkpoint" in text or "challenge" in text:
                print("Instagram pidió una verificación (checkpoint). Resuélvala en la app o en el navegador "
                      "con su cuenta y vuelva a ejecutar 'login' más tarde. No se reintenta.", file=sys.stderr)
            else:
                print(f"No se pudo iniciar sesión ({type(err).__name__}). No se reintenta.", file=sys.stderr)
            return EXIT_STOPPED
        except PilotStop as stop:
            print(f"Detenido: {REASON_TEXT.get(stop.reason, stop.reason)}", file=sys.stderr)
            return EXIT_STOPPED
        # Instagram respondió "authenticated: true" para `user`; no se hace otra consulta aquí
        # (justo después del login Instagram suele pedir esperar). `run` vuelve a verificar.
        if gw.loader.context.username != user or gw.session_user_id() is None:
            print("La respuesta del inicio de sesión no identifica la cuenta; no se guarda.", file=sys.stderr)
            return EXIT_STOPPED
        if not gw.prepare_session_for_saving():
            print("Instagram aceptó la contraseña pero no entregó la cookie de sesión (sessionid); "
                  "suele indicar una verificación pendiente. Revise la app de Instagram, apruebe el "
                  "inicio de sesión si lo pide y vuelva a intentarlo más tarde. No se guarda.", file=sys.stderr)
            return EXIT_STOPPED
        session_file.parent.mkdir(parents=True, exist_ok=True)
        gw.loader.save_session_to_file(str(session_file))
        gw.close()
        print(f"Inicio de sesión aceptado para {user}. Sesión guardada en: {session_file}")
        print("Espere unos 15 minutos antes de la primera ejecución para no encadenar consultas.")
        print("Ese archivo da acceso a la cuenta: no lo copie al repositorio ni lo comparta.")
        return EXIT_OK


COOKIE_RE = r"^[A-Za-z0-9%:._\-]{8,512}$"


def _ask_cookie(name: str, pattern: str = COOKIE_RE) -> str | None:
    import re

    value = getpass.getpass(f"Valor de la cookie {name} (no se muestra): ").strip().strip('"').strip("'")
    if not re.match(pattern, value):
        print(f"El valor de {name} no tiene el formato esperado; no se guarda nada.", file=sys.stderr)
        return None
    return value


def _login_with_pasted_cookies(user: str, session_file: Path) -> int:
    """Sesión a partir de cookies que el usuario copia a mano de su navegador y pega en la terminal.

    No lee navegadores ni archivos de otras aplicaciones. Los valores no se muestran ni se registran;
    solo se guardan, como hace Instaloader, en el archivo de sesión fuera del repositorio.
    """
    print("Abra instagram.com en su navegador con la cuenta", user,
          "→ F12 → Aplicación/Almacenamiento → Cookies → https://www.instagram.com")
    print("Copie y pegue aquí, una por una, las cookies sessionid, csrftoken y ds_user_id.")
    sessionid = _ask_cookie("sessionid")
    csrftoken = _ask_cookie("csrftoken") if sessionid else None
    ds_user_id = _ask_cookie("ds_user_id", r"^\d{3,20}$") if csrftoken else None
    if not ds_user_id:
        return EXIT_STOPPED
    with single_instance():
        guard, gw = _make_gateway(10)
        try:
            gw.loader.load_session(user, {"sessionid": sessionid, "csrftoken": csrftoken, "ds_user_id": ds_user_id})
            sessionid = csrftoken = None  # noqa: F841 - no se conservan en variables
            method = gw.verify_identity(user)
        except PilotStop as stop:
            print(f"No se guarda: {REASON_TEXT.get(stop.reason, stop.reason)}", file=sys.stderr)
            gw.close()
            return EXIT_STOPPED
        session_file.parent.mkdir(parents=True, exist_ok=True)
        gw.loader.save_session_to_file(str(session_file))
        gw.close()
        print(f"Sesión verificada para {user} ({method}) y guardada en: {session_file}")
        print("Ese archivo da acceso a la cuenta: no lo copie al repositorio ni lo comparta. "
              "No cierre sesión en el navegador mientras dure la prueba (invalidaría la cookie).")
        return EXIT_OK


def _validate_limit(limit: int) -> int:
    if not 1 <= limit <= MAX_FOLLOWERS:
        raise SystemExit(f"El límite debe estar entre 1 y {MAX_FOLLOWERS}.")
    return limit


def _finish(store, run_dir: Path, outcome=None) -> int:
    from .report import build_summary, console_summary, write_outputs

    paths = write_outputs(store, run_dir)
    summary = build_summary(store)
    print(console_summary(summary))
    print("Archivos:")
    for name, p in paths.items():
        print(f"  {name}: {p}")
    if summary["stop_reason"] == CURSOR_EXPIRED:
        print("El cursor caducó: puede continuar con 'resume --restart-cursor' (relee la lista desde el inicio "
              "y descarta repetidos por ID).")
    return EXIT_OK if summary["status"] == "completed" else EXIT_STOPPED


def cmd_run(args) -> int:
    from .pipeline import Pipeline
    from .store import Store

    try:
        target = parse_target(args.target)
    except TargetError as err:
        print(f"Objetivo rechazado: {err}", file=sys.stderr)
        return EXIT_USAGE
    user = args.user.strip().lower()
    limit = _validate_limit(args.limit)
    session_file = ensure_outside_repo(Path(args.session_file) if args.session_file else default_session_file(user),
                                       "El archivo de sesión")
    output_root = ensure_outside_repo(Path(args.output) if args.output else state_root() / "runs",
                                      "La carpeta de salida")
    with single_instance():
        guard, gw = _make_gateway(args.max_minutes)
        install_interrupt(guard)
        try:
            _load_session(gw, user, session_file)
            info = gw.resolve_target(target)
            if info.is_private:
                raise PilotStop(TARGET_PRIVATE, "objetivo privado")
        except PilotStop as stop:
            print(f"Detenido antes de empezar: {REASON_TEXT.get(stop.reason, stop.reason)}", file=sys.stderr)
            gw.close()
            return EXIT_STOPPED
        run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + info.username
        run_dir = output_root / run_id
        store = Store(run_dir / "pilot.sqlite")
        store.create_run(run_id=run_id, target_input=args.target, target_username=info.username,
                         target_userid=info.userid, target_full_name=info.full_name,
                         target_followers_count=info.followers, session_username=user,
                         limit_total=limit, include_web=args.web)
        store.begin_session()
        store.event("info", "session_verified", "sesión verificada")
        store.event("info", "target_resolved", f"objetivo={info.username} seguidores_declarados={info.followers}")
        print(f"Ejecución {run_id}: objetivo {info.username}, límite {limit}, plazo {args.max_minutes} min.")
        try:
            Pipeline(store, gw, guard, progress=lambda m: print(m)).execute()
            return _finish(store, run_dir)
        finally:
            gw.close()
            store.close()


def cmd_resume(args) -> int:
    from .pipeline import Pipeline
    from .store import Store

    run_dir = Path(args.run_dir).expanduser().resolve()
    db_path = run_dir / "pilot.sqlite"
    if not db_path.exists():
        print(f"No hay una ejecución en {run_dir}.", file=sys.stderr)
        return EXIT_USAGE
    with single_instance():
        store = Store(db_path)
        try:
            run = store.get_run()
            if run.run_id != run_dir.name:
                print("La base no corresponde a esta carpeta de ejecución.", file=sys.stderr)
                return EXIT_USAGE
            if run.status == "completed" and args.limit in (None, run.limit_total):
                print("La ejecución ya está completa. Use --limit para ampliarla o 'report' para regenerar salidas.")
                return EXIT_OK
            limit = run.limit_total if args.limit is None else _validate_limit(args.limit)
            if limit < store.unique_followers():
                print("El límite no puede ser menor que los seguidores ya guardados.", file=sys.stderr)
                return EXIT_USAGE
            session_file = ensure_outside_repo(
                Path(args.session_file) if args.session_file else default_session_file(run.session_username),
                "El archivo de sesión")
            if run.stop_reason == CURSOR_EXPIRED and not args.restart_cursor:
                print("El cursor de esta ejecución caducó. Para continuar use --restart-cursor "
                      "(relee la lista desde el inicio y descarta repetidos por ID).", file=sys.stderr)
                return EXIT_STOPPED
            guard, gw = _make_gateway(args.max_minutes)
            install_interrupt(guard)
            try:
                _load_session(gw, run.session_username, session_file)
            except PilotStop as stop:
                print(f"Detenido antes de reanudar: {REASON_TEXT.get(stop.reason, stop.reason)}", file=sys.stderr)
                gw.close()
                return EXIT_STOPPED
            if args.restart_cursor:
                store.reset_cursor()
                store.event("warning", "cursor_restarted", "lista releída desde el inicio")
            store.begin_session(limit_total=limit, include_web=args.web)
            store.event("info", "session_verified", "sesión verificada (reanudación)")
            print(f"Reanudando {run.run_id}: {store.unique_followers()} seguidores guardados, límite {limit}.")
            try:
                Pipeline(store, gw, guard, progress=lambda m: print(m)).execute()
                return _finish(store, run_dir)
            finally:
                gw.close()
        finally:
            store.close()


def cmd_report(args) -> int:
    from .store import Store

    run_dir = Path(args.run_dir).expanduser().resolve()
    db_path = run_dir / "pilot.sqlite"
    if not db_path.exists():
        print(f"No hay una ejecución en {run_dir}.", file=sys.stderr)
        return EXIT_USAGE
    store = Store(db_path)
    try:
        _finish(store, run_dir)
        return EXIT_OK
    finally:
        store.close()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="icm_ig_pilot", description="Piloto local de seguidores de Instagram (ICM).")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("login", help="Inicia sesión en la terminal y guarda la sesión fuera del repositorio.")
    s.add_argument("--user", required=True, help="Cuenta de Instagram que se usará.")
    s.add_argument("--session-file", help="Ruta del archivo de sesión (por defecto en %%LOCALAPPDATA%%).")
    s.add_argument("--paste-sessionid", action="store_true",
                   help="En vez de contraseña, pegar a mano las cookies de una sesión abierta en su navegador.")
    s.set_defaults(func=cmd_login)

    s = sub.add_parser("run", help="Nueva ejecución sobre un perfil público.")
    s.add_argument("--target", required=True, help="URL del perfil o nombre de usuario.")
    s.add_argument("--user", required=True, help="Cuenta de la sesión guardada.")
    s.add_argument("--session-file")
    s.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"Seguidores (por defecto {DEFAULT_LIMIT}, máx. {MAX_FOLLOWERS}).")
    s.add_argument("--output", help="Carpeta raíz de ejecuciones (fuera del repositorio).")
    s.add_argument("--max-minutes", type=float, default=DEFAULT_MAX_MINUTES)
    s.add_argument("--web", action="store_true", help="Consultar sitios web enlazados (máx. 20). Desactivado por defecto.")
    s.set_defaults(func=cmd_run)

    s = sub.add_parser("resume", help="Continúa una ejecución guardada.")
    s.add_argument("--run-dir", required=True)
    s.add_argument("--session-file")
    s.add_argument("--limit", type=int, help=f"Nuevo límite acumulado (máx. {MAX_FOLLOWERS}).")
    s.add_argument("--max-minutes", type=float, default=DEFAULT_MAX_MINUTES)
    web = s.add_mutually_exclusive_group()
    web.add_argument("--web", dest="web", action="store_true", default=None)
    web.add_argument("--no-web", dest="web", action="store_false")
    s.add_argument("--restart-cursor", action="store_true", help="Relee la lista si el cursor caducó.")
    s.set_defaults(func=cmd_resume)

    s = sub.add_parser("report", help="Regenera las salidas desde la base (sin red).")
    s.add_argument("--run-dir", required=True)
    s.set_defaults(func=cmd_report)
    return p


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args(argv)
    if getattr(args, "max_minutes", 1) is not None and getattr(args, "max_minutes", 1) <= 0:
        print("--max-minutes debe ser positivo.", file=sys.stderr)
        return EXIT_USAGE
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

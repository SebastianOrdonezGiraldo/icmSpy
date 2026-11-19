/**
 * Contrato de persistencia de la recolección.
 *
 * Cada método es una unidad atómica (en PostgreSQL, una transacción que bloquea la fila de la
 * ejecución con `SELECT … FOR UPDATE`). Ninguno espera al proveedor: el recolector reserva,
 * llama a la fuente fuera de la transacción y vuelve con el resultado. Las reglas de negocio
 * viven en `rules.ts`; cada implementación solo carga el estado, invoca la regla y persiste.
 */
import {
  applyExtend,
  applyFailure,
  applyFinish,
  applyPage,
  applyProfile,
  applyRecover,
  applyReserve,
  applyResolve,
  type CollectResult,
  type KnownFollower,
  type Lease,
  type OperationRef,
  type ProfileTarget,
  pagePks,
  type RequestGuard,
  type Reservation,
  type RunHead,
  type StopDecision,
} from "./rules";
import type { FollowerProfile, FollowersPage, Run, StoredFollower, TargetAccount } from "./types";

export interface RunStore {
  /** Crea la ejecución (sin intentos, páginas ni seguidores). */
  create(run: Run): Promise<void>;
  /** Lectura sin bloqueo de la cabecera (sin la lista de seguidores). */
  getHead(runId: string): Promise<RunHead>;
  /** Amplía objetivo o presupuesto; invalida el resultado vigente. */
  extend(runId: string, changes: { requested?: number; budgetMaxCalls?: number }): Promise<void>;
  /** Comprueba la operación y, si procede, reserva un intento. Devuelve solo lo necesario para llamar. */
  reserveAttempt(
    runId: string,
    epoch: number,
    op: OperationRef,
    guard?: RequestGuard,
  ): Promise<Reservation>;
  /**
   * Confirma la resolución de la cuenta y cierra el intento como "succeeded". Exige un permiso
   * de resolución de esta ejecución, vigente y con el intento todavía reservado.
   */
  commitResolve(runId: string, lease: Lease, target: TargetAccount): Promise<void>;
  /**
   * Confirma una página con sus seguidores, contadores, cursor, estado de la lista e intento.
   * Exige un permiso de página de esta ejecución; el cursor se toma del propio permiso.
   */
  commitPage(runId: string, lease: Lease, page: FollowersPage): Promise<void>;
  /**
   * Confirma la consulta del perfil de un seguidor (permiso de perfil de esta ejecución): sus
   * contactos y su estado de enriquecimiento, junto con el intento, en una operación atómica.
   */
  commitProfile(runId: string, lease: Lease, profile: FollowerProfile): Promise<void>;
  /** Siguiente seguidor seleccionado, público y pendiente de consultar (lectura sin bloqueo). */
  nextProfileToEnrich(runId: string): Promise<{ pk: string } | null>;
  /** Registra el fallo de un intento vigente de esta ejecución; devuelve la revisión resultante. */
  failAttempt(runId: string, lease: Lease, message: string): Promise<number>;
  /** Reconcilia como "uncertain" el intento indicado si sigue reservado (1) o nada (0). */
  recoverAttempt(runId: string, attemptId: number): Promise<number>;
  /** Cierra si la revisión coincide; si no, devuelve in_progress, el resultado vigente o superseded. */
  finish(
    runId: string,
    epoch: number,
    decision: StopDecision,
    guard?: RequestGuard,
  ): Promise<CollectResult>;
}

function profileTargetOf(f: StoredFollower | undefined): ProfileTarget | null {
  if (!f) return null;
  return {
    pk: f.pk,
    username: f.username,
    order: f.order,
    isPrivate: f.isPrivate,
    enrichment: f.enrichment,
  };
}

function headOf(run: Run): RunHead {
  const { followers, ...rest } = run;
  return { ...rest, attemptCount: rest.attempts.length, uniqueCount: followers.length };
}

/** Implementación en memoria para pruebas. Cada método es síncrono por dentro: atómico. */
export class MemoryRunStore implements RunStore {
  private runs = new Map<string, Run>();

  async create(run: Run): Promise<void> {
    if (this.runs.has(run.id)) throw new Error(`La ejecución ${run.id} ya existe`);
    this.runs.set(run.id, structuredClone(run));
  }

  async getHead(runId: string): Promise<RunHead> {
    return headOf(this.snapshot(runId));
  }

  async extend(
    runId: string,
    changes: { requested?: number; budgetMaxCalls?: number },
  ): Promise<void> {
    this.tx(runId, (head) => applyExtend(head, changes));
  }

  async reserveAttempt(
    runId: string,
    epoch: number,
    op: OperationRef,
    guard?: RequestGuard,
  ): Promise<Reservation> {
    return this.tx(runId, (head, run) =>
      applyReserve(
        head,
        epoch,
        op,
        guard,
        op.kind === "profile"
          ? profileTargetOf(run.followers.find((f) => f.pk === op.pk))
          : undefined,
      ),
    );
  }

  async commitResolve(runId: string, lease: Lease, target: TargetAccount): Promise<void> {
    this.tx(runId, (head) => applyResolve(head, lease, target));
  }

  async commitPage(runId: string, lease: Lease, page: FollowersPage): Promise<void> {
    this.tx(runId, (head, run) => {
      // Solo se consultan los seguidores de esta página que ya estaban guardados.
      const wanted = new Set(pagePks(page));
      const known = new Map<string, KnownFollower>();
      for (const f of run.followers) if (wanted.has(f.pk)) known.set(f.pk, f);
      const plan = applyPage(head, lease, page, known);
      const conflicts = new Set(plan.privacyConflicts);
      for (const f of run.followers) {
        if (conflicts.has(f.pk)) {
          f.isPrivate = true;
          f.privacyConflict = true;
          if (f.enrichment === "pending") f.enrichment = "private";
        }
      }
      run.followers.push(...plan.inserts);
    });
  }

  async commitProfile(runId: string, lease: Lease, profile: FollowerProfile): Promise<void> {
    this.tx(runId, (head, run) => {
      const pk = lease.operation.kind === "profile" ? lease.operation.pk : "";
      const follower = run.followers.find((f) => f.pk === pk);
      const plan = applyProfile(head, lease, profileTargetOf(follower), profile);
      if (follower) {
        follower.enrichment = plan.enrichment;
        follower.contacts = plan.contacts;
      }
    });
  }

  async nextProfileToEnrich(runId: string): Promise<{ pk: string } | null> {
    const run = this.snapshot(runId);
    if (!run.enrichProfiles) return null;
    const next = run.followers.find((f) => f.order <= run.requested && f.enrichment === "pending");
    return next ? { pk: next.pk } : null;
  }

  async failAttempt(runId: string, lease: Lease, message: string): Promise<number> {
    return this.tx(runId, (head) => applyFailure(head, lease, message));
  }

  async recoverAttempt(runId: string, attemptId: number): Promise<number> {
    return this.tx(runId, (head) => applyRecover(head, attemptId));
  }

  async finish(
    runId: string,
    epoch: number,
    decision: StopDecision,
    guard?: RequestGuard,
  ): Promise<CollectResult> {
    return this.tx(runId, (head) => applyFinish(head, epoch, decision, guard));
  }

  /** Lectura síncrona completa (con seguidores) para aserciones en pruebas. */
  snapshot(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`No existe la ejecución ${runId}`);
    return structuredClone(run);
  }

  /**
   * Transacción en memoria: copia, aplica la regla y guarda solo si no lanzó. Sin `await`
   * entre lectura y escritura, por lo que es atómica en el bucle de eventos.
   */
  private tx<T>(runId: string, fn: (head: RunHead, run: Run) => T): T {
    const run = this.snapshot(runId);
    const head = headOf(run);
    const result = fn(head, run);
    const { uniqueCount: _u, attemptCount: _a, ...fields } = head;
    this.runs.set(runId, { ...fields, followers: run.followers });
    return result;
  }
}

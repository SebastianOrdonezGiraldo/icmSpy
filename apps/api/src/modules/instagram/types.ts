/**
 * Núcleo de recolección de seguidores de Instagram (MVP, tarea 8).
 *
 * Solo modela la cuenta objetivo y la lista de seguidores. No hay perfiles individuales,
 * contactos, base de datos ni colas: eso llega en tareas posteriores.
 */

/** Cursor de continuación de la fuente. Texto opaco: se guarda y se reenvía sin interpretarlo. */
export type Cursor = string;

export interface TargetAccount {
  /** Identificador estable de la cuenta (texto). */
  pk: string;
  username: string;
  /** Seguidores que declara el perfil; puede no coincidir con lo que la fuente entrega. */
  followerCount: number | null;
  isPrivate: boolean;
  isVerified: boolean;
}

export interface FollowerStub {
  pk: string;
  username: string;
  isPrivate: boolean;
}

export interface FollowersPage {
  users: FollowerStub[];
  /** null: la fuente no ofrece continuación. */
  nextCursor: Cursor | null;
  /** La fuente declara que la lista está limitada (should_limit_list_of_followers). */
  limited: boolean;
}

/** Puerto hacia la fuente (HikerAPI en producción; un falso en las pruebas). */
export interface InstagramProvider {
  resolveAccount(username: string): Promise<TargetAccount>;
  followersPage(targetPk: string, cursor: Cursor | null): Promise<FollowersPage>;
}

export type StopReason =
  | "target_reached"
  | "source_limited"
  | "list_exhausted"
  | "target_private"
  | "budget_exhausted"
  | "cursor_repeated"
  | "cursor_cycle"
  | "provider_error";

export type ListState =
  | "not_started"
  | "open"
  | "limited"
  | "exhausted"
  | "cursor_repeated"
  | "cursor_cycle";

/**
 * Estado de un intento (una llamada a la fuente). Todos ocupan presupuesto.
 * - reserved: reservado y en curso (o interrumpido sin reconciliar).
 * - uncertain: se interrumpió tras llamar; no se sabe si la fuente lo cobró.
 */
export type AttemptStatus = "reserved" | "succeeded" | "failed" | "uncertain";

export interface Attempt {
  id: number;
  /** Operación lógica: "resolve" o "page:<cursor serializado>". Varios intentos pueden compartirla. */
  operation: string;
  kind: "resolve" | "page";
  status: AttemptStatus;
  error?: string;
}

export interface PageRecord {
  pageNo: number;
  requestCursor: Cursor | null;
  nextCursor: Cursor | null;
  limited: boolean;
  received: number;
  newUnique: number;
  duplicates: number;
  attemptId: number;
}

export interface StoredFollower extends FollowerStub {
  /**
   * Privado si alguna observación de esta ejecución lo marcó privado (criterio conservador:
   * un seguidor así no es elegible para consultar contactos).
   */
  isPrivate: boolean;
  /** Las observaciones del mismo ID no coincidieron en privacidad. */
  privacyConflict: boolean;
  /** Orden de primera aparición (1..n). */
  order: number;
  firstPageNo: number;
}

export interface Outcome {
  stopReason: StopReason;
  /** Se alcanzó el número pedido (puede coincidir con ausencia de continuación). */
  targetReached: boolean;
  /** Hay cursor válido para pedir más páginas. */
  continuationAvailable: boolean;
  listState: ListState;
  uniqueReceived: number;
  selected: number;
  attempts: number;
  declaredFollowers: number | null;
  detail?: string;
}

export interface Run {
  id: string;
  username: string;
  /** Seguidores a analizar (objetivo). */
  requested: number;
  /** Tope de intentos (incluye la resolución). */
  budgetMaxCalls: number;
  target: TargetAccount | null;
  attempts: Attempt[];
  pages: PageRecord[];
  followers: StoredFollower[];
  /** Último cursor recibido, tal cual. */
  cursor: Cursor | null;
  listState: ListState;
  /** Resultado vigente; se invalida al aceptar una nueva reserva. */
  outcome: Outcome | null;
  /**
   * Token de cercado. Sube al reconciliar intentos como "uncertain": un trabajador que empezó
   * con un token anterior pierde la capacidad de escribir (datos, errores o cierre).
   */
  epoch: number;
  /**
   * Revisión del estado: sube con cada cambio confirmado. El cierre se escribe condicionado a
   * la revisión que originó la decisión; si cambió, no se guarda ni se reintenta.
   */
  revision: number;
}

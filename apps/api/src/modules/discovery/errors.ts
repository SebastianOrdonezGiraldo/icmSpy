/**
 * Errores de una fuente externa. Su mensaje está pensado para mostrarse al
 * usuario: no lleva URLs internas, credenciales ni datos de contacto.
 */
export class SourceError extends Error {
  /** false si repetir no va a cambiar el resultado (por ejemplo, la estructura cambió). */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = new.target.name;
    this.retryable = retryable;
  }
}

/** La fuente respondió con un estado HTTP de error. */
export class SourceHttpError extends SourceError {
  constructor(
    readonly status: number,
    detail?: string,
  ) {
    super(
      `La fuente respondió con error HTTP ${status}${detail ? `: ${detail}` : ""}`,
      status === 429 || status >= 500,
    );
  }
}

/** No hubo respuesta: red caída, DNS o tiempo de espera agotado. */
export class SourceUnavailableError extends SourceError {
  constructor(message: string) {
    super(message, true);
  }
}

/** La respuesta no tiene la estructura esperada: la fuente cambió y hay que revisar el mapeo. */
export class SourceSchemaError extends SourceError {
  constructor(message: string) {
    super(`La estructura de la fuente cambió: ${message}`, false);
  }
}

/** Los datos leídos no cuadran (conteos, duplicados entre páginas). */
export class SourceConsistencyError extends SourceError {
  constructor(message: string) {
    super(message, true);
  }
}

/** La consulta pedida no es válida para esta fuente. */
export class SourceQueryError extends SourceError {
  constructor(message: string) {
    super(message, false);
  }
}

/** Tamaño de página observado en HikerAPI (/g2/user/followers). Solo sirve para estimar. */
export const TYPICAL_PAGE_SIZE = 25;

export interface CallEstimate {
  resolveCalls: number;
  pageCalls: number;
  total: number;
  /** Siempre es una estimación: la fuente decide el tamaño real de cada página. */
  basis: string;
}

/**
 * Llamadas previstas para llegar a `requested` seguidores únicos.
 * El presupuesto efectivo se aplica igualmente antes de cada intento.
 */
export function estimateCalls(input: {
  requested: number;
  alreadyUnique?: number;
  resolved?: boolean;
  pageSize?: number;
}): CallEstimate {
  const pageSize = input.pageSize ?? TYPICAL_PAGE_SIZE;
  const missing = Math.max(0, input.requested - (input.alreadyUnique ?? 0));
  const resolveCalls = input.resolved ? 0 : 1;
  const pageCalls = Math.ceil(missing / pageSize);
  return {
    resolveCalls,
    pageCalls,
    total: resolveCalls + pageCalls,
    basis: `estimación con ${pageSize} seguidores por página`,
  };
}

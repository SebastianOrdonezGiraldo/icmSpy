/** Tamaño de página observado en HikerAPI (/g2/user/followers). Solo sirve para estimar. */
export const TYPICAL_PAGE_SIZE = 25;

export interface CallEstimate {
  resolveCalls: number;
  pageCalls: number;
  /** Consultas de perfil: cota superior (los privados no se consultan). */
  profileCalls: number;
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
  /** Incluir una consulta de perfil por seguidor pendiente (enriquecimiento). */
  enrichProfiles?: boolean;
}): CallEstimate {
  const pageSize = input.pageSize ?? TYPICAL_PAGE_SIZE;
  const missing = Math.max(0, input.requested - (input.alreadyUnique ?? 0));
  const resolveCalls = input.resolved ? 0 : 1;
  const pageCalls = Math.ceil(missing / pageSize);
  const profileCalls = input.enrichProfiles ? missing : 0;
  return {
    resolveCalls,
    pageCalls,
    profileCalls,
    total: resolveCalls + pageCalls + profileCalls,
    basis: `estimación con ${pageSize} seguidores por página`,
  };
}

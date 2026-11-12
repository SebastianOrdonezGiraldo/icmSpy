export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GET a la API de icmSpy. La sesión viaja en la cookie. */
export async function apiGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "" && value !== false) search.set(key, String(value));
  }
  const qs = search.size ? `?${search}` : "";
  const res = await fetch(`/api${path}${qs}`, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? "Error de red");
  }
  return res.json() as Promise<T>;
}

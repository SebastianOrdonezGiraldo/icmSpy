# 0001. Monolito modular en TypeScript con colas en Postgres

Fecha: 2026-11-12

## Decisión

- Un solo repositorio (pnpm) con `apps/api`, `apps/web`, `packages/db` y `packages/shared`.
- La API (Hono) y el worker (pg-boss) son el mismo código en dos procesos.
- Las colas viven en el mismo Postgres con pg-boss. No se usa Redis.
- Cada fuente de datos es un adaptador detrás del puerto `SourceAdapter`.
- En producción la API sirve también el frontend compilado, así Nginx solo necesita un `proxy_pass`.

## Por qué

Lo mantiene una sola persona. Un solo despliegue y una sola base de datos reducen la operación al
mínimo, y el volumen esperado (miles de empresas) no justifica más piezas. Aislar las fuentes detrás
de un puerto permite añadir o cambiar una sin tocar el resto.

## Consecuencias

- Si la cola crece mucho, el cambio a otra tecnología queda aislado en `apps/api/src/lib/queue.ts`.
- Si el crawler necesita más potencia, se levantan más contenedores `worker`.

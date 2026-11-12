# icmSpy

Herramienta interna de Import Corporal Medical S.A.S. para encontrar empresas (IPS, clínicas y
distribuidores), extraer sus datos de contacto públicos, validarlos y consultarlos.

Alcance actual: **extraer, validar y mostrar**. Sin CRM, campañas ni mensajería.

## Estado

Fase 0 (esqueleto). Ya funciona: login, lista de empresas con filtros, ficha de empresa con la
fuente de cada dato, colas y worker. Los adaptadores de fuentes (REPS, INVIMA, CSV, sitio web)
están declarados pero todavía no importan datos; eso es la fase 1.

## Stack

TypeScript · Hono · Drizzle + PostgreSQL 16 · pg-boss · Better Auth · React + Vite ·
TanStack Query/Router · Tailwind + shadcn/ui · React Hook Form · Zustand · Docker Compose.

## Estructura

```
apps/
  api/                    API (main.ts) y worker (worker.ts): mismo código, dos procesos
    src/modules/
      auth/               Better Auth, sesión y roles (admin, comercial)
      companies/          empresas, contactos y procedencia de cada dato
      discovery/          motor de descubrimiento
        ports/            interfaz SourceAdapter
        adapters/         una fuente por archivo: reps, invima, csv, website
        jobs/             importaciones
      enrichment/         normalización y validación de correos, teléfonos, NIT
      compliance/         lista de supresión (Ley 1581)
    src/lib/queue.ts      único punto de contacto con pg-boss
  web/                    React + Vite, organizado por features
packages/
  db/                     esquema Drizzle y migraciones
  shared/                 esquemas Zod y tipos compartidos entre API y web
deploy/nginx/             ejemplo de sitio Nginx
docs/adr/                 decisiones de arquitectura
```

Para **añadir una fuente**: crear un archivo en `apps/api/src/modules/discovery/adapters/` que
cumpla `SourceAdapter` y registrarlo en `adapters/index.ts`. Nada más cambia.

## Desarrollo local

Requisitos: Node 22, pnpm 10 y Docker.

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d     # Postgres en localhost:5433

cat > .env <<'ENV'
DATABASE_URL=postgres://icmspy:icmspy@localhost:5433/icmspy
BETTER_AUTH_SECRET=dev-secret-dev-secret-dev-secret-1234
APP_URL=http://localhost:5173
ENV

set -a; . ./.env; set +a
pnpm db:migrate
SEED_EMAIL=admin@icm.test SEED_PASSWORD=cambiame123 pnpm seed:admin

pnpm dev          # API en :3020 y web en http://localhost:5173
pnpm dev:worker   # en otra terminal
```

Otros comandos: `pnpm lint`, `pnpm typecheck`, `pnpm --filter @icmspy/api test`, `pnpm build`.
Tras cambiar el esquema: `pnpm db:generate` y luego `pnpm db:migrate`.

## Despliegue en el VPS

icmSpy corre como un proyecto Docker aparte. No toca `icm-website` ni el Postgres del servidor.

```bash
git clone https://github.com/SebastianOrdonezGiraldo/icmSpy.git /opt/icmspy
cd /opt/icmspy
cp .env.example .env        # completar POSTGRES_PASSWORD, BETTER_AUTH_SECRET y APP_URL
docker compose up -d --build
```

Esto levanta Postgres (sin puerto publicado), aplica las migraciones y arranca la API en
`127.0.0.1:3020` y el worker.

Crear los usuarios (el registro público está cerrado):

```bash
docker compose run --rm \
  -e SEED_EMAIL=tu@correo.com -e SEED_PASSWORD='una-clave-larga' \
  -e SEED_NAME='Tu Nombre' -e SEED_ROLE=admin \
  api node dist/seed-admin.js
```

`SEED_ROLE` puede ser `admin` o `comercial`.

Publicar con Nginx: seguir los pasos de `deploy/nginx/icmspy.conf.example`.

Actualizar: `git pull && docker compose up -d --build`.

Respaldo manual: `docker compose exec postgres pg_dump -U icmspy icmspy | gzip > icmspy-$(date +%F).sql.gz`

# icmSpy

Herramienta interna de Import Corporal Medical S.A.S. para encontrar empresas (IPS, clínicas y
distribuidores), extraer sus datos de contacto públicos, validarlos y consultarlos.

Alcance actual: **extraer, validar y mostrar**. Sin CRM, campañas ni mensajería.

## Estado

Ya funciona: login, **buscador de prestadores por servicio, actividad y nombre** (palabra clave +
departamento + municipio, con consulta automática de fuentes oficiales), catálogo de empresas con
filtros, ficha de empresa con sus sedes y la fuente de cada dato, colas y worker. Fuentes operativas:
**REPS** nacional (prestadores, sedes y contactos) y las publicaciones abiertas de **servicios
habilitados por sede** de Cundinamarca (MinSalud, corte 2022) y de la red pública de Boyacá
([`docs/fuentes/servicios.md`](docs/fuentes/servicios.md)). No hay fuente abierta de servicios para
los demás departamentos. INVIMA, CSV, sitios web y APIs de búsqueda no se consultan
([`docs/fuentes/invima.md`](docs/fuentes/invima.md)).

## Buscador de empresas

En la pantalla de empresas el usuario escribe una **palabra clave**, elige un **departamento** y,
si quiere, un **municipio**, y pulsa **“Buscar empresas”**. El sistema consulta las fuentes
operativas, incorpora empresas, sedes y contactos con su procedencia, y muestra **los resultados
de esa búsqueda**, incluidas las empresas que ya estaban en el catálogo. Debajo sigue el catálogo
completo, que acumula todo lo encontrado por cualquier búsqueda.

**Tres vías de descubrimiento**, con la evidencia guardada y mostrada por separado:

1. **Servicio registrado**: la palabra se resuelve contra el catálogo oficial de servicios de REPS
   (exacta, nombre del servicio o equivalencia documentada, p. ej. "fisioterapeuta" → 739
   FISIOTERAPIA) y una fuente oficial relaciona una sede del lugar con ese servicio. La entidad
   aparece aunque su nombre no contenga la palabra.
2. **Actividad relacionada**: conceptos más amplios documentados ("rehabilitación" → fisioterapia,
   terapia ocupacional…). Se muestran aparte: no confirman lo buscado.
3. **Coincidencia por nombre** del prestador o la sede (reglas de abajo).

Se incluyen IPS, **profesionales independientes** (con su cédula, nunca como NIT), entidades con
objeto social diferente y transporte de pacientes. Detalle: [`docs/fuentes/servicios.md`](docs/fuentes/servicios.md).

**Palabra clave (vía por nombre).** Se ignoran mayúsculas y tildes. Varias palabras: deben aparecer **todas**, en
cualquier orden, como texto dentro del nombre del prestador o del nombre de la sede (pueden
repartirse entre ambos). Coincide por contenido (`odonto` encuentra `ODONTOLOGÍA` y
`ODONTOLÓGICA`). Nada es comodín, SQL ni expresión regular. Entre 2 y 80 caracteres, hasta 6
palabras de al menos 2 caracteres. Implementación única en `packages/shared/src/search-runs.ts` (`keywordTerms`,
`matchesKeyword`), usada por la API, el worker, las pruebas y la interfaz.

**Ubicación.** Departamentos y municipios con códigos DANE del catálogo DIVIPOLA incluido en el
código ([`docs/fuentes/divipola.md`](docs/fuentes/divipola.md)). La API rechaza códigos
inexistentes y municipios de otro departamento antes de consultar fuentes. En REPS se filtra por la
ubicación de la **sede**.

**Fuentes.** Las elige el sistema: solo adaptadores marcados `operational`. Siempre REPS
(prestadores); además, las fuentes de servicios que cubren el departamento, solo si la palabra
resolvió algún servicio. La interfaz muestra qué entendió de la palabra, la cobertura y el estado de
cada fuente y su fecha de corte. Validación: [`docs/fuentes/reps.md`](docs/fuentes/reps.md).

### Contrato de la API

Todas las rutas exigen sesión; lanzar búsquedas, roles `admin` y `comercial` (queda en `audit_log`).

- `POST /api/search-runs` — cuerpo `{"keyword": "odontológica", "departmentCode": "63",
  "municipalityCode": "63001" | null}` (esquema `searchCriteriaSchema`). Responde `202 {run,
  created: true}` o, si ya hay una ejecución pendiente o en curso con los mismos criterios
  canónicos, `200 {run, created: false}`. `400` con `fields` si los criterios no son válidos. El
  cliente nunca envía fuentes, URLs ni consultas.
- `GET /api/search-runs?limit=5` — últimas ejecuciones (también las de la búsqueda fija anterior).
- `GET /api/search-runs/:id` — estado, criterios (`criteria`), fuentes y contadores (`stats`).
- `GET /api/search-runs/:id/results?page=1&pageSize=20&kind=ips|profesional|otro&match=service|related|name`
  — prestadores encontrados por esa ejecución (primero los que tienen servicio registrado), con
  tipo, motivos de inclusión, sedes pertinentes con su evidencia (servicio, estado, modalidades,
  corte, enlace al registro; coincidencia de nombre) y contactos (los de la empresa y los de esas sedes).

### Cómo funciona

1. Los criterios se pasan a forma canónica (palabras plegadas, sin repetir y ordenadas; códigos;
   fuentes elegidas por el sistema) y se guardan en `search_runs.query`. Crear la ejecución y
   encolar el job ocurre en **una transacción** (Drizzle y pg-boss por el mismo cliente). Dos
   solicitudes equivalentes ("Clínica Dental" y "dental clinica") comparten la ejecución activa:
   lo garantiza el índice único `search_runs_active_uq`.
2. El worker (`import.dataset`) lee todas las sedes del lugar en REPS y, si corresponde, la fuente
   de servicios (todas las páginas, verificando columnas, tipos y conteo). Cruza servicio y sede por
   código de sede; solo usa sedes que existen hoy en REPS y están en el lugar.
3. En **una sola transacción** bloquea la ejecución, incorpora lo encontrado (original con hash →
   empresa por NIT → sede → **resultado de la ejecución** → contactos salvo los suprimidos →
   procedencia) y la cierra como `done`. Si falla cualquier paso, incluido el cierre, no queda
   nada: ni datos ni resultados, y un reintento parte de cero sin inflar contadores. Si una fuente
   de servicios falla, se reintenta toda la búsqueda; en el último intento se sigue sin ella y la
   ejecución queda **parcial** (`stats.partial`), con esa fuente marcada como fallida. Si falla
   REPS, la búsqueda falla.
   Una ejecución `done` nunca se reabre; un intento reemplazado o anterior al vigente no escribe.
4. Si el job terminó sin cerrar la ejecución (worker caído), al consultarla se marca fallida.

**Resultados de cada búsqueda.** La tabla `search_run_results` (migración
`0002_search_run_results`) guarda ejecución, empresa, sede coincidente, fuente, original y si la
empresa se creó en esa ejecución. No se reconstruye desde `source_records.search_run_id`, que
apunta a la primera ejecución que guardó un original idéntico. Así una búsqueda repetida muestra
sus 20 resultados aunque cree 0 empresas.

**Contactos en los resultados.** Por cada empresa se muestran sus contactos **generales** y los de
las **sedes que coincidieron**, una sola vez cada uno. Los exclusivos de otras sedes quedan en la
ficha. El ámbito sale de la procedencia: cada observación guarda en `data_provenance.scope` si la
fuente publicó el contacto como de la empresa (`company`, en REPS `email_prestador` y
`telefonoprestador`) o de una sede (`site`, `email_sede` y `t_lefonosede`). Un contacto puede
tener ambos ámbitos: estar vinculado a una sede no le quita el general. La migración
`0003_provenance_contact_scope` añade la columna y la rellena para la procedencia de REPS con ese
mismo mapeo; el resto queda en `null` y no se presume general.

**Evidencia.** `site_services` (servicio de cada sede según cada fuente, sin sustituir una
observación más reciente por otra anterior) y `search_run_matches` (motivos de inclusión por
ejecución, de todas las fuentes). Migración `0004_services_and_providers` (aditiva).

**Conteos.** _Sedes leídas en REPS_, _relaciones sede–servicio leídas_, _sedes con el servicio en
el lugar_ / _fuera de él_ / _que ya no figuran en REPS_, _prestadores encontrados_ = _nuevos_ + _ya en
el catálogo_ y su reparto por motivo, _sedes pertinentes_, _contactos_ nuevos o ya registrados,
_suprimidos_ y _no interpretados_.

**Interfaz.** La ejecución mostrada va en la URL (`/?run=<id>`): al recargar se recuperan
criterios, estado y resultados, y la caché nunca mezcla resultados de búsquedas distintas. Si se
editan los filtros, se avisa de que los resultados son de la búsqueda anterior hasta pulsar el
botón. Sondeo cada 3 s mientras está activa y aviso si sigue en cola más de un minuto.

**Historial.** Las ejecuciones de la búsqueda fija anterior ("IPS y clínicas de Quindío") se
conservan y se listan; no guardaron lista de resultados (sus empresas están en el catálogo).

Limitaciones: no hay relación abierta sede → servicio fuera de Cundinamarca (2022) y la red pública
de Boyacá; la relación nacional está en el portal REPS, que exige iniciar sesión y no se automatiza.
REPS se publica una vez al año (corte vigente: marzo de 2026) y no trae sitio web ni distribuidores.
Las publicaciones no confirman vigencia actual. Los correos quedan como `unknown`. No hay
programación periódica ni búsqueda en Internet.

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
pnpm dev:worker   # en otra terminal: sin worker las búsquedas se quedan "en cola"
```

Otros comandos: `pnpm lint`, `pnpm typecheck`, `pnpm --filter @icmspy/api test`, `pnpm build`.
Tras cambiar el esquema: `pnpm db:generate` y luego `pnpm db:migrate`. La migración
`0001_reps_sites_and_runs` añade `company_sites`, `contact_point_sites` y columnas de estado en
`search_runs`; `0002_search_run_results` (aditiva) añade la tabla de resultados por ejecución;
`0004_services_and_providers` (aditiva, con actualización de datos) añade servicios por sede,
evidencias por ejecución e identificación tipada de prestadores;
`0003_provenance_contact_scope` (aditiva, con actualización de datos) guarda el ámbito de cada
contacto en la procedencia.

Pruebas de integración (PostgreSQL real y pg-boss): se ejecutan solo si `TEST_DATABASE_URL`
apunta a una base cuyo nombre termina en `_test`, porque vacían sus tablas. Nunca uses la base de
desarrollo ni la de producción.

```bash
docker compose -f docker-compose.dev.yml exec postgres createdb -U icmspy icmspy_test
TEST_DATABASE_URL=postgres://icmspy:icmspy@localhost:5433/icmspy_test pnpm --filter @icmspy/api test
```

Lanzar la búsqueda sin la interfaz (con una sesión iniciada en `cookies.txt`):

```bash
curl -b cookies.txt -H 'content-type: application/json' \
  -d '{"keyword":"odonto","departmentCode":"63","municipalityCode":null}' \
  http://localhost:3020/api/search-runs
curl -b cookies.txt 'http://localhost:3020/api/search-runs?limit=1'
curl -b cookies.txt 'http://localhost:3020/api/search-runs/<id>/results?page=1'
```

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

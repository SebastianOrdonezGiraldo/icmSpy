# Búsqueda por servicios: catálogo, fuentes y evidencia

Revisión del 2026-11-13. Objetivo: que buscar "fisioterapia" encuentre prestadores con ese servicio
registrado aunque su nombre no contenga la palabra, incluidos los profesionales independientes, y que
cada resultado diga por qué aparece.

## 1. Catálogo oficial de servicios

|                          |                                                                         |
| ------------------------ | ----------------------------------------------------------------------- |
| Recurso                  | CodeSystem FHIR `REPShealthcareServices` (guía RDA de MinSalud)         |
| URL canónica             | `https://fhir.minsalud.gov.co/rda/CodeSystem/REPShealthcareServices`    |
| Descarga usada           | `https://vulcano.ihcecol.gov.co/CodeSystem-REPShealthcareServices.json` |
| Versión / estado / fecha | 1.0.3 · active · 2022-09-02                                             |
| Contenido                | 157 servicios (código y nombre). **739 = FISIOTERAPIA** (verificado)    |
| En el código             | `packages/shared/src/services/catalog.ts` (generado)                    |

El catálogo solo dice qué significa cada código: **no dice quién presta el servicio**. En la
publicación de Cundinamarca aparecen además 38 códigos de la norma anterior que no están en este
catálogo; se guardan como evidencia con su nombre publicado, pero no se usan para resolver palabras.

### Cómo se interpreta la palabra (`resolveServices`, `packages/shared/src/services/concepts.ts`)

Determinista y sin IA. Mayúsculas y tildes no importan.

| Tipo         | Regla                                                                            | Ejemplo                                               | Se muestra como                |
| ------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------ |
| exacta       | la palabra es el nombre del servicio                                             | fisioterapia → 739                                    | Servicio registrado            |
| catálogo     | alguna palabra es el comienzo del nombre del servicio y las demás aparecen en él | odonto → 334 ODONTOLOGIA GENERAL, 396 ODONTOPEDIATRIA | Servicio registrado            |
| equivalencia | tabla `EQUIVALENCES`, con justificación                                          | fisioterapeuta, terapia física → 739                  | Servicio registrado            |
| relacionado  | tabla `RELATED`                                                                  | rehabilitación → 327, 728, 729, 739, 740              | Actividad relacionada (aparte) |

- "clínica" u "odontológica" no resuelven a ningún servicio: en el catálogo solo son calificativos
  ("ONCOLOGIA CLINICA", "RADIOLOGIA ODONTOLOGICA"). Se buscan solo en los nombres.
- Una palabra que no corresponde al catálogo ("insumos") no consulta fuentes de servicios ni se
  convierte en "todas las IPS".
- Las equivalencias son de profesión a servicio (Ley 528 de 1999 para fisioterapia, Ley 949 de 2005
  terapia ocupacional, Ley 376 de 1997 fonoaudiología, etc.) y "terapia física" como denominación
  internacional de la fisioterapia. Lo relacionado nunca se presenta como confirmación.

## 2. Relación sede → servicio: qué existe y qué no

**No hay una publicación nacional abierta.** La relación oficial completa está en el portal REPS
de MinSalud (`https://prestadores.minsalud.gov.co/habilitacion/`), que exige iniciar sesión (como
invitado, con credenciales publicadas en la propia página) en una aplicación ASP.NET sin API ni
descarga documentada. No se automatiza: es autenticación, y la decisión de usarla corresponde al
responsable del proyecto (se consultó y se eligió trabajar con datos abiertos).

En datos.gov.co solo hay publicaciones territoriales con esa estructura:

| Conjunto                                 | Publicador            | Cobertura                                                                                              | Corte / actualización                      | Uso                                                                    |
| ---------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| `j93s-yemu`                              | MinSalud              | Cundinamarca, todos los prestadores (11 422 relaciones sede–servicio de 3 059 códigos de habilitación) | corte REPS 2022-06-29                      | **Integrado**                                                          |
| `p9n2-9qsb`                              | Gobernación de Boyacá | Red pública (ESE) de Boyacá (1 859 relaciones)                                                         | actualizado 2023-06-28, sin fecha de corte | **Integrado**                                                          |
| `7r2w-27jm`                              | Alcaldía de Buga      | Buga (2026-04-16)                                                                                      | —                                          | No integrado: sin número de sede, no se identifica la sede con certeza |
| `75ek-hmgy`, `9g6h-b4r7`, `d5bp-hqv5`, … | Valle, ESE            | Solo oncología o una entidad                                                                           | 2020–2023                                  | No integrados                                                          |

**Antioquia y el resto de departamentos no tienen fuente abierta de servicios.** El buscador lo dice
en cada búsqueda ("No hay una fuente abierta con los servicios habilitados por sede para…").

### Campos usados (`apps/api/src/modules/discovery/adapters/reps-services.ts`)

| Dato                | `j93s-yemu`                                                                               | `p9n2-9qsb`                                 |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| Código de sede REPS | `codigo_habilitacion` + `numero_sede` (2 dígitos)                                         | `codigo_habilitacion` + `num_sede`          |
| Servicio            | `serv_codigo`, `serv_nombre`                                                              | `codigo_servicio`, `servicio`               |
| Estado              | `habilitado` (todas las filas: SI)                                                        | no publica                                  |
| Modalidad           | `ambulatorio`, `hospitalario`, `unidad_movil`, `domiciliario`, `otras_extramural` (SI/NO) | ídem                                        |
| Naturaleza          | `clase_persona` (NATURAL / JURIDICO)                                                      | no publica                                  |
| Corte               | `fecha_corte_reps`                                                                        | no publica (se muestra la fecha del portal) |

Consulta: `serv_codigo in (739)` (columnas numéricas), paginada por `:id`, con verificación de
columnas, conteo previo y exigencia de leer lo anunciado. Licencia CC BY-SA 4.0 en ambos.

### Cruce con el REPS nacional

La relación se cruza con las sedes del REPS actual (`c36g-9fc2`, corte 2026-03-12) por código de
sede, nunca por nombre. Verificado el 2026-11-13 para FISIOTERAPIA (739):

|                                          | Cundinamarca 2022                                           | Boyacá 2023 |
| ---------------------------------------- | ----------------------------------------------------------- | ----------- |
| Sedes con el servicio en la fuente       | 309                                                         | 36          |
| Existen hoy en REPS                      | 222 (177 IPS, 26 profesionales, 19 objeto social diferente) | 36          |
| Ya no figuran en REPS (no se incorporan) | 87                                                          | 0           |

Solo se usa una sede que existe hoy en REPS **y** está en el lugar buscado; las demás se cuentan
como "fuera del lugar" o "ya no figuran en el REPS actual" (consulta por código a REPS).

## 3. Profesionales independientes

El REPS publica cuatro clases; el buscador consulta todas:

| Clase (`claseprestador`)                                      | Tipo de actividad (`company_type`) |
| ------------------------------------------------------------- | ---------------------------------- |
| Instituciones Prestadoras de Servicios de Salud - IPS         | `ips`                              |
| Profesional Independiente                                     | `profesional_independiente`        |
| Objeto Social Diferente a la Prestación de Servicios de Salud | `otro`                             |
| Transporte Especial de Pacientes                              | `otro`                             |

- Identificación: `identification_type` + `identification_number` tal como los publica REPS (CC,
  CE, PT, NI). `nit` solo se rellena si el tipo es NI. Un profesional con varias sedes es una sola
  entidad (índice único por tipo y número). Nunca se fusiona por nombre, teléfono ni dirección.
- La clase publicada se guarda en `provider_class`. La naturaleza (`person_kind`) solo se guarda si
  una fuente la declara (`clase_persona`); no se deduce del NIT.
- La interfaz no muestra la cédula de un profesional; solo un NIT aparece como tal.
- En Antioquia el REPS tiene 14 056 sedes de 10 566 profesionales independientes; sin fuente de
  servicios, solo aparecen si su nombre contiene las palabras.

## 4. Modelo de evidencia

| Tabla                | Qué guarda                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site_services`      | servicio de una sede según una fuente: código, nombre publicado, estado, modalidades, corte, URL del registro y original (`source_records`). Una fila por sede, fuente y código; una observación con corte anterior **no** sustituye a una más reciente |
| `search_run_matches` | por qué una ejecución encontró una entidad: `service` (exacto, catálogo o equivalencia), `related` o `name`, con fuente, sede, original y código. Una entidad aparece una vez en los resultados y conserva todas sus evidencias, de todas las fuentes   |
| `search_run_results` | (sin cambios) entidades y sedes de cada ejecución                                                                                                                                                                                                       |

Migración `0004_services_and_providers` (aditiva): tablas anteriores, columnas de identificación,
clase y naturaleza en `companies`, valor `profesional_independiente` en `company_type`, y
actualización determinista de los datos existentes (identificación NI para quien tenía NIT; clase
desde el original REPS; coincidencias de nombre para las búsquedas v2 anteriores).

## 5. Ejecución

1. Se leen todas las sedes del lugar en REPS (todas las clases) y, si la palabra resolvió servicios y
   hay fuente para el departamento, la fuente de servicios.
2. Entra lo que tiene evidencia: servicio, relacionado o nombre. Todo se incorpora y la ejecución se
   cierra en una sola transacción (igual que antes).
3. Fallos: si REPS falla, la búsqueda falla. Si una fuente de servicios falla, se reintenta toda la
   búsqueda mientras queden intentos; en el último se continúa sin ella y la ejecución queda
   `partial`, con la fuente marcada como fallida y su error; lo confirmado por nombre sí se incorpora.

## 6. Resultado real antes / después (2026-11-13, base de desarrollo)

| Búsqueda                             | Antes (solo nombre, solo IPS)                 | Ahora                                                                                                                                               |
| ------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| "fisioterapia", Antioquia            | 2 199 sedes leídas, 2 coincidencias de nombre | 16 822 sedes leídas (todas las clases), 4 coincidencias de nombre; aviso de que no hay fuente de servicios para Antioquia                           |
| "fisioterapia", Cundinamarca         | —                                             | 181 prestadores: 179 por servicio registrado (**ninguno con "fisioterapia" en el nombre**: 142 IPS, 26 profesionales, 13 otros) + 2 solo por nombre |
| "fisioterapeuta", Cundinamarca       | —                                             | los mismos 179 por equivalencia, ya existentes                                                                                                      |
| "rehabilitación", Cundinamarca       | —                                             | 50 por servicio (346, 347), 260 relacionados, 14 por nombre                                                                                         |
| "fisioterapia", Boyacá               | —                                             | 29 prestadores (36 sedes) de la red pública por servicio                                                                                            |
| Repetir "fisioterapia", Cundinamarca | —                                             | 0 nuevas, tablas idénticas                                                                                                                          |

La prueba de aceptación en Antioquia **no se cumple con datos abiertos**: la relación sede →
servicio de Antioquia no se publica de forma abierta.

## 7. Fuentes adicionales no integradas

- **Actividad anunciada en sitios web propios**: REPS no publica sitio web (no se deriva del correo),
  así que no hay semillas oficiales para rastrear. Queda pendiente.
- **APIs de búsqueda web o de negocios** (Google Programmable Search, Google Places u otras): exigen
  credenciales, tienen costo por consulta y condiciones que limitan almacenar resultados. No se
  integraron ni se configuraron; requieren decisión, presupuesto y revisión de condiciones antes de
  usarse. El buscador no las anuncia.
- **INVIMA**: ver `invima.md` (sin contactos ni ubicación codificada).

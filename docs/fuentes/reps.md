# Fuente: REPS en datos.gov.co

Validación realizada el **2026-11-13** contra las respuestas reales del portal. Las cifras de este
documento son agregados; no se guardan aquí nombres ni contactos.

## Conjunto de datos

|                                                  |                                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Nombre                                           | Registro Especial de Prestadores y Sedes de Servicios de Salud                                                        |
| Publicador                                       | Ministerio de Salud y Protección Social (MinSalud), usuario `Minsalud`, procedencia `official`                        |
| Identificador                                    | `c36g-9fc2`                                                                                                           |
| Página                                           | https://www.datos.gov.co/Salud-y-Protecci-n-Social/Registro-Especial-de-Prestadores-y-Sedes-de-Servic/c36g-9fc2       |
| API (Socrata SODA 2.0)                           | `https://www.datos.gov.co/resource/c36g-9fc2.json`                                                                    |
| Metadatos                                        | `https://www.datos.gov.co/api/views/c36g-9fc2.json`                                                                   |
| Licencia                                         | Creative Commons Attribution-ShareAlike 4.0 (`CC_40_BY_SA`), https://creativecommons.org/licenses/by-sa/4.0/legalcode |
| Frecuencia declarada                             | Anual; cobertura nacional                                                                                             |
| Publicado                                        | 2023-07-04                                                                                                            |
| Última actualización de filas (`rowsUpdatedAt`)  | **2026-04-17**                                                                                                        |
| Fecha de corte de los datos (`fecha_corte_reps`) | **"Fecha corte REPS: Mar 12 2026 3:11PM"** (un único valor en las 76 821 filas)                                       |

Consecuencia: es una **foto periódica** del REPS. No confirma que una habilitación siga vigente
hoy. La interfaz lo dice junto al resultado y en cada ficha.

## Campos y uso

Una fila = una **sede** de un prestador. Los 22 campos y su tipo (según los metadatos):

| Campo                                                                        | Tipo   | Nulos     | Uso en icmSpy                                                            |
| ---------------------------------------------------------------------------- | ------ | --------- | ------------------------------------------------------------------------ |
| `codigoprestador`                                                            | text   | 0         | `company_sites.provider_code`; identidad de respaldo sin NIT             |
| `nombreprestador`                                                            | text   | 0         | `companies.legal_name`                                                   |
| `codigohabilitacionsede`                                                     | text   | 0         | identidad de la sede (`company_sites.external_id`) y orden de paginación |
| `nombresede`                                                                 | text   | 0         | `company_sites.name`                                                     |
| `tipoid`                                                                     | text   | 0         | solo si es `NI` se trata la identificación como NIT                      |
| `numeroidentificacion`                                                       | number | 0         | NIT normalizado (`companies.nit`)                                        |
| `naturalezajuridica`, `ese`                                                  | text   | 0         | solo en el original                                                      |
| `municipio_prestador`, `municipioprestadordesc`, `departamentoprestadordesc` | text   | 0         | ciudad/departamento de la empresa (solo si están vacíos)                 |
| `direccionprestador`                                                         | text   | 2         | solo en el original                                                      |
| `email_prestador`, `telefonoprestador`                                       | text   | 6 / 70    | contactos de la empresa                                                  |
| `municipiosede`, `municipiosededesc`, `departamentodededesc`                 | text   | 0         | municipio de la sede y filtro de departamento                            |
| `direcci_nsede`                                                              | text   | 41        | dirección de la sede                                                     |
| `email_sede`, `t_lefonosede`                                                 | text   | 20 / 1076 | contactos de la sede                                                     |
| `claseprestador`                                                             | text   | 0         | filtro de clase                                                          |
| `fecha_corte_reps`                                                           | text   | 0         | fecha de corte                                                           |

Notas verificadas:

- **No hay sitio web** en ningún campo (0 de 233 filas de Quindío contienen `www.` o `http`). No se
  deriva del dominio del correo.
- **No hay dígito de verificación**: `numeroidentificacion` es el NIT sin DV.
- **No hay estado de habilitación, vigencia ni fecha de cierre** por fila. Solo la fecha de corte.
- `codigoprestador` **es por departamento**: el mismo NIT puede tener varios (uno tenía 18 códigos
  en 17 departamentos). Por eso la empresa se identifica por NIT, no por ese código.
- `codigohabilitacionsede` es **único en todo el conjunto** (consulta de duplicados vacía).
- Correos y teléfonos son texto libre: a veces varios valores por campo (`, `, `-`, `/`, dobles
  espacios), extensiones (`Ext. 101`) y fijos de 7 dígitos con el formato anterior al plan de
  marcación de 2021.

## Clases de prestador (todo el país)

| `claseprestador`                                              | Filas  |
| ------------------------------------------------------------- | ------ |
| Instituciones Prestadoras de Servicios de Salud - IPS         | 19 551 |
| Profesional Independiente                                     | 54 657 |
| Objeto Social Diferente a la Prestación de Servicios de Salud | 2 107  |
| Transporte Especial de Pacientes                              | 506    |

Se usa solo la clase **IPS**. "Clínica" no es una clase: es parte del nombre de algunas IPS (28 de
las 233 sedes de Quindío lo llevan en el nombre del prestador o de la sede); no se filtra por nombre.
Las 19 551 filas IPS del país tienen `tipoid = NI`.

## Quindío

Se identifica por el prefijo DANE **63** del municipio de la sede (`starts_with(municipiosede,
'63')`). Da el mismo resultado que `departamentodededesc = 'Quindío'` (1 241 filas, todas las
clases), pero no depende de tildes ni de cómo se escriba el nombre. En Quindío no hay sedes cuyo
prestador esté registrado en otro departamento ni al revés (ambas consultas devuelven 0).

| Medida (IPS en Quindío)                             | Valor                                      |
| --------------------------------------------------- | ------------------------------------------ |
| Sedes (filas)                                       | **233**                                    |
| Prestadores (`codigoprestador` distintos)           | 170                                        |
| NIT distintos                                       | 170                                        |
| Naturaleza                                          | 202 privadas, 31 públicas (las 31 son ESE) |
| NIT con sedes en más de un municipio                | 3                                          |
| Empresas con más de una sede                        | 29 (máximo 9 sedes)                        |
| Sedes con correo de sede distinto del del prestador | 70                                         |

Sedes por municipio: Armenia 200, Calarcá 11, La Tebaida 4, Montenegro 4, Circasia 3, Filandia 3,
Quimbaya 2, Salento 2, Buenavista 1, Córdoba 1, Génova 1, Pijao 1.

## Consultas reproducibles

```bash
B=https://www.datos.gov.co/resource/c36g-9fc2.json
W="starts_with(municipiosede,'63') AND claseprestador='Instituciones Prestadoras de Servicios de Salud - IPS'"

# Conteo de sedes IPS en Quindío
curl -G "$B" --data-urlencode '$select=count(*)' --data-urlencode "\$where=$W"
# Clases de prestador y fecha de corte
curl -G "$B" --data-urlencode '$select=claseprestador,count(*)' --data-urlencode '$group=claseprestador'
curl -G "$B" --data-urlencode '$select=fecha_corte_reps,count(*)' --data-urlencode '$group=fecha_corte_reps'
# Unicidad del código de sede (debe devolver [])
curl -G "$B" --data-urlencode '$select=codigohabilitacionsede,count(*) as n' \
  --data-urlencode '$group=codigohabilitacionsede' --data-urlencode '$having=n>1'
# Un registro concreto (así se arma la URL de procedencia)
curl "$B?codigohabilitacionsede=<código de sede>"
```

En Git Bash para Windows, un literal con tilde (`'Quindío'`) pasado por la línea de comandos llegó
mal codificado y la igualdad devolvió 0; con `%C3%AD` en la URL devuelve 1 241. Otra razón para
filtrar por código DANE.

## Paginación y límites

- `$limit` / `$offset` con `$order=codigohabilitacionsede` (único → orden estable).
- Páginas de 1 000 filas; Quindío cabe en una.
- Sin token de aplicación el portal aplica límites de tasa por IP; no fueron un problema con este
  volumen. Si hiciera falta, Socrata acepta la cabecera `X-App-Token`.
- El adaptador pide primero los metadatos (verifica que las 22 columnas existan con su tipo), luego
  el conteo, luego las páginas; al final exige que lo leído coincida con el conteo.

## Uso en el buscador de empresas

- Consulta en la API: `(starts_with(municipiosede, 'DD'))` o `(municipiosede = 'MMMMM')` y
  `claseprestador = 'Instituciones Prestadoras de Servicios de Salud - IPS'`, paginada por
  `codigohabilitacionsede`. El filtro geográfico es por la **sede**: una empresa domiciliada en otro
  lugar aparece si tiene una sede en el lugar buscado, y la ciudad de la empresa no se cambia.
- La palabra clave se aplica en el worker a `nombreprestador` y `nombresede` (SoQL no ignora
  tildes). Se leen todas las páginas del filtro geográfico; `recordsRead` = leídos,
  `recordsMatched` = con la palabra clave, `recordsNotMatching` = el resto.
- Solo la clase IPS. Profesionales independientes (personas naturales), transporte de pacientes y
  "objeto social diferente" no se incluyen.
- Volumen por departamento observado (clase IPS): Quindío 233 sedes, Risaralda 374, Caquetá 113.

### Búsquedas reales verificadas (2026-11-13, base de desarrollo, API + worker)

| Búsqueda                        | Leídos | Coincidencias (sedes)       | Empresas encontradas | Nuevas / ya existentes        |
| ------------------------------- | ------ | --------------------------- | -------------------- | ----------------------------- |
| "clinica" en Quindío            | 233    | 29 (28 Armenia, 1 Circasia) | 23                   | 0 / 23                        |
| "clinica" en Armenia (63001)    | 200    | 28                          | 22                   | 0 / 22                        |
| "odonto" en Quindío             | 233    | 10 (Armenia)                | 6                    | 0 / 6                         |
| "laboratorio" en Quindío        | 233    | 11 (10 Armenia, 1 Calarcá)  | 5                    | 0 / 5                         |
| "odonto" en Risaralda           | 374    | 10                          | 8                    | 7 / 1                         |
| "odonto" en Risaralda, repetida | 374    | 10                          | 8                    | 0 / 8                         |
| "odonto" en Caquetá             | 113    | 3                           | 3                    | 3 / 0                         |
| "fisioterapia" en Quindío       | 233    | 0                           | 0                    | — (terminada, sin resultados) |

Los conteos de Quindío y Risaralda coinciden con los calculados antes, aplicando la misma función
`matchesKeyword` a la descarga directa de REPS. Los teléfonos fijos encontrados en Risaralda quedan con
`+57606` y los de Caquetá con `+57608`. Tras todas las búsquedas: 0 empresas, sedes o contactos
duplicados, 0 contactos sin procedencia, 0 resultados fuera del lugar buscado.

## Mapeo de contactos

- Teléfonos: se separan los valores (`,` `;` `/` `|`, `-`, `y`, `o`, dos o más espacios,
  etiquetas `fijo`/`tel`/`teléfono`/`cel`/`celular`/`móvil`), se quita la extensión para
  normalizar y se pasan a E.164. Formatos aceptados: celular `3XXXXXXXXX`, fijo `60XXXXXXXX`,
  fijo antiguo con indicativo (`(6) 7XXXXXX`, `57 6 7XXXXXX`), fijo de 7 dígitos **solo cuando
  se conoce el departamento** y larga distancia anterior a 2021 con operador 9 (`(096) 7XXXXXX`,
  `96 7XXXXXX`), ver la revisión de abajo. El valor mostrado es el fragmento original;
  `valueNormalized` es la forma canónica.
- Indicativo por departamento (`apps/api/src/modules/enrichment/phone-areas.ts`), según la tabla
  oficial de la CRC (SIGRID, https://www.pnn.gov.co/mapa/atribuciones/numeracionE164.xhtml,
  consultada el 2026-11-13): 601 Bogotá D.C. y Cundinamarca; 602 Cauca, Nariño y Valle; 604
  Antioquia, Córdoba y Chocó; 605 Atlántico, Bolívar, Cesar, La Guajira, Magdalena y Sucre; 606
  Caldas, Quindío y Risaralda; 607 Arauca, Norte de Santander y Santander; 608 Amazonas, Boyacá,
  Casanare, Caquetá, Guaviare, Guainía, Huila, Meta, Tolima, Putumayo, San Andrés, Vaupés y Vichada.
  Un `(096)` solo se interpreta donde el indicativo es 6.
- El indicativo se toma de la ubicación que corresponde al campo: municipio de la **sede** para
  `t_lefonosede` y municipio del **prestador** para `telefonoprestador`.
- Lo que no se puede interpretar con certeza se cuenta como "no interpretado" y solo queda en el
  registro original.
- Correos: se separan, se normalizan a minúsculas y quedan con estado `unknown`. Que estén en REPS
  no los hace válidos; no se verifican MX ni SMTP.

## Revisión de contactos no interpretados (2026-11-13)

Punto de partida comprobado en la base de desarrollo (PostgreSQL 16): 170 empresas, 233 sedes, 522
contactos, 233 originales (uno por sede), 1 585 filas de procedencia, lista de supresión vacía. Las
dos últimas búsquedas completadas registraban `contactsDiscarded = 33`.

Método: se volvió a aplicar el mismo mapeo (`parseRepsRow` + `resolveRepsRow`) a los 233 payloads
guardados en `source_records`, sin modificarlos. Resultado: exactamente **33 ocurrencias**
descartadas (32 de teléfono, 1 de correo) en 26 sedes. `contactsDiscarded` cuenta ocurrencias, no
valores: un mismo número aparece en varias sedes o en el campo de la sede y el del prestador
(p. ej. un `96…` repetido en 6 registros de la misma empresa).

### Categorías observadas

Ejemplos con la misma estructura y dígitos ficticios.

| Patrón                                                         | Ocurrencias | Decisión               |
| -------------------------------------------------------------- | ----------- | ---------------------- |
| `96` + 7 dígitos que empiezan por 7 (`967000001`)              | 18          | Recuperado             |
| `96` + 7 dígitos que empiezan por 1 (`961000001`)              | 1           | Sigue descartado       |
| `(096) 7000001`, `(096)7000001`                                | 2           | Recuperado             |
| `0967-0000000` (8 dígitos tras `096`)                          | 1           | Sigue descartado       |
| `(036) 7000001`                                                | 1           | Sigue descartado       |
| Etiquetas: `fijo 606 7000001 Cel 3000000001`                   | 1           | Recuperado (2 números) |
| Fijo con guiones + celular con un solo espacio: `700-00-01 3…` | 1           | Recuperado (2 números) |
| Alternativas: `7000-001 o 7000-002`                            | 1           | Recuperado (2 números) |
| `576 3000000001` (prefijo de 3 dígitos + celular)              | 1           | Sigue descartado       |
| 6 dígitos (`700000`)                                           | 2           | Siguen descartados     |
| `1800` + 7 dígitos (11 dígitos)                                | 2           | Siguen descartados     |
| Celular con un dígito de más (11 dígitos)                      | 1           | Sigue descartado       |
| Correo: fragmento suelto `m` tras `…@gmail.co`                 | 1           | Sigue descartado       |

### Reglas añadidas (`apps/api/src/modules/enrichment/normalize.ts`)

1. **Larga distancia anterior a 2021 con código de operador.** Hasta 2021 un fijo de otra región
   se marcaba `0 + código de operador + indicativo + número`; la marcación única nacional eliminó
   "el prefijo 0 y el código del operador" (con "9 para Telefónica") y hoy se marca "60 + número
   que identifica la región + el número de siempre":
   [comunicado CRC, 24-ago-2021](https://www.crcom.gov.co/es/noticias/comunicado-prensa/desde-1-septiembre-cambia-forma-hacer-llamadas-en-colombia),
   [comunicado CRC, 30-nov-2021](https://www.crcom.gov.co/es/noticias/comunicado-prensa/inicia-implementacion-definitiva-nuevo-esquema-numeracion-y-marcacion).
   La Resolución CRC 5050, art. 6.2.1.1
   ([compilación MinTIC](https://normograma.mintic.gov.co/mintic/compilacion/docs/resolucion_crc_5968_2020.htm)),
   fija que los últimos 7 dígitos son el número de suscriptor y atribuye los NDC 600–699 a la
   numeración fija geográfica. Así, `[0]9 6 7XXXXXX` → `+57 606 7XXXXXX`.
   Condiciones para aplicarla, todas obligatorias:
   - operador `9`, el único observado (5 y 7 también figuran en el comunicado, pero no aparecen en
     los datos y no se añadieron);
   - el indicativo escrito (`6`) coincide con el de la ubicación del campo (Quindío → 6);
   - el número de suscriptor tiene 7 dígitos y empieza por 2–8.

   Por qué aplica a Quindío: los comunicados no traen en texto la tabla de indicativos (es una
   imagen), pero en el propio REPS 19 de los 21 fijos que los prestadores de Quindío ya escriben en
   formato vigente usan `606` (los otros dos son números de otras regiones), y los 98 fijos `+57606`
   ya incorporados tienen suscriptores que empiezan por 7, 3 o 6, nunca por 1. Además, en 2 de los
   valores recuperados la misma empresa ya publicaba ese número en formato vigente en otro campo
   (7 ocurrencias), lo que confirma la lectura.
2. **Separadores adicionales:** `o` entre números y etiquetas inequívocas de teléfono. La
   etiqueta no forma parte del valor guardado.
3. **Separar primero por espacios y luego por guiones**, para que un fijo escrito `700-00-01`
   no se parta al ir seguido de un celular. Solo se separa si cada parte tiene al menos 7 dígitos.

### Casos que siguen sin interpretarse

- `96 1XXXXXX`: ningún suscriptor `+57606` observado empieza por 1; no se puede afirmar que sea un fijo.
- `0967-XXXXXXX` (8 dígitos tras `096`) y celular de 11 dígitos: sobra un dígito y no se sabe cuál.
- `(036) 7XXXXXX`: `03` era el prefijo para llamar de fijo a celular, no un código de operador.
- `576 3XXXXXXXXX`: el celular es plausible, pero el prefijo `576` no corresponde a ninguna
  marcación; no se descarta un dígito arbitrario.
- 6 dígitos: incompletos.
- `1800XXXXXXX`: no es un fijo ni un celular; las líneas gratuitas usan otro formato y no se adivina.
- Correo `…@gmail.co  m`: el parser incorporó `…@gmail.co` y descartó la `m`. Probablemente
  quisieron escribir `.com`, pero unir fragmentos sería adivinar el dominio. **El contacto
  `…@gmail.co` ya incorporado es dudoso y conviene revisarlo a mano**; no se modificó.

### Antes y después (mismos 233 payloads)

| Medida                                                       | Antes | Después |
| ------------------------------------------------------------ | ----- | ------- |
| Ocurrencias no interpretadas                                 | 33    | 10      |
| Ocurrencias interpretadas                                    | 1 119 | 1 145   |
| Parejas registro + campo + valor nuevas                      | —     | 26      |
| Contactos únicos recuperados (empresa + valor)               | —     | 14      |
| … que ya existían en esa empresa (solo se añade procedencia) | —     | 7       |
| … nuevos                                                     | —     | 7       |
| Valores ya incorporados que cambian                          | —     | 0       |
| Omitidos por supresión                                       | 0     | 0       |

Reimportación real por API y worker: la fuente no había cambiado (233 originales sin cambios, mismo
corte). La 1ª búsqueda incorporó 7 contactos (522 → 529), 26 filas de procedencia (1 585 → 1 611),
y quedaron 10 descartes; empresas (170), sedes (233) y originales (233) sin cambios. La 2ª búsqueda
no incorporó nada. Sin contactos sin procedencia ni duplicados.

## Resultado real de la búsqueda (2026-11-13, base local aislada)

| Ejecución                                 | Estado                 | Sedes leídas | Empresas nuevas / existentes | Sedes nuevas / existentes | Contactos nuevos / existentes | No interpretados |
| ----------------------------------------- | ---------------------- | ------------ | ---------------------------- | ------------------------- | ----------------------------- | ---------------- |
| 1ª                                        | done                   | 233 de 233   | 170 / 0                      | 233 / 0                   | 519 / 0                       | 36               |
| 2ª (misma versión)                        | done                   | 233          | 0 / 170                      | 0 / 233                   | 0 / 519                       | 36               |
| Con datos.gov.co caído (simulado, 503)    | failed tras 3 intentos | 0            | —                            | —                         | —                             | —                |
| 3ª (separación de teléfonos por espacio)  | done                   | 233          | 0 / 170                      | 0 / 233                   | 3 / 519                       | 33               |
| Base de desarrollo, revisión de descartes | done                   | 233          | 0 / 170                      | 0 / 233                   | 7 / 522                       | 10               |
| Repetición                                | done                   | 233          | 0 / 170                      | 0 / 233                   | 0 / 529                       | 10               |

Tablas tras la 1ª y la 2ª: 170 empresas (todas con NIT), 233 sedes, 519 contactos (237 correos,
282 teléfonos), 233 originales, 1 578 filas de procedencia. Ningún contacto quedó sin procedencia.

## Limitaciones

- Actualización anual: el corte vigente es de marzo de 2026.
- Sin sitio web, sin estado de habilitación por sede y sin DV.
- El nombre de la empresa es el del prestador en REPS; si otra fuente ya la había creado, no se
  reemplaza.
- Si cambia la estructura (columnas, tipos o filas inválidas), la búsqueda falla y no incorpora
  nada: hay que revisar el mapeo antes de volver a importar.

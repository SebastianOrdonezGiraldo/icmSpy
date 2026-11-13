# Catálogo geográfico: DIVIPOLA (DANE)

El buscador valida departamento y municipio contra la División Político-Administrativa de Colombia
(DIVIPOLA) del DANE, incluida en el código (`packages/shared/src/geo/divipola.ts`): la interfaz arma
los selectores con ella y la API rechaza códigos inexistentes o un municipio de otro departamento
antes de consultar cualquier fuente. No depende de las empresas ya importadas.

|                               |                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Conjunto                      | "DIVIPOLA - Códigos municipios", DANE                                                                                                           |
| Identificador                 | `gdxc-w37w` en datos.gov.co (https://www.datos.gov.co/d/gdxc-w37w)                                                                              |
| Última actualización de filas | 2025-01-24                                                                                                                                      |
| Descargado                    | 2026-11-13                                                                                                                                      |
| Contenido                     | 33 departamentos (incluido `11` BOGOTÁ, D.C. con el municipio `11001`) y 1 122 entradas: 1 103 municipios, 18 áreas no municipalizadas y 1 isla |
| Códigos                       | departamento de 2 dígitos; municipio de 5 dígitos que empieza por el del departamento (verificado en las 1 122 filas)                           |

Regenerar: descargar
`https://www.datos.gov.co/resource/gdxc-w37w.json?$select=cod_dpto,dpto,cod_mpio,nom_mpio,tipo_municipio&$order=cod_mpio&$limit=5000`
y volver a escribir el archivo con la misma estructura (departamentos ordenados por código y sus
municipios `[código, nombre]`).

Diferencias observadas con REPS (2026-11-13): REPS usa el código `27086` (Belén de Bajirá, Chocó;
5 sedes) que no figura en esta versión de DIVIPOLA. Esas sedes aparecen al buscar en todo el
departamento de Chocó, pero no se pueden elegir como municipio. No se añadió el código a mano.

Los nombres de municipio no son únicos: 67 se repiten en varios departamentos (por ejemplo, ARMENIA
existe en Quindío y en Antioquia). Por eso el sistema trabaja con códigos, y una fuente que solo
publique el nombre de la ciudad no se puede filtrar por departamento con fiabilidad.

# Fuente candidata: INVIMA (no integrada)

Revisión del 2026-11-13 para el buscador de empresas. **Conclusión: no se integra todavía.** El
buscador consulta solo REPS y la interfaz lo dice junto a los resultados.

## Conjuntos revisados (datos.gov.co, publicados por INVIMA)

| Id                                    | Conjunto                                                                                        | Actualización        | Columnas                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `s3n2-sqjp`                           | Establecimientos importadores certificados en CCAA de dispositivos médicos y equipos biomédicos | 2026-06-24 (mensual) | `establecimiento`, `nit`, `ciudadmunicipio`, `concepto`, `fechaconcepto`                                     |
| `y4qt-w6tk`                           | Registros sanitarios de dispositivos médicos y otras tecnologías                                | 2026-10-16           | registro, producto, marca, `titular`, `ciudad_titular`, `pais_titular`, `rol`, `nombre_rol`, `ciudad_rol`, … |
| `vwzb-x42y`, `f25x-wa6y`, `26xy-v7p6` | Establecimientos fabricantes / reactivos in vitro                                               | 2026-09-09           | `establecimiento`, `nit`, `ciudadmunicipio`, …                                                               |

`s3n2-sqjp` es el más cercano a "importadores de dispositivos médicos": 1 714 registros, 1 579 NIT
distintos; conceptos CERTIFICADO (1 166), RECERTIFICADO (448) y CERTIFICADO VIGENTE EN TRÁMITE DE
RECERTIFICACIÓN (100). Licencia CC BY-SA 4.0.

## Por qué no se integra

1. **Sin contactos.** Ninguno de estos conjuntos publica teléfono, correo, dirección ni sitio web.
   El buscador debe entregar empresas con contactos; INVIMA solo aportaría nombre y NIT.
2. **Ubicación sin código.** Solo trae el nombre de la ciudad en texto (`ciudadmunicipio`, sin
   departamento ni código DANE). 67 nombres de municipio se repiten entre departamentos (ver
   `divipola.md`); por ejemplo, los 4 registros con "ARMENIA" no se pueden asignar con certeza a
   Quindío o a Antioquia. Filtrar por departamento sería adivinar.
3. **Significado.** La certificación CCAA acredita capacidad de almacenamiento o acondicionamiento
   para importar; no convierte a un titular en distribuidor ni dice a quién vende. El registro
   sanitario (`y4qt-w6tk`) es por producto y mezcla roles (titular, importador, fabricante).

## Qué haría falta

Una tabla de correspondencia ciudad → código DANE que solo acepte nombres únicos (o una fuente que
publique el código), y otra fuente de contactos (sitio web propio de la empresa). Hasta entonces el
adaptador `invima` sigue marcado como no operativo y el buscador no lo consulta ni lo anuncia.

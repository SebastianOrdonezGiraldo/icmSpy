# Investigación de extracción de Instagram sin sesión

Fecha: 15 de noviembre de 2026. Uso previsto: prospección interna de ICM desde icmSpy.

## Resultado

Se comprobó que un servicio externo puede devolver una muestra de seguidores desde una URL sin conectar una cuenta de Instagram. OwlGlance entregó y permitió exportar **41 filas distintas** para su ejemplo público `natgeo` durante esta investigación.

No se validó una alternativa que reúna todo el objetivo: obtener 100–300 seguidores, enriquecerlos con sus correos y teléfonos públicos, ejecutarse automáticamente desde icmSpy, funcionar sin sesión de Instagram y mantenerse gratis sin depender de pruebas o créditos de un proveedor comercial. Esto delimita lo demostrado; no prueba que tal alternativa sea técnicamente imposible.

Las opciones gratuitas verificables se dividen en muestras web limitadas y crédito de evaluación de servicios comerciales. El código abierto revisado no aportó un reemplazo completo comprobado para ese recorrido sin sesión.

La investigación no inició sesión en Instagram, no cargó sesiones del piloto y no utilizó credenciales personales. No creó cuentas, compró servicios ni solicitó pruebas a soporte. No modificó el piloto, REPS o las bases de datos del proyecto.

## Requisitos utilizados para evaluar las opciones

1. Entrada por URL de un perfil público, sin subir archivos de seguidores.
2. Lista de identidades de seguidores, no solamente el contador o las publicaciones.
3. Contactos publicados por cada perfil o su negocio, con procedencia verificable.
4. Ninguna contraseña, sesión o cookie de Instagram proporcionada por ICM.
5. Distinguir una cuota gratuita recurrente, una muestra única y software local sin cobro por consulta.
6. Acceso automatizable documentado y compatible con las condiciones del servicio.

No pedir una contraseña al visitante no demuestra que el servicio obtenga los datos sin autenticación propia. La ausencia de credenciales de ICM y el funcionamiento interno del proveedor son propiedades distintas.

## Comprobaciones realizadas

### OwlGlance

Se abrió su herramienta de exportación y se introdujo `https://www.instagram.com/natgeo/`, el ejemplo mencionado por la propia página. No se conectó Instagram ni se creó una cuenta del servicio.

El sitio mostró una lista de seguidores y permitió descargar `natgeo_followers.csv`. Se leyó el archivo local y se comprobaron:

| Medida                           | Resultado observado                                           |
| -------------------------------- | ------------------------------------------------------------- |
| Filas de datos                   | 41                                                            |
| Usuarios distintos               | 41                                                            |
| Columnas                         | `username`, `full_name`, `profile_url`, `verified`, `private` |
| Correos en el esquema            | No                                                            |
| Teléfonos en el esquema          | No                                                            |
| Consumo indicado por la interfaz | Pasó de 3 a 2 consultas gratuitas restantes                   |

Esto demuestra la entrega y exportación de la muestra por ese servicio. No se contrastó cada relación de seguimiento contra Instagram ni se acreditó la actualidad o integridad de la lista.

La documentación vigente limita el plan gratuito a 50 cuentas por lista y tres consultas diarias. Una muestra devuelta puede ser menor que ese máximo. [Herramienta de exportación de OwlGlance](https://owlglance.com/instagram-follower-export).

Además, sus condiciones restringen la recopilación masiva, la construcción de perfiles y la elusión de límites. Por esa razón no se propone convertir su interfaz en una API interna de icmSpy ni automatizar consultas de enriquecimiento sobre ella. [Condiciones de OwlGlance, sección de uso aceptable](https://owlglance.com/terms-of-use).

Evidencia local, fuera del repositorio:

- [CSV recibido](C:/Users/sebas/Downloads/natgeo_followers.csv).
- [Captura de la lista](C:/Users/sebas/.codex/tmp/instagram-research-2026-11-15/owlglance.jpg).

### IG Follower Exporter

La interfaz mostró una asignación gratuita de **20 créditos de exportación, hasta 200 filas**. Al consultar `natgeo`, resolvió el perfil, mostró una estimación de 500 créditos para hasta 5.000 filas y dejó la exportación bloqueada hasta completar una verificación humana. No se completó esa verificación ni se obtuvo un CSV de este servicio.

La página y algunos resultados indexados mostraban asignaciones distintas; para este informe prevalece lo observado en el navegador. No se da por demostrado que la asignación gratuita permita recortar cualquier cuenta grande a 200 filas con el flujo probado. La lista de campos publicada tampoco promete correos y teléfonos. [IG Follower Exporter](https://igfollowerexporter.com/).

Sus condiciones identifican **SocialCrawl** como proveedor de datos y Cloudflare Turnstile como verificador. Este es un caso documentado de una interfaz que recibe solo una URL y delega la obtención a otra infraestructura. [Condiciones de IG Follower Exporter, servicios de terceros](https://igfollowerexporter.com/terms).

[Captura de la comprobación](C:/Users/sebas/.codex/tmp/instagram-research-2026-11-15/igexporter.jpg).

### IG Tracker de ExtensionsFox

Se abrió su herramienta web gratuita. La página mostraba una verificación humana y el botón de búsqueda deshabilitado; no se resolvió el desafío. Su documentación anuncia una vista previa de hasta 100 seguidores y 100 seguidos, con CSV. No se comprobó la entrega de esas filas ni se documenta que esa vista previa incluya correos y teléfonos. [Herramienta gratuita de IG Tracker](https://igtracker.extensionsfox.com/free-tools/instagram-followers-tracker).

Los productos de extracción de email y teléfono que ofrece el mismo desarrollador son herramientas separadas. La página del extractor de email describe una extensión sobre Instagram y restricciones de la cuenta; no debe suponerse que comparte el acceso anónimo de la vista previa web. [Extractor de email de ExtensionsFox](https://igemailscraper.extensionsfox.com/).

### Acceso HTTP directo sin sesión

Como control, se hizo una petición HTTP desde el equipo a `https://www.instagram.com/natgeo/` con una sesión HTTP nueva, sin cookies, sin Authorization y sin reutilizar proxies o autenticación del entorno.

La respuesta fue **302 hacia `/accounts/login/`**, con cuerpo vacío. No se siguió el formulario ni se intentó evitar la restricción. Esta observación describe esa petición y ese entorno; no demuestra que todas las formas de consultar un perfil público fallen siempre, ni que otro proveedor reciba la misma respuesta.

## Opciones que anuncian el recorrido completo con evaluación sin costo

### HarvestMyData

Anuncia extracción de seguidores y sus emails y teléfonos publicados, sin cuenta de Instagram del cliente. Su FAQ ofrece una prueba de hasta 1.000 perfiles solicitándola a soporte. Los trabajos posteriores son de pago. [Servicio y prueba de HarvestMyData](https://harvestmydata.com/).

Su página de obtención de datos declara que trabaja sin iniciar sesión ni recibir credenciales de plataformas. Esa declaración no fue auditada técnicamente. [Descripción de adquisición de HarvestMyData](https://harvestmydata.com/legal).

Es una opción para contrastar una muestra sin gasto y sin Instagram personal. No constituye un motor local gratuito ni se verificó una API pública para incorporarlo automáticamente a icmSpy. La prueba no se solicitó: requiere contactar a un tercero.

### SocialCrawl

Tiene endpoints separados para seguidores y perfiles, autenticados con una clave propia de SocialCrawl. Ofrece 100 créditos de bienvenida **una sola vez**; no son 100 créditos mensuales. [Créditos](https://www.socialcrawl.dev/docs/credits), [precio y carácter único de la asignación](https://www.socialcrawl.dev/pricing).

El endpoint de seguidores documenta páginas por 5 créditos, o hasta 10 en el modo de cobertura combinada, y un tamaño típico de unas 50 filas que puede ser menor. También reconoce limitaciones severas en cuentas verificadas grandes. Eso no permite prometer 100–300 seguidores para cualquier objetivo. [Contrato del endpoint de seguidores](https://www.socialcrawl.dev/platforms/instagram/followers.md).

El perfil cuesta un crédito. La opción `include=contacts` añade la búsqueda de contactos publicados con procedencia; la documentación de Instagram distingue el correo en biografía de los botones de contacto de la aplicación. El esquema de perfil no acredita por sí solo que siempre se entregue un teléfono estructurado. [Contrato del perfil](https://www.socialcrawl.dev/platforms/instagram/profile.md), [búsqueda de contactos](https://www.socialcrawl.dev/docs/find-creator-email.md).

Ejemplo aritmético, sin caché, reintentos ni perfiles privados omitidos:

| Muestra hipotética      | Listado a 50 filas por página | Consulta de cada perfil público |     Total estimado |
| ----------------------- | ----------------------------: | ------------------------------: | -----------------: |
| 100 seguidores públicos |              10 a 20 créditos |                    100 créditos | 110 a 120 créditos |
| 300 seguidores públicos |              30 a 60 créditos |                    300 créditos | 330 a 360 créditos |

Es un escenario de presupuesto, no rendimiento medido ni un máximo garantizado: páginas más pequeñas pueden incrementar el consumo. La cuota inicial puede servir para una muestra menor o una audiencia con perfiles privados omitidos, pero no se debe anunciar que alcanza para enriquecer cien perfiles públicos. No se registró una cuenta ni se ejecutaron llamadas a estos endpoints.

### Apify y Data Slayer

Apify ofrece USD 5 de uso mensual en su plan gratuito, sin tarjeta. Se necesita una cuenta y una clave del proveedor, que son distintas de una cuenta de Instagram. [Plan Free de Apify](https://apify.com/pricing).

El actor de Data Slayer documenta un modo enriquecido que incluye email, teléfono, biografía y web sin recibir login o cookies de Instagram del cliente. Es un actor comunitario; su acceso interno y cobertura no se auditaron. [Descripción del actor](https://apify.com/data-slayer/instagram-followers-scraper---no-login).

La tabla de Free publica USD 12 por mil filas enriquecidas y un evento de inicio de USD 0,0005. Bajo el supuesto de una fila enriquecida por seguidor, el consumo sería USD 1,2005 para 100 o USD 3,6005 para 300, antes de otros eventos aplicables y operaciones posteriores. Hay que confirmar el esquema de cobro y cualquier restricción específica del actor antes de iniciarlo. [Tarifas por evento](https://apify.com/data-slayer/instagram-followers-scraper---no-login/pricing).

Es un candidato para un piloto de desembolso cero dentro del saldo, no software local independiente ni una API ilimitada gratuita. No se ejecutó el actor ni se comprobó la extracción completa de contactos.

Public Signal Labs ofrece otro actor de listado sin credenciales de Instagram del cliente. Su política gratuita admite hasta cinco ejecuciones por mes UTC y solicita hasta 1.000 filas por ejecución, con restricciones y sin continuación. También consume el saldo de Apify y no incorpora los contactos de cada seguidor; por sí solo no resuelve el objetivo. [Capacidades y política gratuita](https://apify.com/publicsignallabs/instagram-followers).

Si «sin APIs de pago» excluye utilizar cuotas gratuitas de cualquier proveedor comercial, las dos alternativas API de esta sección quedan fuera del requisito, aunque el piloto no genere una factura.

## Herramientas que no resuelven el requisito

| Herramienta o categoría                    | Hallazgo                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Instaloader 4.16 y el piloto actual        | Su consulta de seguidores requiere una sesión de Instagram; añadir una interfaz de URL no elimina ese requisito                |
| Whoisit                                    | No solicita subir contraseña o cookies, pero ejecuta las consultas dentro de una pestaña de Instagram ya autenticada           |
| Analizadores de exportaciones de Instagram | Procesan un archivo que el usuario debe obtener previamente; no descubren seguidores desde la URL de un tercero                |
| instascrape de chris-greening              | El ejemplo de `followers` devuelve un contador, y el repositorio está archivado; no prueba enumeración actual de identidades   |
| instagrapi                                 | Su guía de seguidores usa flujos autenticados y API móvil; no se verificó un recorrido completo anónimo que cumpla el objetivo |

Fuentes primarias: [seguidores en Instaloader](https://instaloader.github.io/module/structures.html#instaloader.Profile.get_followers), [modelo de privacidad de Whoisit](https://github.com/itzstebin/Whoisit), [analizador manual de TheMIU](https://github.com/TheMIU/Instagram-Follower-Analyzer), [ejemplo y estado de instascrape](https://github.com/chris-greening/instascrape), [guía de usuarios de instagrapi](https://github.com/subzeroid/instagrapi/blob/master/docs/usage-guide/user.md).

## Decisión para icmSpy

El resultado más fuerte de esta investigación es una enumeración y exportación web anónima confirmada. La extracción anónima completa de contactos sigue sin validarse.

Para mantener estrictamente el requisito de código local, sin sesión de Instagram y sin proveedores comerciales, **no iniciar la integración de producción con una fuente todavía no demostrada**. Conservar del piloto los extractores, normalizadores, procedencia, persistencia y tests útiles; no pedir una cuenta personal para superar la incompatibilidad del origen de datos.

Si se admite un servicio comercial solo dentro de una evaluación de costo cero, el siguiente experimento más directo es el modo enriquecido del actor descrito, con un límite de 100, sin verificación SMTP y un tope remoto de gasto dentro del saldo disponible. Alternativamente, contrastar una muestra completa mediante la prueba de HarvestMyData. Ninguno debe presentarse como una solución propia gratuita permanente.

La aceptación de ese experimento exige: lista de seguidores distinta del contador; número de perfiles públicos analizados y privados omitidos; correos y teléfonos separados por fuente; evidencia de atribución; controles de gasto; y revisión manual de contactos de la muestra. Un resultado con cero teléfonos puede ser correcto, pero debe distinguir datos no publicados de campos no cubiertos por el método.

El enriquecimiento puede seguir siendo local: interpretar biografías y leer webs públicas enlazadas no necesita una API de IA. Eso solo ayuda después de disponer de una fuente válida de seguidores y datos de perfil; no sustituye la enumeración ni autoriza a reutilizar sin condiciones la interfaz de un sitio gratuito.

No se recomienda construir un nuevo módulo alrededor de una etiqueta comercial de «sin login» sin cerrar primero esas comprobaciones.

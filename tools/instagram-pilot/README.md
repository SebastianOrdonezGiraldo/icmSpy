# Piloto local: seguidores de Instagram y contactos publicados

Herramienta interna de ICM para comprobar, en el equipo local, si es viable obtener entre 100 y 300
seguidores de **un perfil público** y recuperar los correos y teléfonos que esos seguidores publican
en su propio perfil (y, opcionalmente, en su sitio web).

No forma parte de la aplicación: no hay interfaz React, rutas, pg-boss ni migraciones, y **no escribe
en las bases de icmSpy** (ni en `companies`, `people`, `contact_points` ni en tablas de REPS).

## Antes de usarlo

- Las Condiciones de uso de Instagram prohíben la recopilación automatizada sin permiso. Usar una
  cuenta para esto puede provocar verificaciones, bloqueos temporales o la suspensión de esa cuenta.
- Los seguidores son personas: nombres, biografías y contactos son datos personales (Ley 1581 de 2012).
  Cualquier uso comercial posterior necesita una base legal y una revisión del responsable de datos.
- El piloto solo mide viabilidad. No envía mensajes, no sigue cuentas, no da "me gusta" y no lee
  contenido privado aunque la sesión pueda verlo.

## Qué hace y qué no

| Hace | No hace |
| --- | --- |
| Lee la lista de seguidores con Instaloader (`get_followers`, misma consulta) | Descargar publicaciones, fotos, videos, historias u otras listas |
| Consulta el perfil de cada seguidor **público** (una consulta por perfil) | Consultar perfiles privados (quedan como fila mínima "omitido") |
| Extrae correos, teléfonos, `mailto:`, `tel:` y enlaces de WhatsApp de la biografía y los enlaces del perfil | Leer "botones de contacto": Instaloader 4.16 no los expone; solo se registra el **nombre** de la clave si aparece |
| Opcional (`--web`): portada + 1 página de contacto de hasta 20 sitios propios | Visitar plataformas de enlaces, redes sociales, acortadores o directorios |
| Guarda todo en SQLite tras cada unidad y permite reanudar | Rotar cuentas, usar proxies, resolver CAPTCHA o eludir límites |
| Se detiene ante 429, checkpoint, sesión inválida, 403, cambio de formato o plazo | Reintentar en bucle |

Reglas de contactos: nada se infiere. No se generan correos a partir de nombres o dominios, no se
asigna +57 por defecto, solo se da formato E.164 cuando el número trae prefijo `+` o viene de un enlace
de WhatsApp, y los números sin país quedan como `ambiguous_no_country`. Fechas, NIT, cédulas, montos,
porcentajes y rangos de años se descartan (se cuentan por motivo). No se clasifica a nadie como
paciente, profesional o comprador.

## Instalación (una vez)

PowerShell, desde la raíz del repositorio:

```powershell
cd tools\instagram-pilot
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

Instalar, importar y ejecutar las pruebas no consulta Instagram.

## Pruebas (sin red)

```powershell
.venv\Scripts\python.exe -m pytest
```

Las pruebas bloquean sockets y DNS: si algo intentara salir a la red, fallarían.

## Uso

Todos los comandos se ejecutan desde `tools\instagram-pilot`. Solo puede haber una ejecución activa.

### 1. Iniciar sesión (en su terminal, una vez)

```powershell
.venv\Scripts\python.exe -m icm_ig_pilot login --user SU_CUENTA
```

- La contraseña y el código de dos pasos se piden en la terminal sin mostrarse y **no se guardan**.
- Si Instagram pide una verificación (checkpoint), resuélvala en la app o el navegador y vuelva a
  ejecutar `login` más tarde. El comando no reintenta.
- Si Instagram acepta la contraseña pero no entrega la cookie de sesión (pasa con el login web de
  Instaloader 4.16), use la alternativa manual: abra instagram.com en su navegador con la cuenta,
  F12 → Aplicación → Cookies, y pegue en la terminal (no en un chat) `sessionid`, `csrftoken` y
  `ds_user_id`:

  ```powershell
  .venv\Scripts\python.exe -m icm_ig_pilot login --user SU_CUENTA --paste-sessionid
  ```

  El piloto no lee el navegador por su cuenta: usted copia los valores. Se verifica que la sesión sea de
  esa cuenta antes de guardarla. No cierre sesión en el navegador durante la prueba.
- La sesión se guarda en `%LOCALAPPDATA%\icmSpy\instagram-pilot\sessions\session-SU_CUENTA`, fuera del
  repositorio (el piloto rechaza rutas dentro del repositorio). Ese archivo da acceso a la cuenta: no lo
  comparta.

### 2. Ejecutar

```powershell
.venv\Scripts\python.exe -m icm_ig_pilot run --target https://www.instagram.com/PERFIL/ --user SU_CUENTA --limit 100
```

| Parámetro | Por defecto | Notas |
| --- | --- | --- |
| `--target` | (obligatorio) | URL del perfil o nombre de usuario. Se rechazan publicaciones, reels, historias, dominios parecidos y URL con credenciales |
| `--user` | (obligatorio) | Debe coincidir con la cuenta de la sesión; se verifica antes de leer nada |
| `--limit` | 100 | Máximo 300, acumulado con las reanudaciones |
| `--max-minutes` | 20 | Plazo de la ejecución; al agotarse se guarda y se detiene |
| `--web` | desactivado | Consulta hasta 20 sitios web enlazados |
| `--session-file` | ver arriba | |
| `--output` | `%LOCALAPPDATA%\icmSpy\instagram-pilot\runs` | Fuera del repositorio |

Ctrl+C detiene de forma ordenada tras la unidad en curso (una segunda pulsación corta de inmediato;
lo ya confirmado queda guardado).

### 3. Reanudar

```powershell
.venv\Scripts\python.exe -m icm_ig_pilot resume --run-dir "$env:LOCALAPPDATA\icmSpy\instagram-pilot\runs\CARPETA"
.venv\Scripts\python.exe -m icm_ig_pilot resume --run-dir "...\CARPETA" --limit 300
```

La reanudación comprueba que la sesión sea de la misma cuenta, continúa el cursor congelado de
Instaloader (sin repetir la primera página) y descarta repetidos por ID. Si el cursor caducó, lo dice;
`--restart-cursor` relee la lista desde el principio (los ya guardados se cuentan como duplicados).

### 4. Regenerar el informe (sin red)

```powershell
.venv\Scripts\python.exe -m icm_ig_pilot report --run-dir "...\CARPETA"
```

## Salidas (en la carpeta de la ejecución, fuera de Git)

| Archivo | Contenido |
| --- | --- |
| `pilot.sqlite` | Fuente de verdad: ejecución, cursor, seguidores, historial de nombres, contactos con procedencia, sitios web, eventos |
| `followers.jsonl` | Un seguidor por línea; `contacts_status`: `found`, `none_found`, `not_consulted`, `private_skipped`, `inaccessible`, `failed` |
| `contacts.csv` | Una observación por fila: perfil, tipo, original, normalizado, E.164, estado, extensión, método, fuente, campo, URL, fecha, evidencia, atribución, perfiles que comparten el valor. UTF-8 con BOM, todo entre comillas, sin fórmulas; los teléfonos llevan `'` inicial para que Excel los trate como texto |
| `summary.json` | Contadores, motivo de detención, estadísticas, versiones, "dependencias de pago: ninguna" |
| `report.md` | Resumen legible: solo cantidades |
| `run.log` | Eventos saneados (sin cookies, tokens, correos, teléfonos ni biografías) |

Atribución de contactos: `profile_owner` (publicado en el propio perfil), `website_same_domain` (correo
del mismo dominio que el sitio), `website_unverified` (en el sitio, sin confirmar que sea del titular) y
`third_party_suspected` (créditos de agencia, plantillas o dominios de terceros: no se atribuye).

## Motivos de detención

`limit_reached`, `followers_exhausted`, `rate_limited` (429), `rate_wait_too_long`, `checkpoint`,
`session_invalid`, `access_denied` (403), `schema_changed`, `time_limit`, `connection_failed`,
`interrupted`, `cursor_expired`, `repeated_failures`, `target_private`, `target_not_found`.

## Control de tasa

Se usa el control de tasa propio de Instaloader (esperas activas, sin paralelismo), con dos topes: una
espera interna mayor de 90 s o que supere el plazo detiene la ejecución en lugar de bloquearla, y un
429 detiene sin reintentar. Cada petición tiene 30 s de tiempo de espera y como máximo 2 intentos.

## Sitios web (`--web`)

Solo HTTP/HTTPS en puertos 80/443, 3 redirecciones, 1 MB y 20 s por página, solo HTML. Bloqueo SSRF: se
rechazan direcciones privadas, locales, de enlace local (metadatos de nube), multidifusión y reservadas
al resolver cada salto y otra vez sobre la conexión efectiva. Sin cookies ni proxies del sistema.

## Dependencias

Fijadas en `requirements.txt` (Instaloader 4.16, phonenumbers, requests, urllib3) y
`requirements-dev.txt` (pytest). Todas gratuitas y locales. Ningún servicio de pago, API comercial,
proveedor de scraping ni IA.

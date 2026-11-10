<div align="center">

# 🔎 dsh-locator

**Búsqueda de archivos en todo el disco, en milisegundos, para DeepSeek Harness — sin Everything.**

Índice propio multiplataforma (Windows USN/MFT · macOS FSEvents · Linux inotify), cuatro herramientas para el agente y un panel web ordenable.

[![npm version](https://img.shields.io/npm/v/dsh-locator)](https://www.npmjs.com/package/dsh-locator)
[![npm downloads](https://img.shields.io/npm/dm/dsh-locator)](https://www.npmjs.com/package/dsh-locator)
[![CI](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml/badge.svg)](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/v/tag/PerryLink/dsh-locator?label=version)](https://github.com/PerryLink/dsh-locator/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](#)
[![Gitee](https://img.shields.io/badge/Gitee-mirror-c71d23?logo=gitee)](https://gitee.com/perrylink/dsh-locator)
[![GitCode](https://img.shields.io/badge/GitCode-mirror-1f6feb)](https://gitcode.com/PerryLink/dsh-locator)

[简体中文](README.md) · [English](README.en.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

```sh
dsh plugin --profile web add dsh-locator
```

</div>

> **Repositorio oficial:** [GitHub `PerryLink/dsh-locator`](https://github.com/PerryLink/dsh-locator). Gitee y GitCode son espejos sincronizados automáticamente; GitHub es la fuente de verdad.
>
> Forma parte de la [familia de plugins DSH](https://github.com/PerryLink) (Apache-2.0). Si te sirve, **una ⭐ ayuda a que la próxima persona lo encuentre**; no desbloquea nada.

`dsh-locator` indexa una vez los directorios que elijas, guarda el resultado en una instantánea compacta, aplica los cambios del sistema de archivos y responde consultas de nombre/ruta en decenas de milisegundos sobre más de un millón de entradas. El agente recibe `locator_search`, `locator_status`, `locator_rebuild` y `locator_export`; las personas tienen un **panel global** en la Web GUI (`Ctrl+Shift+F` o la lupa del pie de la barra lateral).

## ¿Por qué otro buscador?

`glob` y `grep` recorren el workspace en cada llamada: rápidos si conoces el directorio, lentos si solo recuerdas parte de un nombre. Everything es excelente en Windows, pero solo existe en Windows; envolverlo deja fuera macOS, Linux, WSL y hosts remotos. `dsh-locator` es dueño del índice, así que las mismas herramientas funcionan en cualquier sitio donde corran Node y Go.

## Instalación

```sh
# npm (recomendado)
dsh plugin --profile web add dsh-locator

# GitHub main
dsh plugin --profile web add github:PerryLink/dsh-locator

# desde el código
pnpm install
pnpm build
pnpm build:engine
dsh plugin --profile web add /ruta/absoluta/dsh-locator

# tarball
npm pack
dsh plugin --profile web add /ruta/absoluta/dsh-locator-0.5.0.tgz
```

El paquete npm incluye motores precompilados para `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`, `darwin-x64` y `darwin-arm64`.

Si instalas en un perfil Web ya en ejecución, **recarga la página** (`F5`): las herramientas pueden montarse en caliente, pero el panel (`client.js`) se carga desde el boot graph al abrir la página. Los perfiles headless/TUI no montan panel.

## Panel web

![Panel de búsqueda de dsh-locator: resultados Markdown filtrados por ruta, con recuento, tiempo y columnas ordenables](docs/assets/panel-en.png)

Pulsa `Ctrl+Shift+F` en cualquier parte de la Web GUI, o haz clic en la lupa del pie de la barra lateral. El panel consulta el mismo índice mediante rutas del host del mismo origen (`POST /dsh-locator/search`, `POST /dsh-locator/status`), sin segundo servidor ni puerto extra.

* Consulta vacía: entradas recientes por fecha; al escribir, debounce de 110 ms y la misma sintaxis que las herramientas.
* Clic en una columna para ordenar por nombre, tamaño, fecha o ruta; otro clic invierte.
* `Solo archivos` / `Solo carpetas`; la barra inferior muestra aciertos, límite y tiempo.
* `↑`/`↓` selecciona, `Enter` copia, `Ctrl+O` abre, `Ctrl+Enter` inserta `@"ruta"` en el compositor, doble clic revela en el explorador, `Esc` cierra.
* La interfaz sigue `navigator.language` (zh/en/es/pt/hi).

## Herramientas

| Herramienta | Uso |
|---|---|
| `locator_search` | Consulta el índice con sintaxis estilo Everything. |
| `locator_status` | Raíces, entradas, watcher, modo USN y errores. |
| `locator_rebuild` | Reconstruye en segundo plano; las búsquedas siguen usando el índice anterior. |
| `locator_export` | Copia de solo lectura en SQLite (`entries(path, name, dir, size, mtime_ms, ext)`). |

### Sintaxis de consulta

```text
reporte                  palabras AND en el nombre
"dos palabras"           frase literal
*.go  ?                  comodines
ext:pdf,docx  ext:!tmp   por extensión (o negación)
path:src                 subcadena de la ruta completa
size:>10mb  1kb..2mb     tamaño
dm:today  dm:thisweek    fecha de modificación
folder:  file:           solo carpetas / solo archivos
!tmp                     negar
case:1  wholeword:1      mayúsculas / palabra completa
```

## Configuración esencial

| Clave | Valor |
|---|---|
| `roots` | Directorios a indexar; vacío = directorio personal. |
| `excludes` | Globs por nombre (`node_modules`, `.git`, …). |
| `watch` | Activa las notificaciones del sistema. |
| `refreshIntervalMs` | Reconstrucción periódica si no hay watcher nativo. |
| `windowsUsn` | Ruta rápida USN/MFT (Windows, administrador; por defecto `false`). |
| `scanWorkers` | Lectores de directorio en paralelo; 0 = CPU. |
| `stateDir` | Directorio de la instantánea; vacío = caché del sistema. |

## Plataformas

| Plataforma | Exploración | Actualizaciones |
|---|---|---|
| Linux | recorrido paralelo | inotify recursivo |
| Windows | recorrido o USN/MFT (admin) | `ReadDirectoryChangesW`; USN reanuda tras reinicio |
| macOS | recorrido | FSEvents en binarios cgo; kqueue como respaldo |

En Windows, `scan --usn` guarda `usn-state.json` (id del diario, siguiente USN, raíces) y `serve --usn` reproduce el diario antes de servir: un archivo creado con el daemon detenido aparece al reiniciar sin reescanear. Un diario desactualizado o desmontado cae al watcher portátil.

## Rendimiento

- 1,2 M de entradas: consulta en caliente 25–35 ms; búsqueda durante el escaneo ~2 ms.
- `C:\Windows` (164 216 entradas) indexado por USN en 7,8 s en un runner de CI; consulta 9,6 ms.
- `locator_export` de 1,24 M de filas: 477 MB, 6,4 s.

## Diseño

![Arquitectura de dsh-locator: sistemas de archivos → escaneo/vigilancia → instantánea compacta → motor de consulta → herramientas / panel](docs/assets/architecture.svg)

* **Escaneo paralelo**: cola acotada, lotes por directorio para que el padre exista antes que los hijos.
* **Memoria**: registros de 40 B, nombres en una arena compartida, tabla de rutas abierta; la ruta completa se reconstruye solo al devolver resultados.
* **Consulta**: los términos se compilan una vez, se reparten por fragmentos y un heap acotado selecciona `offset+limit`.
* **Persistencia**: archivo temporal + rename atómico; el snapshot es la fuente de arranque.
* **Protocolo**: NDJSON por stdio; sin puerto ni superficie de red.

## Compilar desde el código

Requiere Node `^22.19 || >=24.9`, pnpm y Go 1.22+.

```sh
pnpm install
pnpm build
pnpm build:engine:all
pnpm check
```

El motor Go vive en `engine/`; pruebas: `cd engine && go test ./...`.

## Límites

* Solo nombres, rutas, tamaños y fechas: **no indexa contenido**. Para contenido usa `grep`.
* No es un driver de sistema de archivos; cubre solo las raíces configuradas.
* inotify consume un descriptor por directorio; árboles enormes pueden agotar el límite del kernel (se avisa y la instantánea sigue usable).
* Escrituras WSL en `/mnt/c` pueden no generar notificaciones de Windows; reconstruye esas raíces.
* macOS: FSEvents en los binarios publicados; kqueue (máx. 4.096 directorios) en compilaciones `CGO_ENABLED=0`. Los cambios de contenido dependen de la reconstrucción periódica.

## Seguridad y privacidad

El índice es local: sin red, sin telemetría, sin subidas. La instantánea contiene nombres y rutas; trátala como datos privados. El plugin nunca modifica, mueve ni borra los archivos indexados.

## Licencia

Apache-2.0.

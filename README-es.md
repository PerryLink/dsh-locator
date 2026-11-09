# dsh-locator

[![npm](https://img.shields.io/npm/v/dsh-locator)](https://www.npmjs.com/package/dsh-locator)
[![ci](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml/badge.svg)](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml)

[English](README.md) | [中文](README-zh.md) | Español | [Português](README-pt.md) | [हिन्दी](README-hi.md)

Búsqueda de archivos en todo el disco para [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) con un índice propio. No requiere Everything, `es.exe` ni un servicio externo.

## Instalación

```sh
dsh plugin --profile web add dsh-locator
```

Tras instalar en una GUI en ejecución, recarga la página. El panel se abre con `Ctrl+Shift+F` o con la lupa del pie de la barra lateral.

## Qué hace

- Índice persistente de nombres, rutas, tamaños y fechas; consultas de decenas de milisegundos en más de un millón de entradas.
- Escaneo paralelo y búsqueda paralela; la primera búsqueda responde durante el escaneo inicial (`indexing: true`).
- Actualizaciones nativas: inotify en Linux, `ReadDirectoryChangesW` en Windows, kqueue en macOS (con reconstrucción periódica).
- En Windows, una ruta rápida USN/MFT opcional (`windowsUsn: true`) cuando DSH se ejecuta como administrador; si falla, vuelve al recorrido de directorios.
- Panel web: ordenar por columna, filtrar, navegar con teclado, copiar la ruta y **doble clic para mostrar el archivo** en el explorador.

## Herramientas

| Herramienta | Uso |
|---|---|
| `locator_search` | Consulta el índice con sintaxis tipo Everything: `ext:pdf`, `size:>10mb`, `dm:thisweek`, `path:src`, comodines y `!` para negar. |
| `locator_status` | Raíces, número de entradas, estado del watcher, modo USN y errores. |
| `locator_rebuild` | Reconstruye el índice en segundo plano. |
| `locator_export` | Escribe una copia de solo lectura en SQLite (`entries(path, name, dir, size, mtime_ms, ext)`). |

## Configuración esencial

| Clave | Valor |
|---|---|
| `roots` | Directorios a indexar; vacío = directorio personal. |
| `excludes` | Globs por nombre para omitir (`node_modules`, `.git`, …). |
| `watch` | Activa las notificaciones del sistema. |
| `refreshIntervalMs` | Reconstrucción periódica cuando no hay watcher nativo. |
| `windowsUsn` | Ruta rápida USN/MFT (solo Windows, administrador; por defecto `false`). |
| `stateDir` | Directorio del snapshot; vacío = caché del sistema. |

## Plataformas y límites

- Solo nombres, rutas, tamaños y fechas: **no indexa contenido**. Usa `grep` para el contenido.
- Windows: USN/MFT es opcional y necesita administrador y un diario de cambios activo; si no, recorrido portátil.
- macOS: kqueue cubre creación, borrado y renombrado; los cambios de contenido llegan con la reconstrucción periódica.
- El snapshot es local; no hay red ni telemetría.

Documentación completa en [English](README.md) y [中文](README-zh.md). Licencia Apache-2.0.

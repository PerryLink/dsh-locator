# dsh-locator

[![npm](https://img.shields.io/npm/v/dsh-locator)](https://www.npmjs.com/package/dsh-locator)
[![ci](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml/badge.svg)](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml)

[English](README.md) | [中文](README-zh.md) | [Español](README-es.md) | Português | [हिन्दी](README-hi.md)

Busca de arquivos em todo o disco para o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) com um índice próprio. Não precisa de Everything, `es.exe` nem serviço externo.

## Instalação

```sh
dsh plugin --profile web add dsh-locator
```

Depois de instalar em uma GUI em execução, recarregue a página. O painel abre com `Ctrl+Shift+F` ou pela lupa no rodapé da barra lateral.

## O que faz

- Índice persistente de nomes, caminhos, tamanhos e datas; consultas em dezenas de milissegundos com mais de um milhão de entradas.
- Varredura e busca paralelas; a primeira busca responde durante a varredura inicial (`indexing: true`).
- Atualizações nativas: inotify no Linux, `ReadDirectoryChangesW` no Windows, kqueue no macOS (com reconstrução periódica).
- No Windows, caminho rápido USN/MFT opcional (`windowsUsn: true`) quando o DSH roda como administrador; qualquer falha volta à varredura de diretórios.
- Painel web: ordenar por coluna, filtrar, navegar por teclado, copiar o caminho e **clique duplo para mostrar o arquivo** no gerenciador de arquivos.

## Ferramentas

| Ferramenta | Uso |
|---|---|
| `locator_search` | Consulta com sintaxe estilo Everything: `ext:pdf`, `size:>10mb`, `dm:thisweek`, `path:src`, curingas e `!` para negar. |
| `locator_status` | Raízes, entradas, estado do watcher, modo USN e erros. |
| `locator_rebuild` | Reconstrói o índice em segundo plano. |
| `locator_export` | Gera uma cópia somente leitura em SQLite (`entries(path, name, dir, size, mtime_ms, ext)`). |

## Configuração essencial

| Chave | Valor |
|---|---|
| `roots` | Diretórios indexados; vazio = diretório pessoal. |
| `excludes` | Globs por nome a ignorar (`node_modules`, `.git`, …). |
| `watch` | Ativa notificações do sistema. |
| `refreshIntervalMs` | Reconstrução periódica quando não há watcher nativo. |
| `windowsUsn` | Caminho rápido USN/MFT (Windows, administrador; padrão `false`). |
| `stateDir` | Diretório do snapshot; vazio = cache do sistema. |

## Plataformas e limites

- Apenas nomes, caminhos, tamanhos e datas: **não indexa conteúdo**. Use `grep` para conteúdo.
- Windows: USN/MFT é opcional e exige administrador e diário de alterações ativo; caso contrário, varredura portátil.
- macOS: FSEvents nos binários cgo publicados (recursivo, sem limite de descritores); kqueue é o fallback para compilações `CGO_ENABLED=0`. Mudanças de conteúdo chegam na reconstrução periódica.
- Snapshot local; sem rede ou telemetria.

Documentação completa em [English](README.md) e [中文](README-zh.md). Licença Apache-2.0.

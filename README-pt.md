<div align="center">

# 🔎 dsh-locator

**Busca de arquivos em todo o disco, em milissegundos, para o DeepSeek Harness — sem o Everything.**

Índice próprio multiplataforma (Windows USN/MFT · macOS FSEvents · Linux inotify), seis ferramentas para o agente — nomes, conteúdo e sessões — e um painel web ordenável.

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

> **Repositório oficial:** [GitHub `PerryLink/dsh-locator`](https://github.com/PerryLink/dsh-locator). Gitee e GitCode são espelhos sincronizados automaticamente; o GitHub é a fonte da verdade.
>
> Faz parte da [família de plugins DSH](https://github.com/PerryLink) (Apache-2.0). Se ajudar, **uma ⭐ ajuda a próxima pessoa a encontrar**; nada é liberado por isso.

`dsh-locator` indexa uma vez os diretórios escolhidos, guarda o resultado num instantâneo compacto, aplica as mudanças do sistema de arquivos e responde consultas de nome/caminho em dezenas de milissegundos sobre mais de um milhão de entradas. O agente recebe `locator_search`, `locator_status`, `locator_rebuild` e `locator_export`; as pessoas têm um **painel global** na Web GUI (`Ctrl+Shift+F` ou a lupa no rodapé da barra lateral).

## Por que outro buscador?

`glob` e `grep` percorrem o workspace a cada chamada: rápidos quando você sabe o diretório, lentos quando lembra só parte de um nome. O Everything é excelente no Windows, mas só existe no Windows; envolvê-lo deixa macOS, Linux, WSL e hosts remotos de fora. O `dsh-locator` é dono do índice, então as mesmas ferramentas funcionam onde Node e Go rodam.

## Instalação

```sh
# npm (recomendado)
dsh plugin --profile web add dsh-locator

# GitHub main
dsh plugin --profile web add github:PerryLink/dsh-locator

# do código
pnpm install
pnpm build
pnpm build:engine
dsh plugin --profile web add /caminho/absoluto/dsh-locator

# tarball
npm pack
dsh plugin --profile web add /caminho/absoluto/dsh-locator-0.5.0.tgz
```

O pacote npm inclui motores pré-compilados para `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`, `darwin-x64` e `darwin-arm64`.

Ao instalar num perfil Web já em execução, **recarregue a página** (`F5`): as ferramentas podem montar a quente, mas o painel (`client.js`) vem do boot graph no carregamento. Perfis headless/TUI não montam painel.

## Painel web

![Painel de busca do dsh-locator: resultados Markdown filtrados por caminho, com contagem, tempo e colunas ordenáveis](docs/assets/panel-en.png)

Pressione `Ctrl+Shift+F` em qualquer lugar da Web GUI, ou clique na lupa no rodapé da barra lateral. O painel se comunica com o host por rotas na mesma origem (`/dsh-locator/search`, `/dsh-locator/content`, `/dsh-locator/status`, `/dsh-locator/reveal` e `/dsh-locator/open`), sem segundo servidor e sem porta extra.

* Consulta vazia: entradas recentes por data; ao digitar, debounce de 110 ms e a mesma sintaxe das ferramentas.
* Clique no cabeçalho para ordenar por nome, tamanho, data ou caminho; outro clique inverte.
* `Somente arquivos` / `Somente pastas` filtram o tipo; marcar **Buscar conteúdo** alterna entre a busca por nomes e a busca no conteúdo dos arquivos e das mensagens de sessão, e os acertos mostram um trecho de uma linha. O rodapé mostra resultados, limite e tempo.
* `↑`/`↓` seleciona, `Enter` copia, `Ctrl+O` abre, `Ctrl+Enter` insere `@"caminho"` no compositor; o clique duplo revela um arquivo no gerenciador de arquivos e, num resultado de sessão, abre a conversa correspondente e destaca a mensagem encontrada por um instante. `Esc` fecha.
* A interface segue `navigator.language` (zh/en/es/pt/hi).

## Ferramentas

| Ferramenta | Uso |
|---|---|
| `locator_search` | Consulta com sintaxe estilo Everything. |
| `locator_find` | Busca no corpo de arquivos e nas mensagens de sessão do DSH; os acertos trazem um trecho e, em conversas, `sessionId`/`messageId`. |
| `locator_status` | Raízes, entradas, watcher, modo USN e erros. |
| `locator_rebuild` | Reconstrói em segundo plano; buscas continuam no índice antigo. |
| `locator_reindex` | Atualiza ou reconstrói o índice de conteúdo: incremental por padrão, `full: true` descarta e reconstrói. |
| `locator_export` | Cópia somente leitura em SQLite (`entries(path, name, dir, size, mtime_ms, ext)`). |

### Busca por conteúdo

`locator_find` procura no corpo de arquivos de texto e nas mensagens de sessão do DSH por meio de um índice FTS5 local em SQLite. Subcadeias em chinês e inglês funcionam sem segmentação de palavras; cada acerto traz um trecho e, quando vem de uma conversa, `sessionId` e `messageId`.

O índice de conteúdo é preguiçoso por padrão: nada é construído na inicialização e a primeira busca de conteúdo inicia a construção em segundo plano (`contentLazy: false` constrói desde o início). Ao reiniciar, o plugin reaproveita o banco existente e o atualiza de forma incremental; a indexação completa (primeiro os logs de sessão, depois o corpo dos arquivos) só roda quando o banco não existe, tem uma versão de esquema antiga ou não pode ser aberto. Depois disso, uma atualização incremental a cada `contentRefreshMs` (5 minutos) relê apenas os arquivos e as sessões cujo mtime mudou. O `locator_reindex` dispara um dos dois modos manualmente.

Enquanto uma indexação está em andamento, as buscas continuam respondendo com o que já está indexado; a ferramenta e o painel mostram o estado da indexação.

Os limites padrão são 1 MB por arquivo de texto, 200.000 arquivos, as 100 sessões mais recentes e 1 GB de texto — tudo configurável. Pastas de dependências e toolchains (`node_modules`, `.cargo`, `.bun`, `.pnpm`, `site-packages`, `toolchain`, …) ficam de fora por padrão — senão consomem o orçamento antes dos seus próprios documentos — e `contentExcludes` muda essa lista. O índice lê e descomprime de forma assíncrona e cede o event loop a cada ~8 ms (28,6 MB: 968 ms → 19 ms), então não trava o carregamento nem a troca de sessão; sessões arquivadas ficam de fora a menos que `contentIncludeArchived: true`, e uma sessão que está sendo escrita espera `contentActiveSessionDelayMs`.

### Sintaxe de consulta

```text
relatorio                palavras AND no nome
"duas palavras"          frase literal
*.go  ?                  curingas
ext:pdf,docx  ext:!tmp   por extensão (ou negação)
path:src                 subcadeia do caminho completo
size:>10mb  1kb..2mb     tamanho
dm:today  dm:thisweek    data de modificação
folder:  file:           só pastas / só arquivos
!tmp                     negar
case:1  wholeword:1      maiúsculas / palavra inteira
```

## Configuração essencial

| Chave | Valor |
|---|---|
| `roots` | Diretórios indexados; vazio = diretório pessoal. |
| `excludes` | Globs por nome (`node_modules`, `.git`, …). |
| `watch` | Ativa notificações do sistema. |
| `refreshIntervalMs` | Reconstrução periódica quando não há watcher nativo. |
| `windowsUsn` | Caminho rápido USN/MFT (Windows, administrador; padrão `false`). |
| `scanWorkers` | Leitores de diretório em paralelo; 0 = CPU. |
| `contentIndex` | Constrói o índice de conteúdo de arquivos e sessões (padrão `true`). |
| `contentLazy` | Constrói o índice de conteúdo na primeira busca de conteúdo em vez de na inicialização; `false` constrói em segundo plano desde o início (padrão `true`). |
| `contentMaxFileBytes` | Bytes lidos de cada arquivo de texto (padrão `1000000`). |
| `contentMaxTotalBytes` | Total de bytes de conteúdo mantido; `0` = sem limite (padrão `1000000000`). |
| `contentMaxFiles` | Máximo de arquivos de texto indexados a cada execução; `0` = sem limite (padrão `200000`). |
| `contentMaxSessions` | Sessões mais recentes indexadas; `0` = todas (padrão `100`). |
| `contentRefreshMs` | Ritmo da atualização incremental de conteúdo; `0` desativa (padrão `300000`). |
| `contentIncludeArchived` | Indexa também sessões arquivadas; padrão `false`. |
| `contentActiveSessionDelayMs` | Só indexa um log de sessão depois de ficar quieto esse tempo (padrão `120000`). |
| `contentSessionDirs` | Diretórios adicionais de sessões; vazio = `$DSH_HOME/sessions`. |
| `contentExcludes` | Trechos de caminho que a busca por conteúdo ignora (dependências e toolchains); o índice de nomes continua igual. |
| `stateDir` | Diretório do instantâneo; vazio = cache do sistema. |


## Plataformas

| Plataforma | Varredura | Atualizações |
|---|---|---|
| Linux | varredura paralela | inotify recursivo |
| Windows | varredura ou USN/MFT (admin) | `ReadDirectoryChangesW`; USN retoma após reinício |
| macOS | varredura | FSEvents nos binários cgo; kqueue como fallback |

No Windows, `scan --usn` grava `usn-state.json` (id do diário, próximo USN, raízes) e `serve --usn` reproduz o diário antes de servir: um arquivo criado com o daemon parado aparece após reiniciar sem reescanear. Diário desatualizado ou removido cai no watcher portátil.

## Desempenho

Conteúdo medido na mesma máquina (cache quente): 20.000 arquivos / 40 MB → 15,1 s e 71 MB; 200.000 arquivos / 331 MB → 31,5 s e 711 MB; atualização incremental do índice completo (1,3 M entradas) 2,9 s; reiniciar reaproveita o banco e leva 4,6 s no corpus de 200.000 arquivos. O banco ocupa 2–3 vezes o texto indexado.

- 1,2 M de entradas: consulta a quente 25–35 ms; busca durante a varredura ~2 ms.
- `C:\Windows` (164.216 entradas) indexado por USN em 7,8 s num runner de CI; consulta 9,6 ms.
- `locator_export` de 1,24 M de linhas: 477 MB, 6,4 s.

## Design

![Arquitetura do dsh-locator: sistemas de arquivos → varredura/vigilância → instantâneo compacto → motor de consulta → ferramentas / painel](docs/assets/architecture.svg)

* **Varredura paralela**: fila limitada e lotes por diretório para o pai existir antes dos filhos.
* **Memória**: registros de 40 B, nomes numa arena compartilhada, tabela de caminhos aberta; o caminho completo só é reconstruído ao devolver resultados.
* **Consulta**: termos compilados uma vez, divididos em fragmentos e um heap limitado escolhe `offset+limit`.
* **Persistência**: arquivo temporário + rename atômico; o instantâneo é a fonte de inicialização.
* **Protocolo**: NDJSON por stdio; sem porta nem superfície de rede.

## Compilar do código

Requer Node `^22.19 || >=24.9`, pnpm e Go 1.22+.

```sh
pnpm install
pnpm build
pnpm build:engine:all
pnpm check
```

O motor Go fica em `engine/`; testes: `cd engine && go test ./...`.

## Limites

* A busca por conteúdo lê apenas arquivos de texto (por extensão) e os logs de sessão do DSH; PDFs, documentos do Office e imagens não têm o texto extraído. Por padrão o corpo indexado fica limitado a 1 GB / 200.000 arquivos, então um diretório pessoal enorme guarda só a primeira fatia alcançada.
* Não é um driver de sistema de arquivos; cobre apenas as raízes configuradas.
* inotify usa um descritor por diretório; árvores enormes podem estourar o limite do kernel (há aviso e o instantâneo continua utilizável).
* Escritas do WSL em `/mnt/c` podem não gerar notificações do Windows; reconstrua essas raízes.
* macOS: FSEvents nos binários publicados; kqueue (máx. 4.096 diretórios) em builds `CGO_ENABLED=0`. Mudanças de conteúdo dependem da reconstrução periódica.

## Segurança e privacidade

O banco de dados de conteúdo e o bloqueio de compilação são criados com permissões `0600`, e o diretório de estado com `0700`: outros usuários locais não podem ler os documentos indexados nem o texto das sessões.

O índice é local: sem rede, sem telemetria, sem uploads. O instantâneo contém nomes e caminhos; trate-o como dado privado. O plugin nunca modifica, move ou apaga os arquivos indexados.

## Licença

Apache-2.0.

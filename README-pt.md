<div align="center">

# 🔎 dsh-locator

**Busque por nome quando lembra do nome e por conteúdo quando lembra da frase; depois abra o arquivo ou volte para a conversa.**

Busca de arquivos em todo o disco para o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) com **índice próprio**: sem instalar o Everything, sem `es.exe`, com as mesmas ferramentas e o mesmo painel no Windows, macOS e Linux.

[![npm version](https://img.shields.io/npm/v/dsh-locator)](https://www.npmjs.com/package/dsh-locator)
[![npm downloads](https://img.shields.io/npm/dm/dsh-locator)](https://www.npmjs.com/package/dsh-locator)
[![CI](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml/badge.svg)](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/v/tag/PerryLink/dsh-locator?label=version)](https://github.com/PerryLink/dsh-locator/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)
[![Awesome DSH](https://img.shields.io/badge/awesome--dsh--plugin-listed-2ea44f)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](#versão-e-compatibilidade)
[![Gitee](https://img.shields.io/badge/Gitee-mirror-c71d23?logo=gitee)](https://gitee.com/perrylink/dsh-locator)
[![GitCode](https://img.shields.io/badge/GitCode-mirror-1f6feb)](https://gitcode.com/PerryLink/dsh-locator)

[简体中文](README.md) · [English](README.en.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

```sh
dsh plugin --profile web add dsh-locator
```

</div>

> **Repositório oficial:** [GitHub `PerryLink/dsh-locator`](https://github.com/PerryLink/dsh-locator); Gitee e GitCode são espelhos sincronizados automaticamente, e o GitHub é a fonte da verdade. Faz parte da [família de plugins do DSH](https://github.com/PerryLink) (Apache-2.0) e está listado no [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin). Uma ⭐ ajuda a próxima pessoa a encontrá-lo; nada fica bloqueado atrás dela.

## Índice

- [De relance](#de-relance)
- [Como difere de Everything / Spotlight / grep](#como-difere-de-everything--spotlight--grep)
- [Instalação](#instalação)
- [Primeira execução](#primeira-execução)
- [Duas buscas](#duas-buscas)
- [Painel web](#painel-web)
- [Busca na conversa (Ctrl+F)](#busca-na-conversa-ctrlf)
- [Ferramentas](#ferramentas)
- [Linguagem de consulta](#linguagem-de-consulta)
- [Configuração](#configuração)
- [Desempenho e recursos](#desempenho-e-recursos)
- [Suporte de plataformas](#suporte-de-plataformas)
- [Solução de problemas](#solução-de-problemas)
- [Compilar a partir do código-fonte](#compilar-a-partir-do-código-fonte)
- [Design](#design)
- [Limitações](#limitações)
- [Memória](#memória)
- [Segurança e privacidade](#segurança-e-privacidade)
- [Versão e compatibilidade](#versão-e-compatibilidade)
- [Roteiro](#roteiro)
- [Licença](#licença)

## De relance

Buscar arquivos tem duas formas:

- **Você lembra do nome mas não do local.** `glob`/`grep` percorrem o workspace a cada chamada: ótimo quando você conhece o diretório, doloroso quando lembra só de metade do nome.
- **Você lembra de uma frase, de uma decisão ou de um trecho, não do arquivo nem da conversa.** Um índice de nomes não ajuda, e os logs de sessão do DSH também são dados de primeira classe.

O `dsh-locator` junta os dois em um único plugin:

| Recurso | Como usar |
|---|---|
| Busca por nome / caminho | `locator_search`, ou o modo padrão do painel |
| Busca no corpo dos arquivos | `locator_find`, ou o escopo **Conteúdo** do painel (ativo por padrão) |
| Busca em sessões do DSH | As mesmas ferramentas; os resultados trazem `sessionId` / `messageId` e o painel pode voltar à conversa |
| Abrir / revelar | As ferramentas devolvem caminhos; o painel revela com duplo clique, `Ctrl+O` abre e `Ctrl+Enter` insere `@"caminho"` no compositor |
| Consumo externo | `locator_export` grava um espelho SQLite somente leitura |

O índice é local: sem chamadas de rede, sem telemetria, sem uploads; o plugin nunca modifica, move ou apaga os arquivos indexados.

## Como difere de Everything / Spotlight / grep

| | dsh-locator | Everything | Spotlight | `glob` / `grep` |
|---|---|---|---|---|
| Plataformas | Windows / macOS / Linux / WSL | Windows | macOS | Multiplataforma |
| Índice | Persistente, próprio | Persistente (USN do NTFS) | Índice do sistema (metadados/conteúdo) | Percorre a cada chamada |
| Busca no conteúdo | Arquivos de texto + mensagens de sessão do DSH | Só nomes por padrão | Sim, varia por sistema | Sim, sem índice |
| Salto para sessão | Resultados trazem `sessionId` / `messageId` | Não | Não | Não |
| Ferramentas para agentes | Seis ferramentas, uma linguagem de consulta | Precisa de CLI/serviço | Precisa de scripts próprios | Nativas, sem índice persistente |
| Velocidade no Windows | Perto do Everything (USN opcional) | Mais rápido e leve | Não se aplica | Mais lento que um índice |

Resumindo: a **ideia** do Everything (índice persistente + consultas estruturadas) foi implementada de forma independente e multiplataforma, com as sessões do DSH por cima. Não é um invólucro do Everything.

## Instalação

```sh
# npm (recomendado)
dsh plugin --profile web add dsh-locator

# fixar uma versão
dsh plugin --profile web add dsh-locator@0.7.7

# branch principal do GitHub
dsh plugin --profile web add github:PerryLink/dsh-locator

# a partir de um checkout
pnpm install
pnpm build
pnpm build:engine        # motor Go da plataforma atual
dsh plugin --profile web add /caminho/absoluto/dsh-locator

# a partir de um tarball (saída do npm pack; troque pela versão real)
npm pack
dsh plugin --profile web add /caminho/absoluto/dsh-locator-0.7.7.tgz
```

- O pacote inclui motores pré-compilados para `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`, `darwin-x64` e `darwin-arm64`; não é preciso Go local.
- Se o espelho npm estiver atrasado, adicione `--registry=https://registry.npmjs.org` ao comando.
- Depois de instalar em um perfil Web **em execução**, **recarregue a página** (`F5`): as ferramentas do host podem montar na hora, mas o painel do navegador é carregado do boot graph ao abrir a página. Perfis headless/TUI só têm as ferramentas.
- Atualizar: `dsh plugin --profile web add dsh-locator@latest` e depois `F5`. Uma mudança de esquema do conteúdo reconstrói o banco uma vez.
- Desinstalar: `dsh plugin --profile web remove dsh-locator`; para manter a configuração mas desativar, `enabled: false`.

## Primeira execução

Na primeira montagem o motor indexa as raízes configuradas (padrão: seu diretório pessoal) e grava o snapshot e o banco de conteúdo no diretório de cache da plataforma:

| Plataforma | Diretório de estado padrão |
|---|---|
| Windows | `%LOCALAPPDATA%\dsh-locator` |
| macOS | `~/Library/Application Support/dsh-locator` |
| Linux | `$XDG_CACHE_HOME/dsh-locator` ou `~/.cache/dsh-locator` |

A primeira varredura de um diretório pessoal grande lê o disco; os próximos inícios carregam o snapshot. As requisições são atendidas **durante** essa varredura: a busca devolve o que já foi indexado com `indexing: true`, e o rodapé do painel avisa que o índice ainda está sendo construído.

Por padrão, `node_modules`, `.git`, `.hg`, `.svn`, `.cache`, `__pycache__`, `.venv`, `venv` e `.next` são ignorados por nome; `excludes` altera a lista.

Experimente:

```text
Encontre os PDFs que alterei na semana passada
Onde "contentRefreshMs" foi discutido?
Em qual conversa este desenho foi decidido?
```

## Duas buscas

### Por nome: `locator_search`

Sintaxe no estilo Everything devolvendo caminho, tamanho, data de modificação, extensão e tipo. Ideal para “o nome contém report”, “PDFs alterados esta semana”, “vídeos com mais de 50 MB”.

Ordenação, paginação e `limit`/`offset` são feitos no motor do host; consultas comuns sobre 1,51 M de entradas respondem em dezenas de milissegundos.

### Por conteúdo: `locator_find`

Pesquisa no **corpo** de arquivos de texto e mensagens de sessão do DSH e devolve trechos com a origem:

- resultados de arquivo trazem caminho e podem ser abertos ou revelados;
- resultados de sessão trazem `sessionId` e `messageId`, então o painel abre a conversa e destaca a mensagem;
- substrings em chinês e inglês funcionam (tokenizador trigram, sem segmentação de palavras).

Como o índice de conteúdo se comporta:

- **Preguiçoso por padrão.** Nada é construído na inicialização; a primeira busca de conteúdo (`locator_find` ou o modo conteúdo do painel) inicia a construção em segundo plano, e `contentLazy: false` volta à construção no arranque. A primeira consulta informa `building: true` em vez de devolver vazio sem explicação.
- **Reinício reaproveitando.** Se o banco existe, ele é atualizado de forma incremental; a construção completa (primeiro logs de sessão, depois corpos de arquivo) só acontece se o banco não existe, tem esquema antigo, ficou incompleto por uma construção interrompida ou não abre.
- **Atualização incremental** a cada `contentRefreshMs` (5 minutos por padrão), relendo só arquivos e sessões cujo mtime mudou; `0` desativa.
- **Sessões arquivadas e ativas.** Arquivadas são ignoradas a menos que `contentIncludeArchived: true`; um log que ainda está sendo escrito só é indexado após `contentActiveSessionDelayMs` (2 minutos) de quietude, para não descomprimi-lo a cada atualização. Sessões apagadas saem do índice quando os arquivos desaparecem.
- **Orçamento e truncamento.** Padrões: 1 MB por arquivo de texto, 200.000 arquivos, 1 GB de corpos e as 100 sessões mais recentes. Ao atingir o orçamento, arquivos que chegam depois na ordem de varredura são ignorados; o `locator_find` informa `content budget reached` e o estado HTTP traz `truncated: true`. Aumente `contentMaxTotalBytes` ou reduza `contentExcludes`.
- **Árvores de dependências não são lidas.** `node_modules`, `.cargo`, `.bun`, `.pnpm`, `site-packages`, `toolchain`, … são ignorados por padrão via `contentExcludes`; caso contrário, código de bibliotecas esgotaria o orçamento antes dos seus documentos. O índice de nomes continua cobrindo esses caminhos.

A construção roda dentro do processo anfitrião do DSH, mas leituras de arquivo e descompressão zstd são assíncronas e os dois laços cedem o controle a cada ~8 ms: em um corpus de 28,6 MB o maior bloqueio do laço de eventos caiu de 968 ms para cerca de 20 ms, então carregar e trocar sessões continua fluido. As **consultas** de conteúdo rodam em uma worker thread com conexão somente leitura: palavras comuns levam cerca de 100 ms e termos raros alguns milissegundos, sem bloquear o host.

## Painel web

Pressione `Ctrl+Shift+F` na GUI web, ou clique na lupa no pé da barra lateral. O painel usa rotas de mesma origem (`search`, `content`, `content/rebuild`, `combined`, `status`, `reveal`, `open`), sem outro servidor nem outra porta. O `/combined` aceita `matchMode`, `caseSensitive`, `wholeWord`, `sessionId` e `count`; o grupo de conteúdo devolve `count`/`warnings`, e os resultados de arquivo trazem `line`.

- **Os três escopos vêm ativados por padrão**: conteúdo (corpos + sessões), arquivos e pastas; desmarque qualquer um para restringir. Os resultados são agrupados **conteúdo → arquivos → pastas** com a contagem por grupo; o conteúdo é ordenado por relevância e os grupos de nomes seguem o menu de ordem.
- **Duplo clique ou `Enter` ativa um resultado**: uma sessão abre a conversa e pinta as palavras encontradas com destaque âmbar translúcido que acompanha a rolagem, é centralizado ao chegar e é limpo com `Esc`; arquivos e pastas são mostrados no gerenciador de arquivos. `Ctrl+Shift+C` copia o caminho, `Ctrl+O` abre, `Ctrl+Enter` insere `@file` e `Alt+1–3` alterna os escopos.
- **Contagem**: os cabeçalhos de grupo mostram quantos resultados há — exato quando dá para contar, `≥ N` quando o total é limitado por um teto; o cabeçalho do painel mostra a posição selecionada (`3/37`) e o rodapé resume os três grupos. A página de conteúdo agora é montada em três passos — rowids do rank, corpo por rowid e trecho/linha em JS —, então palavras comuns caíram de ~2,7 s para menos de 300 ms.
- **Opções de busca**: a barra de ferramentas oferece modo (Normal / Estendido / Regex), `Aa` para diferenciar maiúsculas, palavra inteira e o escopo da conversa atual. Modo, maiúsculas e palavra inteira valem para nomes de arquivos e pastas; o conteúdo aceita Normal/Estendido/maiúsculas/palavra inteira, e **no modo Regex o escopo de conteúdo pausa** (nomes ainda aceitam regex), para que nenhuma tecla digitada no painel varra o corpus inteiro.
- **Escopo da conversa atual**: consulta apenas as mensagens já indexadas dessa sessão (uma sessão ativa leva cerca de 2 minutos para entrar no índice); os escopos de arquivos e pastas ficam desabilitados, mas mantêm a marcação. Para navegar ocorrência por ocorrência ao vivo, use a busca na conversa com `Ctrl+F`, logo abaixo.
- Consultas de conteúdo exigem pelo menos dois caracteres; consultas vazias ou de um caractere não iniciam a construção. Durante a construção o grupo de conteúdo mostra o progresso e os nomes respondem na hora; os escopos e as opções de busca são lembrados.
- Teclado: `↑`/`↓`, `Home`/`End`, `PageUp`/`PageDown` movem, `F3`/`Shift+F3` percorrem os resultados em ciclo, `Enter` ativa e `Esc` fecha; o diálogo prende o foco e o restaura ao fechar. O texto segue `navigator.language` (zh/en/es/pt/hi).

## Busca na conversa (Ctrl+F)

Pressione `Ctrl+F` numa conversa (ou clique em `⌕` no cabeçalho da sessão) para abrir uma barra de busca não modal no canto superior direito da conversa, que pesquisa apenas as mensagens **carregadas** da conversa atual — sem índice de conteúdo e sem a espera de dois minutos:

- **Contagem e navegação**: mostra `3/17`; `Enter`/`F3` vão para a próxima ocorrência, `Shift+Enter`/`Shift+F3` para a anterior, e a busca dá a volta por padrão (ao chegar a uma ponta, retoma do outro lado e avisa). Todas as ocorrências ficam com destaque translúcido; a ocorrência atual fica mais escura e sublinhada.
- **Opções**: `Aa` diferencia maiúsculas, palavra inteira (limites `[A-Za-z0-9_]`; CJK conta como não palavra), continuar do início e buscar para trás (inverte a direção do `Enter`); os botões de anterior e próxima estão sempre disponíveis.
- **Modos**: Normal (literal), Estendido (`\n` `\r` `\t` `\0` `\xHH` `\\`; escapes desconhecidos ficam literais) e Regex (JS RegExp em uma worker thread, com timeout de 500 ms; padrão inválido mostra o erro na própria barra). Correspondências de largura zero são ignoradas em vez de travar a interface.
- **Busca na seleção**: selecione texto na conversa e pressione `Ctrl+F`; a barra começa restrita à seleção e mostra um chip com o tamanho da seleção. Seleções que cruzam mensagens também funcionam; se a seleção expirar, a barra volta para a conversa inteira.
- **Janela carregada**: só as mensagens já carregadas entram na busca; em conversas longas, use “Carregar mensagens anteriores e tentar novamente” em vez de paginação automática.
- `Esc` fecha a barra e limpa os destaques; trocar de conversa, abrir o painel ou descarregar o plugin também limpam. O painel global cuida da descoberta entre arquivos e sessões; a barra cuida da navegação ocorrência por ocorrência na conversa atual, e os destaques das duas nunca se sobrepõem.


## Ferramentas

| Ferramenta | O que faz |
|---|---|
| `locator_search` | Consulta nomes e caminhos com filtros `ext:`, `size:`, `dm:`, `path:`, ordenação e paginação. |
| `locator_find` | Busca em corpos de arquivo e mensagens de sessão; devolve trechos, `sessionId`/`messageId` e o estado do índice de conteúdo. Resultados de arquivo podem trazer `line`. |
| `locator_status` | Raízes, contagens do índice de nomes, estado do watcher, diretório de estado e caminho do motor. (O progresso do conteúdo é informado pelo `locator_find` e pelo painel.) |
| `locator_rebuild` | Substitui o índice de nomes por uma varredura em segundo plano; as buscas usam o índice antigo até o novo ficar pronto. |
| `locator_reindex` | Atualiza ou reconstrói o índice de conteúdo: incremental por padrão, `full: true` apaga e reconstrói. |
| `locator_export` | Grava um espelho SQLite somente leitura do índice de nomes (tabela `entries`) para ferramentas SQL externas. |

## Linguagem de consulta

Palavras soltas são substrings do nome unidas por AND. Filtros no estilo Everything se combinam com elas:

| Exemplo | Significado |
|---|---|
| `report` | o nome contém `report` |
| `report ext:pdf` | …e a extensão é `pdf` |
| `ext:ts,js` / `ext:!tmp` | incluir ou excluir extensões |
| `*.sln` / `?ata` | curingas `*` e `?` |
| `"annual report"` | frase com espaço |
| `!archive` | negar um termo |
| `path:src` | o caminho completo contém `src` |
| `size:>10mb` / `size:1kb..2mb` | comparações de tamanho |
| `dm:today` / `dm:thisweek` / `dm:2026-01-01` | data de modificação |
| `folder:` / `file:` | somente diretórios / somente arquivos |
| `case:1` / `wholeword:1` | sensível a maiúsculas / limites de palavra |

O `locator_search` também aceita `sort` (`name`, `path`, `size`, `mtime`, `ext`), `desc`, `offset`, `limit`, `regex`, `caseSensitive` e `wholeWord`.

## Configuração

Cada campo é um campo de configuração do Schemastery; sobrescreva a entrada `dsh-locator` no patch do perfil, por exemplo:

```yaml
- id: dsh-locator
  name: dsh-locator
  config:
    roots: ['/home/me/Documents', '/home/me/notes']
    contentMaxTotalBytes: 2000000000
    contentExcludes: ['node_modules', '.git', '.cargo', 'site-packages']
```

| Chave | Padrão | Significado |
|---|---|---|
| `enabled` | `true` | Chave geral; `false` não monta ferramentas nem inicia o motor. |
| `roots` | diretório pessoal | Diretórios a indexar; pode haver vários. |
| `excludes` | nomes de desenvolvimento/cache | Globs por nome ignorados pelo índice de nomes. |
| `watch` | `true` | Aplicar notificações do sistema de arquivos. |
| `refreshIntervalMs` | `1800000` | Cadência de reconstrução quando não há watcher nativo (kqueue ou falha do watcher); `0` desativa. |
| `scanWorkers` | `0` | Concorrência de leitura de diretórios; `0` usa o número de CPUs. |
| `windowsUsn` | `false` | Tentar a enumeração USN/MFT do NTFS antes da varredura (Windows, administrador; com fallback automático). |
| `memoryLimitMB` | `0` | Limite suave do heap Go do motor em MiB; `0` deixa com `GOMEMLIMIT`/`GOGC`. |
| `contentIndex` | `true` | Construir o índice de corpos e mensagens de sessão; `false` deixa a busca por nome com custo de conteúdo quase zero. |
| `contentLazy` | `true` | Construir o índice de conteúdo na primeira busca em vez de no arranque. |
| `contentMaxFileBytes` | `1000000` | Bytes lidos de um arquivo de texto. |
| `contentMaxTotalBytes` | `1000000000` | Total de bytes de corpos guardados; `0` = sem limite. |
| `contentMaxFiles` | `200000` | Arquivos de texto indexados por construção; `0` = sem limite. |
| `contentMaxSessions` | `100` | Logs de sessão mais recentes indexados; `0` = todos. |
| `contentRefreshMs` | `300000` | Cadência de atualização incremental do conteúdo; `0` desativa. |
| `contentIncludeArchived` | `false` | Indexar também sessões arquivadas. |
| `contentActiveSessionDelayMs` | `120000` | Indexar um log de sessão só após esse tempo de quietude. |
| `contentSessionDirs` | `[]` | Diretórios de sessão extras; vazio = `$DSH_HOME/sessions`. |
| `contentExcludes` | nomes de dependências/toolchains | Segmentos ou substrings de caminho ignorados pelo índice de conteúdo; o de nomes continua cobrindo. |
| `stateDir` | `''` | Diretório do snapshot e do banco de conteúdo; vazio = cache da plataforma. Use um diretório por processo do DSH. |

`binaryPath`, `maxResults`, `startupTimeoutMs` e `requestTimeoutMs` também existem para motores personalizados, limites de página e prazos; os padrões atendem a maioria dos casos.

## Desempenho e recursos

Medido em uma máquina de desenvolvimento WSL2 (Linux, cache de página quente) e um diretório pessoal real; sua máquina varia com disco, número de arquivos, cache e GC.

**Índice de nomes**

| Métrica | Resultado |
|---|---|
| Varredura a frio | ~1,51 M de entradas em 11–12 s |
| Tamanho do snapshot | ~171 MB para 1,51 M de entradas |
| Consulta a quente (`locator_search`) | 6–25 ms para consultas comuns; varreduras `path:` ~70 ms |
| Busca durante uma reconstrução | O índice antigo continua servindo até o novo ficar pronto |
| Memória de pico na varredura | Centenas de MB; o motor é um processo filho e respeita `memoryLimitMB` / `GOMEMLIMIT` |

**Índice de conteúdo** (diretório pessoal real, orçamento de 1 GB)

| Métrica | Resultado (0.7.x, diretório real) |
|---|---|
| Cobertura | ~95,8 k arquivos de texto / 95 sessões / 1.050 mensagens |
| Reconstrução completa | ~3,5 min em segundo plano; host p95 14 ms / máx 115 ms durante ela |
| Atualização incremental (sem mudanças) | ~12 s (dominado pelo dump de 1,51 M de entradas do motor) |
| Latência do host ocioso | p50 2 ms / p95 3 ms / máx 6 ms |
| Tamanho do banco | ~3,1 GB (cerca de 3× o orçamento de corpos) |
| Consulta de conteúdo | ~100 ms para palavras comuns, poucos ms para raras (worker thread, host não bloqueia) |

**Configurações mais econômicas**

- Só busca por nome: `contentIndex: false` zera o trabalho de conteúdo.
- Manter conteúdo usando menos disco: reduza `contentMaxTotalBytes` (ex.: 256000000) ou `contentMaxFileBytes`, ou aumente `contentRefreshMs`.
- Cobrir mais arquivos: aumente `contentMaxTotalBytes` / `contentMaxFiles` e confira se `contentExcludes` não está excluindo árvores de documentos reais.
- O banco de conteúdo é cache: apagar `stateDir` reconstrói e nunca toca nos arquivos originais.

## Suporte de plataformas

| Plataforma | Varredura + snapshot | Atualizações ao vivo | Observações |
|---|---|---|---|
| Linux | sim | inotify, recursivo | Descritores de vigilância são por diretório; árvores enormes podem atingir `fs.inotify.max_user_watches`. |
| Windows | sim | `ReadDirectoryChangesW`, recursivo | Não precisa de administrador nem do Everything. Enumeração USN/MFT opcional com privilégios elevados. Mudanças do WSL em `/mnt/<drive>` podem não gerar notificações; reconstrua essas raízes. |
| macOS | sim | FSEvents nos binários cgo publicados, recursivo e sem limite | kqueue é o fallback com `CGO_ENABLED=0` (até 4.096 diretórios); mudanças de conteúdo dependem da reconstrução periódica. |

### Windows e o diário USN

O motor inclui um decodificador USN, um caminho rápido opcional e uma sonda. O caminho fica **desativado por padrão** (`windowsUsn: false`) porque o ioctl do volume exige privilégios de administrador; foi validado de ponta a ponta em um runner Windows do GitHub Actions (administrador, volume NTFS real):

- 1.345.546 registros MFT lidos, 1.345.539 caminhos resolvidos
- 164.209 entradas em `C:\Windows` (122.915 arquivos, 41.294 diretórios)
- `scan --usn --root C:\Windows` indexou 164.216 entradas em 7,8 s; uma consulta respondeu em 9,6 ms
- o diário de mudanças foi lido (8.233 registros em uma execução) e um diário inativo em `D:` caiu para a varredura com aviso

Teste você mesmo:

```powershell
# PowerShell elevado (ou: Start-Process -Verb RunAs <caminho> ...)
& ".\bin\win32-x64\indexd.exe" usn-probe --volume C: --root "C:\Windows" --limit 5 --journal 5
```

Ele imprime o id/USNs do diário, enumera a MFT (registros por segundo, arquivos/diretórios sob a raiz, caminhos de exemplo) e decodifica os últimos registros do diário. Sem elevação falha com `Access is denied`; o parser e a reconstrução de caminhos são cobertos por testes unitários em todas as plataformas.

Com `windowsUsn: true` (ou `indexd scan --usn`) o motor enumera a MFT em vez de percorrer diretórios e monta caminhos a partir do mapa de pais FRN. Uma varredura USN bem-sucedida grava `usn-state.json` (id do diário, próximo USN, raízes) e mantém o FRN em cada registro; no próximo `serve --usn` o motor reproduz o diário a partir desse cursor antes de responder, então arquivos criados enquanto estava parado aparecem sem varredura completa. Um diário envolvido, apagado ou inconsistente cai para o watcher portátil. Ele mantém o handle do volume e consulta o diário a cada dois segundos, aplicando criações, exclusões e renomeações via `usn.ApplyChanges` (o mesmo mapa FRN, atualizado no local). Registros USN **não trazem tamanho nem data de modificação**: os resultados são corretos para nomes e caminhos, o `locator_status` marca esse índice com `USN`, e o daemon faz stat da página devolvida para que as linhas mostrem tamanhos e datas reais; filtros `size:`/`dm:` sobre o índice inteiro continuam aproximados até uma passada de metadados. Qualquer falha (sem elevação, volume não suportado, registros demais) cai para a varredura portátil com aviso; nunca desativa a busca.

O Everything lê a Master File Table do NTFS pelo diário USN, e é por isso que seu primeiro índice é quase instantâneo. O `dsh-locator` mantém a varredura portátil como padrão (sem serviço, sem UAC, qualquer sistema de arquivos) e usa USN/MFT como caminho rápido opcional onde o processo tem `GENERIC_READ` (administrador), com reprodução do diário entre reinícios. O caminho portátil continua sendo o fallback.

## Solução de problemas

**O painel não aparece depois de instalar.**
Recarregue a página (`F5`); confirme que instalou no perfil `web` e que o painel carrega do boot graph. Perfis headless/TUI nunca montam painel.

**Um arquivo recém-criado não aparece.**
A notificação pode não ter chegado (comum com gravações do WSL em `/mnt/c`, compartilhamentos de rede e alguns overlays de contêiner). Espere um instante ou rode `locator_rebuild` para essa raiz. O modo USN reproduz o diário ao reiniciar.

**A busca de conteúdo não devolve nada.**
Veja `building` no resultado do `locator_find`: a primeira busca dispara a construção preguiçosa e os resultados podem ser parciais até terminar (o painel consulta de novo sozinho). Confirme também que a extensão é de texto, o arquivo não passa de `contentMaxFileBytes`, não é excluído por `contentExcludes` e a sessão não está arquivada (arquivadas são ignoradas por padrão).

**O banco de conteúdo está enorme / o disco cresce rápido.**
Veja [Desempenho e recursos](#desempenho-e-recursos): reduza o orçamento ou use `contentIndex: false`. Apagar `stateDir` dispara uma reconstrução.

**Aparece um aviso de `inotify`.**
Diretórios demais atingem o limite do kernel; o índice continua utilizável e as mudanças dependem de reconstruções periódicas. Aumente `fs.inotify.max_user_watches` ou reduza `roots`.

**O comportamento mudou após atualizar.**
Rode `dsh plugin --profile web add dsh-locator@latest` e `F5`. Uma mudança de esquema do conteúdo reconstrói o banco uma vez. Veja o [CHANGELOG](CHANGELOG.md).

## Compilar a partir do código-fonte

Requisitos: Node `^22.19 || >=24.9`, pnpm e Go 1.22+ para o motor.

```sh
pnpm install
pnpm build
pnpm build:engine:all   # ou build:engine para a plataforma atual
pnpm check              # typecheck + testes + verificação de empacotamento/instalação
```

O motor é um módulo Go separado em `engine/`; seus testes rodam com `cd engine && go test ./...`. O backend FSEvents do macOS precisa de cgo e é compilado no CI de macOS. Os testes Node rodam em Linux, Windows e macOS no CI.

## Design

![Arquitetura do dsh-locator: sistemas de arquivos → varredura/vigilância → snapshot compacto → motor de consulta → ferramentas do agente / painel web](docs/assets/architecture.svg)

```
DeepSeek Harness
  └─ dsh-locator (plugin TypeScript)
       ├─ locator_search / locator_find / locator_status / locator_rebuild /
       │  locator_reindex / locator_export
       ├─ client.js: overlay Ctrl+Shift+F (slot shell.overlay)
       ├─ POST /dsh-locator/{search,content,status,reveal,open} (mesma origem)
       ├─ armazenamento de conteúdo: SQLite FTS5 (trigram) no processo anfitrião,
       │  consultas em worker thread
       └─ processo filho: indexd serve  (Go, NDJSON por stdio)
            ├─ scanner: varredura recursiva, exclusões, progresso
            ├─ index:   arena de nomes + registros fixos + tabela de caminhos aberta
            ├─ query:   parser, matcher, seleção top-K, ordenação, paginação
            ├─ watcher: inotify (Linux) / ReadDirectoryChangesW (Windows)
            └─ snapshot: arquivo único, mmap-friendly, renomeação atômica
```

- **Scanner paralelo.** Leitores de diretório drenam uma fila limitada e gravam um lote por diretório (`AddBatch`), então o registro pai existe antes dos filhos entrarem na fila. A fila não bloqueia: se estiver cheia, aquela subárvore é varrida em linha.
- **Layout de memória.** Registros guardam deslocamento/comprimento do nome em uma arena de bytes e um id de pai; caminhos completos só são reconstruídos para a página de resultados e filtros `path:`. Isso evita um cabeçalho de string por arquivo.
- **Tabela de caminhos.** Uma tabela de endereçamento aberto com slots `id+1` mantém busca/atualização perto de 12 bytes por entrada em vez dos ~50 de um `map[string]int32`.
- **Motor de consulta.** Termos e filtros são compilados uma vez, comparados em blocos paralelos e reduzidos com um max-heap limitado: as `offset+limit` linhas são selecionadas sem ordenar milhões de correspondências.
- **Índice de conteúdo.** SQLite FTS5 no host com tokenizador trigram (substrings UTF-8, CJK); a lista de arquivos vem da própria varredura do motor e logs de sessão são descomprimidos com zstd do Node.
- **Consistência do conteúdo.** Um lock de construção por processo serializa escritores que compartilham `stateDir`, uma marca de construção completa força reconstrução após uma interrompida, e um handle obsoleto é detectado por dispositivo+inode para que a reconstrução de outro processo não deixe o host lendo um banco desvinculado.
- **Persistência.** O snapshot é gravado em arquivo temporário e renomeado; um contador de geração permite ao daemon salvar só quando o índice mudou. Lápides são compactadas quando as exclusões passam de um limite.
- **Protocolo.** Uma requisição/resposta JSON por linha em stdio, com eventos `scan`, `stats`, `warning`, `error` e `rebuilt`. Sem portas, sem superfície de autenticação, sem listeners de rede.
- **Somente leitura.** O motor abre arquivos apenas para metadados; nunca escreve nos caminhos indexados.

## Limitações

- A busca de conteúdo lê apenas arquivos de texto (por extensão) e logs de sessão do DSH; PDF, Office e imagens não têm texto extraído.
- O orçamento de conteúdo é consumido na ordem de varredura, não por importância do arquivo; arquivos posteriores não são buscáveis ao atingir o limite (`truncated` é true).
- O índice cobre as raízes configuradas; não é um driver do sistema de arquivos.
- O inotify do Linux vigia um descritor por diretório; um diretório pessoal com centenas de milhares de diretórios pode exceder o limite do kernel. O plugin avisa e o snapshot continua utilizável; reconstruções se recuperam.
- Gravações do WSL em `/mnt/c` podem não produzir notificações do Windows (o watcher não vê o fluxo do escritor 9p). Reconstrua essas raízes.
- Compartilhamentos de rede só são varridos se acessíveis como diretórios comuns; não há feed de mudanças específico de SMB.
- O conteúdo das sessões vem de logs locais; mensagens ainda não gravadas em disco não são buscáveis.
- Dois processos do DSH compartilhando um `stateDir` devem ser evitados: o lock de construção serializa escritores, mas não compartilha um handle de banco aberto.
- O macOS usa FSEvents (recursivo) nos binários publicados; uma compilação com `CGO_ENABLED=0` cai para kqueue, limitado a 4.096 diretórios, com mudanças de conteúdo dependendo da reconstrução periódica.
- USN/MFT do Windows é opcional e só é usado se o processo puder ler o volume e o diário estiver ativo; caso contrário, usa-se a varredura portátil.

- Resultados no corpo de arquivos abrem o gerenciador de arquivos por enquanto (a visualização por linha dentro do DSH é o próximo passo; os resultados já trazem um número de `line`); mensagens do assistente ficam ancoradas pela chave de nó `turn:step`, com frase apenas como reserva. Atualizar de 0.8.0 para 0.8.1 reconstrói uma vez o banco de conteúdo pelo novo campo.
- **Regex de conteúdo em todo o corpus fica fora do P0**: o modo Regex pausa o grupo de conteúdo (nomes de arquivo e pasta continuam aceitando regex) para evitar varrer um corpus de 1 GB e ReDoS; a busca na conversa aceita regex.
- O escopo de conversa atual do painel cobre apenas mensagens de sessão já indexadas (uma sessão ativa entra no índice após cerca de 2 minutos de quietude); para busca ao vivo use `Ctrl+F`. A busca na conversa cobre apenas a janela carregada; carregue mensagens anteriores explicitamente.
- O destaque dentro da conversa usa a API CSS Custom Highlight; navegadores antigos sem ela caem para um contorno na linha.

## Memória

O motor é um único processo Go e respeita as variáveis padrão `GOMEMLIMIT` e `GOGC` (ou `memoryLimitMB` na configuração). Um índice de 1,2–1,5 M de entradas chega a várias centenas de MB de RSS com o GC padrão; use `GOMEMLIMIT=600MiB` (limite suave, o runtime troca CPU por memória) ou `GOGC=50` quando o host estiver apertado de RAM. Nenhum altera o formato do snapshot. Na instalação ao vivo usada para os números acima, o processo anfitrião do DSH (incluindo o cache de páginas do banco de conteúdo) ficava por volta de 700 MB de RSS com o índice construído, e a latência do host ocioso permanecia em p50 2 ms.

## Notas de atualização 0.11.0

- **Índice de conteúdo completo**: `contentMaxTotalBytes: 0` e `contentMaxFiles: 0` indexam todos os arquivos de texto elegíveis (~185k arquivos / 2.0 GB, ~5.9 GB de FTS na máquina de referência); a primeira construção leva alguns minutos e as consultas ficam em ~0,04–0,7 s. Os limites padrão continuam ativos para não consumir dezenas de GB sem aviso.
- `locator_find` continua no workspace; se o cwd estiver fora de todos os roots indexados, ele não restringe mais os arquivos a esse cwd (antes retornava vazio) e busca nos roots; sessões continuam limitadas à atual. Use `scope: "all"` para cruzar escopos.
- Painel: **carregar mais** (paginação por offset), **buscas recentes** e **filtro dos resultados carregados**.
- Segurança: rejeita destinos sob mount points aninhados dentro de um root no Linux; `/open` usa `O_NOFOLLOW` e confere o inode.

## Notas de atualização 0.10.0

- A busca de conteúdo exige pelo menos **3 caracteres**; use `Ctrl+F` para 1–2. Consultas com mais de 256 caracteres ou 32 termos são rejeitadas.
- `locator_find` usa **escopo workspace** por padrão (sessão do chamador e seu cwd); para cruzar workspaces passe `scope: "all"`. Novos parâmetros: `matchMode`, `caseSensitive`, `wholeWord`, `sessionId`, `count`, `countLimit`, `pathPrefix`.
- As rotas HTTP do painel exigem o serviço `connection` do DSH (fail-closed) e POST + JSON + mesma origem; o perfil web padrão não muda.
- `locator_export` grava por padrão no stateDir do plugin e valida a propriedade antes de sobrescrever; `locator_rebuild` aceita apenas subconjuntos dos roots/excludes configurados.
- Os binários do engine são 0.10.0: snapshot com debounce, memória de `sort=path` limitada, watcher com estado degradado/fallback; no macOS o release precisa ser compilado com cgo/FSEvents (o fallback kqueue de depuração não é publicável).
- Cliente: clique nos resultados mantém teclado/Esc; busca com quebras suaves/`<br>`/CJK corrigida; linhas gêmeas do assistente preferem a resposta; regex usa `u` e não cai na thread principal; avisos/limites/truncamento visíveis.

## Segurança e privacidade

- O índice é local: sem chamadas de rede, sem telemetria, sem uploads. O plugin nunca modifica, move ou apaga arquivos indexados.
- O banco de conteúdo e o lock de construção são criados `0600`, e o diretório de estado `0700`: outros usuários locais não conseguem ler documentos indexados nem o texto de sessões.
- O snapshot e o banco de conteúdo contêm nomes, caminhos e corpos; trate o diretório de estado como dado privado. Apagá-lo limpa o cache.
- Dê a cada processo concorrente do DSH um `stateDir` separado.

## Versão e compatibilidade

- Node `^22.19.0 || >=24.9.0`; DSH `>=0.2.1-rc.2 <0.3.0` (veja `engines` no `package.json`).
- As versões são publicadas com procedência do GitHub Actions, então a origem do pacote npm é verificável; Gitee / GitCode são sincronizados por um workflow de espelho.
- Registro de mudanças: [CHANGELOG.md](CHANGELOG.md); dúvidas e relatos: [Issues](https://github.com/PerryLink/dsh-locator/issues).

## Roteiro

Não é um compromisso, apenas a direção atual:

1. Verificar o runtime desktop Electron em uma instalação real do Windows.
2. Pré-visualizações e agrupamento de resultados no painel.
3. Cobertura de runtime em Windows on ARM / Linux ARM.
4. Arena de nomes em minúsculas e pré-filtro trigram para índices muito grandes.
5. Compactação incremental do snapshot e diários por raiz.

## Licença

Apache-2.0.

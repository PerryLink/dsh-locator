<div align="center">

# 🔎 dsh-locator

**给 DeepSeek Harness 的全盘文件搜索：先按名字找，再按内容找，找到就能打开。**

索引由插件自己维护，不装 Everything，也不依赖 `es.exe`。Windows、macOS、Linux 用同一套工具和同一个面板。

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

> 官方仓库是 [GitHub `PerryLink/dsh-locator`](https://github.com/PerryLink/dsh-locator)，Gitee 和 GitCode 是自动同步的镜像。这个插件属于 [DSH 插件家族](https://github.com/PerryLink)，Apache-2.0；如果它帮你省了时间，点个 ⭐ 就行。

## 它解决什么问题

找文件通常分两种情况。

一种是你记得名字，但不记得放在哪。`glob` 和 `grep` 每次都要重新遍历工作区，知道目录时很快，只记得半个文件名时就很慢。Everything 在 Windows 上很好用，可惜只支持 Windows；把它包一层，macOS、Linux、WSL 和远程机器仍然用不了。

另一种是你记得某句话、某个结论、某段代码，却想不起在哪个文件、哪次对话里。这时只搜文件名没有用。

`dsh-locator` 把这两件事放在一起：

- 一份常驻的文件名/路径索引，百万条记录也能在几十毫秒内返回；
- 一份内容索引，覆盖文本文件和 DSH 会话消息，支持中文和子串；
- 找到之后可以直接打开文件、定位到文件夹，或者跳到对应的会话。

## 安装

```sh
# npm（推荐）
dsh plugin --profile web add dsh-locator

# 直接跟 GitHub 主仓
dsh plugin --profile web add github:PerryLink/dsh-locator

# 从源码
pnpm install
pnpm build
pnpm build:engine
dsh plugin --profile web add /绝对路径/dsh-locator

# 从 tarball
npm pack
dsh plugin --profile web add /绝对路径/dsh-locator-0.7.0.tgz
```

npm 包里已经带了六个平台的预编译引擎：`linux-x64`、`linux-arm64`、`win32-x64`、`win32-arm64`、`darwin-x64`、`darwin-arm64`。

如果装进一个**正在运行**的 Web profile，装完刷新一下页面（F5）。宿主工具可能会热挂载，但浏览器面板是页面加载时从 boot graph 里取的。headless/TUI profile 不会显示面板。

## 第一次运行

默认索引你的主目录，快照放在系统缓存目录：

| 平台 | 默认位置 |
|---|---|
| Windows | `%LOCALAPPDATA%\dsh-locator` |
| macOS | `~/Library/Application Support/dsh-locator` |
| Linux | `$XDG_CACHE_HOME/dsh-locator` 或 `~/.cache/dsh-locator` |

第一次扫描要读盘，之后启动直接加载快照。扫描期间搜索照常可用：返回已经索引的部分，并带 `indexing: true`，面板底栏也会提示“索引构建中”。

默认跳过 `node_modules`、`.git`、`.svn`、`.hg`、`.cache`、`__pycache__`、`.venv`、`venv`、`.next`。

## 两种搜索

### 按名字找：`locator_search`

Everything 风格的查询语法，返回路径、大小、修改时间、扩展名、类型。适合“我记得文件名里有 report”“找上周改过的 PDF”这类问题。

### 按内容找：`locator_find`

在文本文件和 DSH 会话消息里搜正文，返回命中片段，以及来源信息。

- 文件命中带路径，直接打开或定位；
- 会话命中带 `sessionId` 和 `messageId`，可以跳回那次对话；
- 中文和英文子串都能搜，不要求分词。
- 内容索引默认**惰性启动**：插件启动时什么都不建，第一次搜内容（`locator_find` 或面板“搜内容”）才开始在后台构建，`contentLazy: false` 可恢复启动即建。重启后复用已有的内容库、先做一次增量刷新；只有库不存在、结构版本不兼容或损坏时才全量重建（先会话、后文件正文）。之后每 5 分钟再增量刷新一次，只重读 mtime 变化的文件/会话；也可以手动触发全量重建。

内容索引在后台构建，刚启动时可能只覆盖了一部分，工具和面板都会显示构建状态。默认只索引 4MB 以内的文本文件，最多 20 万个文件、最近 200 个会话，内容总量上限 2GB；这些都能在配置里改。

依赖和工具链目录（`node_modules`、`.cargo`、`.bun`、`.pnpm`、`site-packages`、`toolchain` 等）默认不读正文，否则内容预算会先被库代码吃满、你自己的文档反而搜不到；要调整就改 `contentExcludes`。

内容索引全程在宿主进程里跑，但读文件和 zstd 解压都是异步的，并且每约 8ms 就让出事件循环——实测 28.6MB 语料一次构建的最大事件循环阻塞从 968ms 降到 19ms，所以不会拖慢会话加载/切换。内容查询本身跑在 worker 线程里（只读连接），输入搜索时也不会卡住宿主。已删除的会话会随文件消失自动退出索引；已归档的会话默认不索引（`contentIncludeArchived: true` 才索引）；正在写入的会话会等它安静 `contentActiveSessionDelayMs` 后再索引，不会每轮刷新把整份日志重新解压一遍。

## Web 面板

![搜索面板：勾选“搜内容”后在文件正文中搜索，显示命中片段和路径](docs/assets/panel-zh.png)

在 Web GUI 里按 `Ctrl+Shift+F`，或者点侧栏底部的放大镜。

- 空查询按修改时间列出最近的条目；输入后 110ms 防抖，和工具用同一套语法。
- 点列头可以按名称、大小、修改时间、路径排序。
- 勾选“只看文件”“只看目录”过滤类型；勾选“搜内容”切换到正文/会话搜索。
- `↑`/`↓` 选择，`Enter` 复制路径，`Ctrl+O` 打开，`Ctrl+Enter` 把 `@"路径"` 插进输入框。
- 双击文件结果会在文件管理器里定位；双击会话结果会打开对应会话，并尝试滚动到命中的那句话。
- 面板文案跟随 `navigator.language`（中/英/西/葡/印地语）。

面板通过几个同源路由工作：`/dsh-locator/search`、`/dsh-locator/content`、`/dsh-locator/status`、`/dsh-locator/reveal`、`/dsh-locator/open`。不另起服务，也不占额外端口。

## 工具一览

| 工具 | 作用 |
|---|---|
| `locator_search` | 按文件名/路径搜索，支持 `ext:`、`size:`、`dm:`、`path:` 等过滤。 |
| `locator_find` | 按文件正文和会话内容搜索，返回片段与 `sessionId`/`messageId`。 |
| `locator_status` | 查看根目录、条目数、监听状态、内容索引进度和引擎版本。 |
| `locator_rebuild` | 后台重建文件名索引；新索引就绪前，搜索继续使用旧的。 |
| `locator_reindex` | 重建/刷新内容索引：默认增量，`full: true` 全量。 |
| `locator_export` | 把文件名索引导出成只读 SQLite，方便外部工具查询。 |

### 查询语法

```text
report                  文件名里同时包含这些词
"two words"             完整短语
*.go  ?                 通配符
ext:pdf,docx            按扩展名
ext:!tmp                排除某类扩展名
path:src                路径里包含 src
size:>10mb  1kb..2mb    按大小
dm:today  dm:thisweek   按修改日期
folder:  file:          只看目录 / 只看文件
!tmp                    排除包含 tmp 的
case:1  wholeword:1     区分大小写 / 全词匹配
```

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `roots` | 主目录 | 要索引的目录。 |
| `excludes` | `node_modules` 等 | 按目录名或路径跳过的 glob。 |
| `watch` | `true` | 是否监听文件系统变化。 |
| `refreshIntervalMs` | 30 分钟 | 没有原生监听时的重建周期。 |
| `scanWorkers` | 0 | 扫描并发；0 表示按 CPU 数。 |
| `windowsUsn` | `false` | Windows 上尝试 USN/MFT 快路径，需要管理员权限。 |
| `memoryLimitMB` | 0 | 引擎的 Go 软堆上限；0 表示交给 `GOMEMLIMIT`/`GOGC`。 |
| `contentIndex` | `true` | 是否构建文件正文/会话内容索引。 |
| `contentLazy` | `true` | 惰性构建：第一次搜内容时才建库；`false` 表示插件启动后就在后台建。 |
| `contentMaxFileBytes` | 1000000 | 单个文本文件最多读多少字节。 |
| `contentMaxTotalBytes` | 1000000000 | 内容库总量上限；0 表示不限制。 |
| `contentMaxFiles` | 200000 | 最多索引多少个文件；0 表示不限制。 |
| `contentMaxSessions` | 100 | 最多索引最近多少个会话；0 表示全部。 |
| `contentRefreshMs` | 300000 | 内容增量刷新周期；0 关闭自动刷新。 |
| `contentIncludeArchived` | `false` | 是否索引已归档的会话；默认不索引。 |
| `contentActiveSessionDelayMs` | 120000 | 会话日志安静多久后才索引；正在写的会话不重复解析。 |
| `contentSessionDirs` | `$DSH_HOME/sessions` | 额外的会话目录。 |
| `contentExcludes` | 依赖/工具链目录 | 内容索引跳过的路径片段或子串；文件名索引不受影响。 |
| `stateDir` | 系统缓存 | 快照和内容数据库的位置。 |

## 平台支持

| 平台 | 扫描 | 实时更新 |
|---|---|---|
| Linux | 并行遍历 | inotify，递归监听 |
| Windows | 并行遍历，或管理员下的 USN/MFT | `ReadDirectoryChangesW`；USN 模式下重启会补日志 |
| macOS | 并行遍历 | 发布版二进制用 FSEvents；`CGO_ENABLED=0` 构建回退到 kqueue |

Windows 的 USN 快路径默认关闭（`windowsUsn: true`）。它需要管理员权限和启用中的卷变更日志；任何一步失败都会回退到普通遍历，不会让搜索不可用。USN 扫描成功后会记下日志游标，重启时先补上停机期间的变更，再开始服务。

## 性能

- 约 124 万条记录：热查询 25–35ms；扫描进行中查询约 2ms。
- Windows CI 上 `C:\Windows` 16.4 万条用 USN 索引约 7.8 秒，查询 9.6ms。
- 导出 124 万行 SQLite：约 477MB，6.4 秒。
- 内容索引是后台任务，首次构建时间取决于文本文件数量和会话日志大小。

内容索引实测（同一台 WSL2 开发机，热缓存）：

| 语料 | 全量构建 | `content.db` | 增量刷新（无变化） | 查询 p50 / p95 |
|---|---|---|---|---|
| 2 万文件 / 40MB 正文 | 15.1 s | 71 MB | 0.17 s | 5 / 17 ms |
| 20 万文件 / 331MB 正文 | 31.5 s | 711 MB | 1.3 s | 5 / 156 ms |
| 真实主目录（17.7 万文档 / 2GB 上限） | 7.4 min | 5.99 GB | 2.9 s | — |

- 内容库体积大约是正文的 2–3 倍，磁盘要留余量；默认跳过依赖/工具链目录（`contentExcludes`），否则 2GB 预算会被库代码先吃光。
- 重启会复用已有的内容库做增量刷新（20 万文件语料实测 63.4 s → 4.6 s）；只有升级后首启、库损坏或结构版本不匹配时才全量重建。
- 撞到 `contentMaxTotalBytes` 时工具会明确提示 “content budget reached”，可以调大上限或收窄 `contentExcludes`。

## 设计

![架构：文件系统 → 扫描/监听 → 紧凑快照 → 查询引擎 → agent 工具 / Web 面板](docs/assets/architecture.svg)

- **文件名索引**：Go 引擎维护一份紧凑快照。记录只存名字在 arena 里的偏移和父记录 id，完整路径在返回结果时重建。
- **并行扫描**：目录读取协程消费有界队列，每个目录批量写入，保证父目录先于子目录。
- **查询**：解析一次查询，分片并行匹配，用有界堆选出前 `offset+limit` 条，不排序全部命中。
- **内容索引**：宿主侧 SQLite FTS5，trigram 分词，支持中文和子串；文件清单来自引擎已有的扫描结果，会话日志用 Node 自带的 zstd 解压。
- **跳转**：文件走 `/reveal` 和 `/open`；会话通过 `uiWorkspace.openSession(sessionId)` 打开，再在页面里定位命中文字。
- **协议**：引擎通过 stdio 上的 NDJSON 通信，不监听端口；Web 面板只走同源宿主路由。

## 从源码构建

需要 Node `^22.19 || >=24.9`、pnpm、Go 1.22+。

```sh
pnpm install
pnpm build
pnpm build:engine:all
pnpm check
```

Go 引擎在 `engine/` 下，测试用 `cd engine && go test ./...`。macOS 的 FSEvents 版本需要 cgo，由 macOS CI 构建。

## 限制

- 内容索引只处理文本类文件；PDF、Word、图片里的文字暂时不提取。
- 文件名索引不是文件系统驱动，只覆盖配置的根目录。
- Linux inotify 每个目录占一个描述符，目录特别多时可能碰到内核上限；插件会报警，快照仍然可用。
- 通过 WSL 写入 `/mnt/c` 的文件，Windows 端可能收不到通知，需要重建对应根目录。
- 会话内容来自本地日志；如果会话还没落盘，搜不到最新几条消息。
- macOS 的发布版二进制用 FSEvents；`CGO_ENABLED=0` 构建只有 kqueue，目录上限 4096。

## 安全与隐私

内容索引库与构建锁以 `0600` 创建、状态目录以 `0700` 创建，同机其他用户无法读取被索引的文档或会话正文。

索引完全在本地，不联网、不上传、不埋点。快照和内容数据库里有文件名、路径和正文，请把它们当作私有数据。插件不会修改、移动或删除被索引的文件。

## 许可证

Apache-2.0。

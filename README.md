<div align="center">

# 🔎 dsh-locator

**记得名字就搜名字，记得内容就搜内容；找到之后直接打开，或者跳回那次对话。**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的全盘文件搜索：自带索引，不装 Everything，不依赖 `es.exe`，Windows / macOS / Linux 用同一套工具和同一个面板。

[![npm version](https://img.shields.io/npm/v/dsh-locator)](https://www.npmjs.com/package/dsh-locator)
[![npm downloads](https://img.shields.io/npm/dm/dsh-locator)](https://www.npmjs.com/package/dsh-locator)
[![CI](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml/badge.svg)](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/v/tag/PerryLink/dsh-locator?label=version)](https://github.com/PerryLink/dsh-locator/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)
[![Awesome DSH](https://img.shields.io/badge/awesome--dsh--plugin-listed-2ea44f)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](#版本与兼容性)
[![Gitee](https://img.shields.io/badge/Gitee-mirror-c71d23?logo=gitee)](https://gitee.com/perrylink/dsh-locator)
[![GitCode](https://img.shields.io/badge/GitCode-mirror-1f6feb)](https://gitcode.com/PerryLink/dsh-locator)

[简体中文](README.md) · [English](README.en.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

```sh
dsh plugin --profile web add dsh-locator
```

</div>

> 官方仓库是 [GitHub `PerryLink/dsh-locator`](https://github.com/PerryLink/dsh-locator)，Gitee 和 GitCode 是自动同步的镜像，GitHub 为准。插件属于 [DSH 插件家族](https://github.com/PerryLink)，Apache-2.0；已被 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录。如果它帮你省了时间，点个 ⭐ 就行。

## 目录

- [30 秒了解](#30-秒了解)
- [和 Everything / Spotlight / grep 有什么不同](#和-everything--spotlight--grep-有什么不同)
- [安装](#安装)
- [第一次运行](#第一次运行)
- [两种搜索](#两种搜索)
- [Web 面板](#web-面板)
- [工具一览](#工具一览)
- [查询语法](#查询语法)
- [配置](#配置)
- [性能与资源](#性能与资源)
- [平台支持](#平台支持)
- [故障排查](#故障排查)
- [从源码构建](#从源码构建)
- [设计](#设计)
- [限制](#限制)
- [安全与隐私](#安全与隐私)
- [版本与兼容性](#版本与兼容性)
- [路线图](#路线图)
- [许可证](#许可证)

## 30 秒了解

找文件通常分两种情况：

- **记得名字，不记得位置。** `glob`/`grep` 每次都要重新遍历；文件在 `~/Downloads` 还好，只记得半个文件名时就很难受。
- **记得某句话、某个结论、某段代码，想不起在哪个文件、哪次对话里。** 这时只搜文件名没有用，而 DSH 的会话日志本身也是一等公民。

`dsh-locator` 把两件事放进同一个插件：

| 能力 | 怎么用 |
|---|---|
| 文件名 / 路径搜索 | `locator_search`，或面板默认模式 |
| 文件正文搜索 | `locator_find`，或面板的“内容”范围（默认开启） |
| DSH 会话内容搜索 | 同上；命中带 `sessionId` / `messageId`，可直接跳回那次对话 |
| 打开 / 定位 | 工具返回路径；面板双击在文件管理器定位，`Ctrl+O` 打开，`Ctrl+Enter` 把 `@"路径"` 插进输入框 |
| 外部工具消费 | `locator_export` 导出只读 SQLite |

索引完全在本地：不联网、不上传、不埋点；插件不会修改、移动或删除被索引的文件。

## 和 Everything / Spotlight / grep 有什么不同

| | dsh-locator | Everything | Spotlight | `glob` / `grep` |
|---|---|---|---|---|
| 平台 | Windows / macOS / Linux / WSL | Windows | macOS | 跨平台 |
| 索引形态 | 常驻索引（自建） | 常驻索引（NTFS USN） | 系统元数据/内容索引 | 每次调用重新遍历 |
| 按正文搜索 | 文本文件 + DSH 会话消息 | 默认只搜文件名 | 支持，可用性因系统而异 | 支持，但无索引 |
| 会话跳转 | 命中带 `sessionId` / `messageId`，可跳回 | 无 | 无 | 无 |
| 给 agent 用 | 6 个工具，查询语法一致 | 需另装 CLI/服务 | 需另接脚本 | 原生工具，无持久索引 |
| Windows 速度 | 接近 Everything（USN 可选） | 最快最轻 | 不适用 | 慢于索引方案 |

一句话：Everything 的**思路**（常驻索引 + 结构化查询）被独立实现成了跨平台版本，并补上了 DSH 会话这一层；不是 Everything 的封装。

## 安装

```sh
# npm（推荐）
dsh plugin --profile web add dsh-locator

# 指定版本
dsh plugin --profile web add dsh-locator@0.7.6

# GitHub 主仓
dsh plugin --profile web add github:PerryLink/dsh-locator

# 从源码
pnpm install
pnpm build
pnpm build:engine        # 当前平台的 Go 引擎
dsh plugin --profile web add /绝对路径/dsh-locator

# 从 tarball（npm pack 产物；替换成实际版本号）
npm pack
dsh plugin --profile web add /绝对路径/dsh-locator-0.7.6.tgz
```

- 包里已经带了六个平台的预编译引擎：`linux-x64`、`linux-arm64`、`win32-x64`、`win32-arm64`、`darwin-x64`、`darwin-arm64`，装完不需要本机 Go。
- 国内 npm 镜像偶尔滞后：如果 `latest` 不是新版本，加 `--registry=https://registry.npmjs.org` 再装。
- 装进**正在运行**的 Web profile 后，刷新一下页面（F5）：宿主工具通常会热挂载，但浏览器面板是页面加载时从 boot graph 里取的。headless / TUI profile 只有工具，没有面板。
- 升级：`dsh plugin --profile web add dsh-locator@latest`，然后 F5；内容库结构变化时只重建一次。
- 卸载：`dsh plugin --profile web remove dsh-locator`；想临时关掉但保留配置，设 `enabled: false`。

## 第一次运行

默认索引你的主目录，快照和内容库放在系统缓存目录：

| 平台 | 默认位置 |
|---|---|
| Windows | `%LOCALAPPDATA%\dsh-locator` |
| macOS | `~/Library/Application Support/dsh-locator` |
| Linux | `$XDG_CACHE_HOME/dsh-locator` 或 `~/.cache/dsh-locator` |

第一次扫描要读盘；之后启动直接加载快照。扫描期间搜索照常可用：返回已索引的部分，并带 `indexing: true`，面板底栏也会提示“索引构建中”。

默认跳过 `node_modules`、`.git`、`.hg`、`.svn`、`.cache`、`__pycache__`、`.venv`、`venv`、`.next`（按名称匹配，`excludes` 可改）。

可以这样试：

```text
帮我找上周改过的 PDF
哪里讨论过 “contentRefreshMs”？
看看哪个会话里定过这个方案
```

## 两种搜索

### 按名字找：`locator_search`

Everything 风格的查询语法，返回路径、大小、修改时间、扩展名、类型。适合“我记得文件名里有 report”“找上周改过的 PDF”“找 50MB 以上的视频”这类问题。

查询语法见[下方](#查询语法)。排序、分页、`limit`/`offset` 都由宿主引擎完成，151 万条记录的常见查询在几十毫秒内。

### 按内容找：`locator_find`

在文本文件和 DSH 会话消息里搜正文，返回命中片段和来源：

- 文件命中带路径，可以直接打开或定位；
- 会话命中带 `sessionId` 和 `messageId`，可以跳回那次对话并尽量滚动到命中的那句话；
- 中文和英文子串都能搜（trigram 分词），不要求分词正确。

内容索引的行为：

- **惰性启动**：插件启动时什么都不建；第一次搜内容（`locator_find` 或面板的“内容”范围）才开始后台构建，`contentLazy: false` 可恢复启动即建。第一次查询会立刻返回 `building: true`，不会让你干等或误以为没结果。
- **重启复用**：有内容库时只做一次增量刷新，不重读全部正文；只有库不存在、结构版本不兼容、上次构建没完成或损坏时才全量重建（先会话、后文件正文）。
- **增量刷新**：默认每 5 分钟检查一次，只重读 mtime 变化的文件/会话；`contentRefreshMs` 可调，0 关闭。
- **归档与活动会话**：已归档会话默认不索引（`contentIncludeArchived: true` 才索引）；正在写入的会话等它安静 `contentActiveSessionDelayMs`（默认 2 分钟）后再索引，不会每轮刷新重解压整份日志；已删除的会话随文件消失自动退出索引。
- **预算与截断**：默认单文件最多 1MB、文件数最多 20 万、内容总量最多 1GB、最近 100 个会话。撞到总额上限时按扫描顺序保留先到的文件，`locator_find` 的输出会提示 `content budget reached`，HTTP 状态里是 `truncated: true`；调大 `contentMaxTotalBytes` 或收窄 `contentExcludes` 即可。
- **依赖目录不读正文**：`node_modules`、`.cargo`、`.bun`、`.pnpm`、`site-packages`、`toolchain` 等默认被 `contentExcludes` 跳过，否则预算会先被库代码吃满；文件名索引不受影响。

内容索引跑在宿主进程里，但文件读取和 zstd 解压都是异步的，构建循环每约 8ms 让出一次事件循环（28.6MB 语料实测最大事件循环阻塞从 968ms 降到约 20ms），所以不会拖慢会话加载/切换。内容**查询**在 worker 线程里用只读连接执行，常见词约 100ms 量级、生僻词几毫秒，不阻塞宿主。

## Web 面板

在 Web GUI 里按 `Ctrl+Shift+F`，或者点侧栏底部的放大镜。面板通过同源路由工作（`search`、`content`、`content/rebuild`、`combined`、`status`、`reveal`、`open`），不另起服务、不占额外端口。

- **默认同时搜索三个范围**：内容（正文 + 会话）、文件、目录，三个勾选默认全部打开；取消任一勾选即可缩小范围。结果按“内容 → 文件 → 目录”分组，组头显示数量；内容按相关度排序，文件/目录按排序菜单。
- **双击或 `Enter` 激活**：会话命中打开对应会话，并把命中的词用半透明琥珀色高亮（随滚动跟随、自动居中、`Esc` 清除）；文件/目录在文件管理器中定位。`Ctrl+Shift+C` 复制路径，`Ctrl+O` 打开，`Ctrl+Enter` 插入 `@file`，`Alt+1–3` 切换范围。
- 内容查询至少需要 2 个字符；空查询和 1 个字符的查询不会启动内容索引构建。构建期间内容组显示进度，文件名/目录结果立即返回；勾选状态会记住。
- 键盘：`↑`/`↓`、`Home`/`End`、`PageUp`/`PageDown` 移动，`Enter` 激活，`Esc` 关闭；对话框有焦点陷阱并在关闭时还原。面板文案跟随 `navigator.language`（中/英/西/葡/印地语）。


## 工具一览

| 工具 | 作用 |
|---|---|
| `locator_search` | 按文件名/路径搜索，支持 `ext:`、`size:`、`dm:`、`path:` 等过滤与排序分页。 |
| `locator_find` | 按文件正文和会话内容搜索，返回片段与 `sessionId`/`messageId`，并带内容索引状态。 |
| `locator_status` | 查看根目录、名称索引条目数、监听状态、状态目录和引擎版本（内容索引进度由 `locator_find` / 面板报告）。 |
| `locator_rebuild` | 后台重建名称索引；新索引就绪前搜索继续使用旧的。 |
| `locator_reindex` | 重建/刷新内容索引：默认增量，`full: true` 全量。 |
| `locator_export` | 把名称索引导出成只读 SQLite，方便外部工具查询。 |

## 查询语法

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

在 profile 的 `cordis.patch.yml` 里覆盖，例如：

```yaml
- id: dsh-locator
  name: dsh-locator
  config:
    roots: ['/home/me/Documents', '/home/me/notes']
    contentMaxTotalBytes: 2000000000
    contentExcludes: ['node_modules', '.git', '.cargo', 'site-packages']
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时不挂工具、不启动引擎。 |
| `roots` | 主目录 | 要索引的目录，可多选。 |
| `excludes` | `node_modules` 等 | 名称索引跳过的目录名/路径 glob。 |
| `watch` | `true` | 是否监听文件系统变化。 |
| `refreshIntervalMs` | 1800000 | 没有原生监听时的重建周期（kqueue 回退或监听失败时用到）。 |
| `scanWorkers` | 0 | 扫描并发；0 表示按 CPU 数。 |
| `windowsUsn` | `false` | Windows 上尝试 USN/MFT 快路径，需要管理员权限。 |
| `memoryLimitMB` | 0 | 引擎的 Go 软堆上限；0 交给 `GOMEMLIMIT`/`GOGC`。 |
| `contentIndex` | `true` | 是否构建正文/会话内容索引；`false` 时只保留名称搜索，开销接近 0。 |
| `contentLazy` | `true` | 惰性构建：第一次搜内容时才建库；`false` 表示启动后就在后台建。 |
| `contentMaxFileBytes` | 1000000 | 单个文本文件最多读多少字节。 |
| `contentMaxTotalBytes` | 1000000000 | 内容库总量上限；0 表示不限制。 |
| `contentMaxFiles` | 200000 | 最多索引多少个文件；0 表示不限制。 |
| `contentMaxSessions` | 100 | 最多索引最近多少个会话；0 表示全部。 |
| `contentRefreshMs` | 300000 | 内容增量刷新周期；0 关闭自动刷新。 |
| `contentIncludeArchived` | `false` | 是否索引已归档的会话。 |
| `contentActiveSessionDelayMs` | 120000 | 会话日志安静多久后才索引。 |
| `contentSessionDirs` | `$DSH_HOME/sessions` | 额外的会话目录。 |
| `contentExcludes` | 依赖/工具链目录 | 内容索引跳过的路径片段/子串；名称索引不受影响。 |
| `stateDir` | 系统缓存 | 快照和内容库的位置；多个 DSH 进程请用不同目录。 |

> `binaryPath`、`maxResults`、`startupTimeoutMs`、`requestTimeoutMs` 也支持，分别用于自定义引擎、单页上限和超时；一般不需要改。

## 性能与资源

以下数字来自开发机（WSL2，Linux，热页缓存）和真实主目录；你的机器会因磁盘、文件数、缓存和 GC 状态而不同。

**名称索引**

| 项目 | 实测 |
|---|---|
| 冷启动扫描 | 约 151 万条目 / 11–12 秒 |
| 快照体积 | 约 171 MB（151 万条目） |
| 热查询（`locator_search`） | 常见查询 6–25ms；`path:` 前缀扫描约 70ms |
| 查询时索引重建 | 旧索引继续服务，新索引就绪后切换 |
| 扫描峰值内存 | 数百 MB 量级；引擎独立子进程，可用 `memoryLimitMB` / `GOMEMLIMIT` 限制 |

**内容索引**（真实主目录，1GB 预算上限）

| 项目 | 实测（0.7.x，真实主目录） |
|---|---|
| 覆盖 | 约 9.6 万个文本文件 / 95 个会话 / 1,050 条消息 |
| 全量重建 | 约 3.5 分钟（后台、不阻塞宿主；期间宿主 p95 14ms / max 115ms） |
| 无变化增量刷新 | 约 12 秒（主要花在引擎 151 万条目的 dump 上） |
| 空闲宿主延迟 | p50 2ms / p95 3ms / max 6ms |
| 内容库体积 | 约 3.1 GB（约为正文预算的 3 倍） |
| 内容查询 | 常见词约 100ms、生僻词几毫秒（worker 线程，不阻塞宿主） |

**怎么更省**

- 只要 Everything 式文件名搜索：`contentIndex: false`，内容开销归零。
- 想保留内容但更省磁盘：调小 `contentMaxTotalBytes`（如 256000000）、`contentMaxFileBytes`，或把 `contentRefreshMs` 调大。
- 想覆盖更多文件：调大 `contentMaxTotalBytes` / `contentMaxFiles`，并确认 `contentExcludes` 没把真实文档目录排除掉。
- 注意：内容库是缓存，删掉 `stateDir` 后会自动重建，不会影响源文件。

## 平台支持

| 平台 | 扫描 | 实时更新 |
|---|---|---|
| Linux | 并行遍历 | inotify，递归监听 |
| Windows | 并行遍历，或管理员下的 USN/MFT | `ReadDirectoryChangesW`；USN 模式下重启会补日志 |
| macOS | 并行遍历 | 发布版二进制用 FSEvents；`CGO_ENABLED=0` 构建回退到 kqueue（目录上限 4096） |

### Windows 与 USN 日志

USN/MFT 快路径默认关闭（`windowsUsn: true`）：需要管理员权限和启用中的卷变更日志，任何一步失败都会回退到普通遍历，不会让搜索不可用。成功扫描后会记下日志游标（`usn-state.json`），重启时先补上停机期间的变更。

它在 Windows CI runner 上做过端到端验证：读取 134 万条 MFT 记录、解析 134 万条路径；`C:\Windows` 下 16.4 万条目用 USN 索引约 7.8 秒、查询 9.6ms。也可以手动探测：

```powershell
# 管理员 PowerShell
& ".\bin\win32-x64\indexd.exe" usn-probe --volume C: --root "C:\Windows" --limit 5 --journal 5
```

USN 记录本身不带大小和修改时间：结果的名字/路径是准确的，`locator_status` 会标记这种索引为 `USN`，返回结果页时再 stat 补齐大小和日期；`size:`/`dm:` 过滤在整库上仍是近似值，直到跑一次元数据补全。日志被覆盖、删除或卷不支持时，自动回退可移植遍历。

## 故障排查

**装完面板没出现？**
刷新页面（F5）；确认装的是 `web` profile，且面板从 boot graph 加载。headless/TUI profile 本来就没有面板。

**刚创建的文件搜不到？**
监听可能还没收到通知（WSL 写入 `/mnt/c`、网络盘、部分容器的 overlay 常见）。等几秒，或对相应根目录执行 `locator_rebuild`。USN 模式重启后会补日志。

**搜内容没结果？**
先看 `locator_find` 返回里的 `building`：第一次搜索会触发惰性构建，构建期间结果可能不全，面板会自动重查。再确认文件扩展名在文本类型内、大小没超过 `contentMaxFileBytes`、没被 `contentExcludes` 排除、会话没归档（归档默认不索引）。

**内容库很大 / 磁盘涨得快？**
见[性能与资源](#性能与资源)：调小预算或关闭 `contentIndex`；删除 `stateDir` 会触发重建。

**`inotify` 相关警告？**
目录太多时会碰到内核 watch 上限；索引仍然可用，只是变化依赖定时重建。可调大 `fs.inotify.max_user_watches`，或减少 `roots`。

**升级后行为变了？**
`dsh plugin --profile web add dsh-locator@latest` 后 F5；内容库结构变化时只重建一次。更新记录见 [CHANGELOG](CHANGELOG.md)。

## 从源码构建

需要 Node `^22.19 || >=24.9`、pnpm、Go 1.22+。

```sh
pnpm install
pnpm build
pnpm build:engine:all    # 六个平台的引擎
pnpm check               # typecheck + 测试 + 打包/安装校验
```

Go 引擎在 `engine/` 下，测试用 `cd engine && go test ./...`。macOS 的 FSEvents 版本需要 cgo，由 macOS CI 构建。Node 测试在 Linux、Windows、macOS 三个平台的 CI 上运行。

## 设计

![架构：文件系统 → 扫描/监听 → 紧凑快照 → 查询引擎 → agent 工具 / Web 面板](docs/assets/architecture.svg)

- **名称索引**：Go 引擎维护紧凑快照；记录只存名字在 arena 里的偏移和父记录 id，完整路径在返回结果时重建；路径表用开放寻址（`id+1` 槽，约 12 字节/条）替代 `map[string]int32`。
- **并行扫描**：目录读取协程消费有界队列，每个目录批量写入，保证父目录先于子目录；队列满时退化为就地扫描，不阻塞。
- **查询**：解析一次查询，分片并行匹配，用有界最大堆选出前 `offset+limit` 条，不排序全部命中。
- **内容索引**：宿主侧 SQLite FTS5 + trigram 分词，支持中文和子串；文件清单来自引擎已有扫描结果，会话日志用 Node 自带 zstd 解压；查询在 worker 线程执行。
- **持久化**：快照先写临时文件再原子重命名；generation 计数让守护进程只在索引变化时自动保存；删除量超过阈值时压缩墓碑。
- **跳转**：文件走 `/reveal` 和 `/open`；会话通过 `uiWorkspace.openSession(sessionId)` 打开，再在页面里定位命中文字。
- **协议**：引擎通过 stdio 上的 NDJSON 通信，不监听端口；Web 面板只走同源宿主路由。

## 限制

- 内容索引只处理文本类文件；PDF、Word、图片里的文字暂不提取。
- 内容预算按扫描顺序消耗，不是按文件重要性排序；达到上限后后面的文件不可搜（`truncated` 为 true）。
- 名称索引不是文件系统驱动，只覆盖配置的根目录。
- Linux inotify 每个目录占一个描述符，目录特别多时可能碰到内核上限；插件会报警，快照仍然可用。
- 通过 WSL 写入 `/mnt/c` 的文件，Windows 端可能收不到通知，需要重建对应根目录。
- 网络盘只在能作为普通目录访问时才会被扫描，没有 SMB 专用的变更流。
- 会话内容来自本地日志；如果会话还没落盘，搜不到最新几条消息。
- 两个 DSH 进程共享同一个 `stateDir` 时，构建锁只能串行化写入；建议各用各的缓存目录。
- macOS 的发布版二进制用 FSEvents；`CGO_ENABLED=0` 构建只有 kqueue，目录上限 4096，且内容变更依赖定时重建。

- 文件正文命中目前只在文件管理器里定位（在 DSH 内按行预览是下一步）；assistant 消息通过 `turn:step` 节点键精确定位，找不到时才退回短语匹配。升级到 0.8.1 会因新增节点键字段重建一次内容库。
- 会话内高亮依赖 CSS Custom Highlight API；不支持它的旧浏览器会退化为整行描边。

## 安全与隐私

- 索引完全在本地：不联网、不上传、不埋点；插件不会修改、移动或删除被索引的文件。
- 内容库与构建锁以 `0600` 创建、状态目录以 `0700` 创建，同机其他用户无法读取被索引的文档或会话正文。
- 快照和内容库里有文件名、路径和正文，请当作私有数据；删除 `stateDir` 即可清空。
- 建议给同时运行的多个 DSH 进程配置不同的 `stateDir`。

## 版本与兼容性

- Node：`^22.19.0 || >=24.9.0`；DSH：`>=0.2.1-rc.2 <0.3.0`（见 `package.json` 的 `engines`）。
- 发布走 GitHub Actions provenance，npm 上的包可验证来源；Gitee / GitCode 由 mirror workflow 自动同步。
- 更新记录：[CHANGELOG.md](CHANGELOG.md)；问题与建议：[Issues](https://github.com/PerryLink/dsh-locator/issues)。

## 路线图

不是承诺，只是当前方向：

1. Electron 桌面运行时在真实 Windows 安装上的验证。
2. 面板里的预览和结果分组。
3. Windows on ARM / Linux ARM 的运行时覆盖。
4. 更大的索引：小写名字 arena 与 trigram 预筛选。
5. 快照增量压缩与按根目录的 journal。

## 许可证

Apache-2.0。

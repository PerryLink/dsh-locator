# dsh-locator

中文 | [English](README.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的全盘毫秒级文件搜索，**自建索引**：不装 Everything、不用 `es.exe`、不需要 Everything 服务。

`dsh-locator` 扫描你指定的目录，把文件名、路径、大小、修改时间写进一个紧凑的快照；之后按文件系统事件增量更新，百万条目上的名字/路径查询在几十毫秒内返回。模型拿到 `locator_search`、`locator_status`、`locator_rebuild` 三个工具；人则有一个 Web GUI 全局**搜索面板**（`Ctrl+Shift+F`，或侧栏底部的放大镜），支持列排序、过滤、键盘操作和一键复制路径。

思路借鉴 Everything：常驻的文件名索引、带 `ext:` / `size:` / `dm:` 过滤的查询语法、直接消费文件系统的变更流。实现是独立的，并且跨平台。

## 为什么再做一个

`glob` / `grep` 每次调用都要遍历工作区——知道目录时很快，只记得名字的一部分时很慢。Everything 在 Windows 上很好用，但它只支持 Windows；包一层 Everything 仍然覆盖不了 macOS、Linux、WSL 和远程主机。`dsh-locator` 自己拥有索引，所以同一套工具在哪都能用。

## 安装

```sh
# npm（发布后）
dsh plugin --profile web add dsh-locator

# 从源码
pnpm install
pnpm build            # TypeScript 插件
pnpm build:engine     # 本机平台的 Go 引擎
dsh plugin --profile web add /绝对路径/dsh-locator
```

npm 包内置 `linux-x64`、`linux-arm64`、`win32-x64`、`win32-arm64`、`darwin-x64`、`darwin-arm64` 六个平台的预编译引擎。

## 首次运行

首次挂载时引擎扫描配置的根目录（默认：用户主目录），快照写到平台缓存目录：

| 平台 | 默认状态目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\dsh-locator` |
| macOS | `~/Library/Application Support/dsh-locator` |
| Linux | `$XDG_CACHE_HOME/dsh-locator` 或 `~/.cache/dsh-locator` |

大目录首次扫描会读盘；之后启动直接加载快照。默认排除 `node_modules`、`.git`、`.svn`、`.hg`、`.cache`、`__pycache__`、`.venv`、`venv`、`.next`。

## Web 搜索面板

在 Web GUI 里按 `Ctrl+Shift+F`，或点侧栏底部的放大镜。浮层通过两个同源宿主路由（`POST /dsh-locator/search`、`POST /dsh-locator/status`）查询同一个索引，不另起服务、不加端口。

* 空查询按修改时间倒序列出最近条目；输入后 110 ms 防抖，走和工具完全相同的 Everything 风格语法。
* 点列头按名称、大小、修改时间、路径排序，再点切换升降序。
* `只看文件` / `只看目录` 过滤类型；底栏显示命中数、分页上限和查询耗时。
* `↑`/`↓` 选择，`Enter` 复制选中路径，`Esc` 关闭。
* 面板是可选的：没有 Web server 的 profile 不会挂载它，三个工具照常工作。

## 工具

| 工具 | 作用 |
|---|---|
| `locator_search` | 查询索引，返回路径、大小、修改时间、扩展名、类型，并给出 total/truncated，截断页面不会被当成完整结果。 |
| `locator_status` | 根目录、条目数、监听状态、状态目录与引擎路径。用来解释覆盖范围或排查结果过期。 |
| `locator_rebuild` | 后台重建索引；新索引就绪前，搜索继续用旧索引。 |

### 查询语法

裸词是文件名子串，多个词取 AND；可叠加 Everything 风格过滤：

| 例子 | 含义 |
|---|---|
| `report` | 文件名含 `report` |
| `report ext:pdf` | 且扩展名是 `pdf` |
| `ext:ts,js` / `ext:!tmp` | 包含/排除扩展名 |
| `*.sln` / `?ata` | `*`、`?` 通配 |
| `"annual report"` | 带空格的短语 |
| `!archive` | 取反 |
| `path:src` | 完整路径含 `src` |
| `size:>10mb` / `size:1kb..2mb` | 大小比较 |
| `dm:today` / `dm:thisweek` / `dm:2026-01-01` | 修改时间 |
| `folder:` / `file:` | 只看目录 / 只看文件 |
| `case:1` / `wholeword:1` | 区分大小写 / 全词匹配 |

`locator_search` 还接受 `sort`（`name`、`path`、`size`、`mtime`、`ext`）、`desc`、`offset`、`limit`、`regex`、`caseSensitive`、`wholeWord`。

## 配置

所有字段都是 Schemastery 配置；改 profile patch 里的 `dsh-locator` 条目，或改包内 `cordis.patch.yml` 的默认值。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关掉后不挂工具、不起引擎。 |
| `roots` | `[]` | 要索引的目录；空 = 用户主目录。 |
| `excludes` | 开发/缓存目录 | 扫描与监听都跳过的基础名 glob。 |
| `watch` | `true` | 启用原生文件系统通知。 |
| `refreshIntervalMs` | `1800000` | 没有原生监听时（目前是 macOS）的重建周期；0 关闭。 |
| `scanWorkers` | `0` | 扫描时的目录读取并发；0 = CPU 数。 |
| `stateDir` | `''` | 快照目录；空 = 平台缓存目录。 |
| `binaryPath` | `''` | 覆盖内置引擎路径（开发用）。 |
| `maxResults` | `100` | 单页硬上限。 |
| `startupTimeoutMs` | `120000` | 冷启动建索引的容忍时间。 |
| `requestTimeoutMs` | `15000` | 单次请求超时。 |

主目录太大就收窄 `roots`：`~/Documents`、`~/Downloads` 加一两棵代码树，通常比全盘更划算。

## 平台支持

| 平台 | 扫描 + 快照 | 实时更新 | 说明 |
|---|---|---|---|
| Linux | 是 | inotify，递归 | 每个目录一个 watch；极大目录树可能撞 `fs.inotify.max_user_watches`。 |
| Windows | 是 | `ReadDirectoryChangesW`，递归 | 不需要管理员，不需要 Everything。WSL 写 `/mnt/<盘>` 可能不产生 Windows 通知，用 `locator_rebuild` 补。 |
| macOS | 是 | kqueue vnode 监听（最多 4,096 个目录）+ 周期性重建 | 目录级事件覆盖新建、删除、重命名；文件内容变化不产生 vnode 事件，大小/时间由 `refreshIntervalMs` 或 `locator_rebuild` 刷新。 |

引擎是纯 Go、无 cgo，一台机器交叉编译全部平台；运行时从不需要管理员权限。

### Windows 与 USN 日志

Everything 之所以首次索引近乎瞬时，是因为它通过 USN 日志直接读 NTFS 主文件表。`dsh-locator` v0.1 刻意先做可移植的目录遍历 + 变更通知：不需要服务、不需要 UAC、任何文件系统都能用。USN/MFT 枚举会作为可选快路径加入路线图（需要进程对卷持有 `GENERIC_READ`，通常意味着管理员权限），可移植路径始终保留为回退。

## 性能

开发者 WSL2 机器、Linux 主目录实测（1,234,757 条目：1,128,288 文件、106,469 目录，排除 `node_modules`、`.git`、`.cache`、`.venv`）：

| 指标 | 结果 |
|---|---|
| 冷扫描（未命中页缓存） | 50.3 s |
| 热扫描（页缓存命中，8 个读取协程） | 6.5 s（约 190k 条目/秒） |
| 快照大小 | 133 MB |
| 扫描峰值 RSS | 约 490 MB |
| `locator_search "report"`（981 命中） | 34 ms |
| `locator_search "package.json"`（1,287 命中） | 25 ms |
| 查询进程 RSS（120 万条目） | 约 197 MB |
| 小目录树（3.9 万条目）扫描 | 0.47 s |

查询阶段按记录分片并行；冷扫描慢在磁盘。数字随文件系统、缓存和 CPU 变化。

## 设计

```
DeepSeek Harness
  └─ dsh-locator（TypeScript 插件）
       ├─ locator_search / locator_status / locator_rebuild
       ├─ client.js：Ctrl+Shift+F 浮层（shell.overlay slot）
       ├─ POST /dsh-locator/{search,status}（同源、仅回环宿主）
       └─ 子进程：indexd serve（Go，stdio 上的 NDJSON）
            ├─ 扫描器：递归遍历、排除、进度
            ├─ 索引：名字 arena + 定长记录 + 开放寻址路径表
            ├─ 查询：解析、匹配、Top-K 选择、排序、分页
            ├─ 监听：inotify（Linux）/ ReadDirectoryChangesW（Windows）
            └─ 快照：单文件、原子重命名
```

* **并行扫描**：目录读取协程消费一个有界任务队列，每个目录批量调用 `AddBatch` 落库，保证父记录先于子记录；队列满时改为在当前协程内联扫描，永不阻塞。
* **内存布局**：记录只存名字在 arena 中的偏移/长度和父记录 id，完整路径只在结果页和 `path:` 过滤时重建，避免每个文件一个字符串头。
* **路径表**：开放寻址、槽位存 `id+1`，每条约 12 字节，而 `map[string]int32` 约 50 字节。
* **查询引擎**：裸词与过滤只编译一次，分片并行匹配，再用有界大顶堆选出 `offset+limit` 行，不排序上百万命中。
* **持久化**：先写临时文件再重命名；generation 计数让守护进程只在索引变化时自动保存；墓碑超过阈值后压缩。
* **协议**：stdio 上一行一个 JSON 请求/响应，另有 `scan`、`stats`、`warning`、`error`、`rebuilt` 事件。不开端口、无网络监听面。
* **只读**：引擎只读元数据，绝不修改被索引的文件。

## 从源码构建

需要 Node `^22.19 || >=24.9`、pnpm、Go 1.22+。

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm build:engine:all   # 或 build:engine 只构建本机
```

引擎是 `engine/` 下的独立 Go module；`cd engine && go test ./...`。

## v0.1 的限制

* 只索引文件名、路径、大小、修改时间，**不索引内容**；内容检索请用 `grep`。
* 只覆盖配置的根目录，不是文件系统驱动。
* Linux inotify 每个目录一个描述符；几十万目录的主目录可能超过内核上限。插件会报警告，快照仍可用，重建可以补齐。
* WSL 写 `/mnt/c` 可能不产生 Windows 侧通知（Windows 监听看不到 9p 写入方的变更流），需显式重建。
* 网络共享只有在能当普通目录访问时才会被扫描；没有 SMB 专用变更源。
* macOS 是目录级监听（kqueue，每目录一个描述符，上限 4,096）：新建/删除/重命名即时生效；文件内容变化靠周期重建。无上限、文件级的 FSEvents 仍在路线图。
* 还没有 USN/MFT 快速枚举（见上）。

## 路线图

1. macOS FSEvents 监听。
2. 有卷读取权限时的 Windows USN/MFT 快速枚举；停机后按 USN 日志补齐。
3. 专用 Web GUI 面板（表格、列排序、过滤、预览、插入为 `@file`）。
4. 可选的小写名字 arena 与 trigram 预筛。
5. 增量快照压缩与按根目录的日志。

## 安全与隐私

索引完全本地：不联网、不埋点、不上传。快照里是文件名和路径，请把状态目录当私有数据；介意的话别把它纳入备份。插件绝不修改、移动或删除被索引的文件。

## 许可证

Apache-2.0。

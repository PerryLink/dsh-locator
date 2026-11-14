window.__ModuleLoader__.load({
  id: 'dsh-locator',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    // ── shared overlay state ────────────────────────────────────────────────
    function createStore() {
      const listeners = new Set()
      let open = false
      return {
        isOpen: () => open,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          if (next === open) return
          open = next
          for (const listener of listeners) listener()
        },
        toggle() {
          this.set(!open)
        },
      }
    }
    const store = createStore()

    // Transient feedback used after the panel closes (a jump keeps the panel
    // closed, so the panel-local toast would never be seen).
    function createNoticeStore() {
      const listeners = new Set()
      let text = ''
      let timer = 0
      return {
        get: () => text,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        show(next) {
          text = next
          for (const listener of listeners) listener()
          clearTimeout(timer)
          timer = setTimeout(() => { text = ''; for (const listener of listeners) listener() }, 3200)
        },
      }
    }
    const notices = createNoticeStore()
    function showNotice(text) { notices.show(text) }
    function Notice() {
      const text = useSyncExternalStore(notices.subscribe, notices.get, notices.get)
      return text === '' ? null : h('div', { className: 'dsh-locator-notice', role: 'status' }, text)
    }

    function useOpen() {
      return useSyncExternalStore(store.subscribe, store.isOpen, store.isOpen)
    }

    // ── styles ──────────────────────────────────────────────────────────────
    const NS = 'dsh-locator'
    const CSS = `
.dsh-locator-overlay{position:fixed;inset:0;z-index:80;display:flex;align-items:flex-start;justify-content:center;
  padding:max(9vh,64px) 16px 16px;background:var(--dsw-alias-bg-mask-1,rgba(15,17,21,.38));color-scheme:light dark}
.dsh-locator-panel{display:flex;flex-direction:column;width:min(920px,94vw);max-height:min(76vh,720px);overflow:hidden;
  border-radius:var(--dsw-radius-lg,14px);border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.28));
  background:var(--dsw-alias-bg-base,#fff);box-shadow:0 24px 64px rgba(0,0,0,.28);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
  animation:dsh-locator-in 120ms ease-out}
@keyframes dsh-locator-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.dsh-locator-panel{animation:none}}
.dsh-locator-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.2))}
.dsh-locator-glyph{font-size:15px;opacity:.7}
.dsh-locator-input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:14px;padding:2px 0}
.dsh-locator-kbd{border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.35));border-radius:6px;padding:1px 6px;font-size:11px;opacity:.6;white-space:nowrap}
.dsh-locator-close{border:0;background:transparent;color:inherit;opacity:.55;cursor:pointer;font-size:16px;padding:2px 4px;border-radius:6px}
.dsh-locator-close:hover{opacity:.9;background:var(--dsw-alias-interactive-bg-hover,rgba(120,125,135,.12))}
.dsh-locator-bar{display:flex;align-items:center;gap:12px;padding:7px 14px;border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.16));
  font-size:12px;flex-wrap:wrap}
.dsh-locator-check{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;white-space:nowrap}
.dsh-locator-check.disabled{opacity:.45;cursor:not-allowed}
.dsh-locator-count{opacity:.55;font-variant-numeric:tabular-nums}
.dsh-locator-bar .grow{flex:1}
.dsh-locator-sort{border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.3));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11.5px;padding:2px 4px}
.dsh-locator-dirbtn{border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.3));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11.5px;padding:2px 6px;cursor:pointer}
.dsh-locator-history{display:flex;align-items:center;gap:6px;padding:5px 14px;border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.1));overflow:auto;white-space:nowrap}
.dsh-locator-history-label{font-size:10.5px;opacity:.6;flex:none}
.dsh-locator-chip{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.25));border-radius:999px;padding:1px 2px 1px 8px;flex:none}
.dsh-locator-chip-go,.dsh-locator-chip-x{border:0;background:transparent;color:inherit;font:inherit;font-size:10.5px;cursor:pointer;padding:1px 3px}
.dsh-locator-chip-x{opacity:.55}
.dsh-locator-filterbar{display:flex;align-items:center;gap:8px;padding:5px 14px;border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.1))}
.dsh-locator-filter{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.2));border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:11.5px;padding:2px 7px}
.dsh-locator-status{margin-left:auto;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:50%}
.dsh-locator-scroll{overflow:auto;flex:1;min-height:160px}
.dsh-locator-group{display:block;border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.12))}
.dsh-locator-grouphead{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:6px 14px;
  font-size:11px;font-weight:500;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,rgba(120,125,135,.9));
  background:var(--dsw-alias-menu-group-header-fill,var(--dsw-alias-bg-base,#fff));border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.1));
  cursor:default}
.dsh-locator-grouphead .grow{flex:1}
.dsh-locator-groupempty{padding:10px 14px;font-size:12px;opacity:.55}
.dsh-locator-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;align-items:baseline;
  padding:6px 14px;border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.07));cursor:pointer;position:relative}
.dsh-locator-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,125,135,.08))}
.dsh-locator-row.sel{background:var(--dsw-alias-interactive-bg-active,rgba(64,116,255,.12))}
.dsh-locator-row.sel::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:#4f7cff}
.dsh-locator-rowcontent{padding-top:8px;padding-bottom:8px}
.dsh-locator-title{display:flex;align-items:baseline;gap:7px;min-width:0;font-size:13px}
.dsh-locator-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-locator-badge{flex:none;font-size:10px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(120,125,135,.14));opacity:.8;text-transform:uppercase;letter-spacing:.04em}
.dsh-locator-badge.chat{background:rgba(79,124,255,.16);color:var(--dsw-alias-brand-primary,#4f7cff)}
.dsh-locator-snippet{grid-column:1/-1;margin-top:2px;font-size:12.5px;opacity:.85;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.4}
.dsh-locator-path{grid-column:1/-1;font-size:11.5px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.dsh-locator-meta{font-size:11.5px;opacity:.65;white-space:nowrap;font-variant-numeric:tabular-nums;text-align:right}
.dsh-locator-hit{background:rgba(245,158,11,.32);border-radius:2px;color:inherit}
.dsh-locator-empty{padding:36px 16px;text-align:center;opacity:.65;font-size:12.5px;white-space:pre-wrap}
.dsh-locator-empty .dsh-locator-retry{margin-left:8px}
.dsh-locator-foot{display:flex;align-items:center;gap:10px;padding:6px 14px;border-top:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.16));
  font-size:11px;opacity:.7;flex-wrap:wrap}
.dsh-locator-foot .grow{flex:1}
.dsh-locator-toast{color:var(--dsw-alias-state-success-primary,#2e7d32)}
.dsh-locator-launch{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:7px;
  background:transparent;color:inherit;opacity:.65;cursor:pointer;font-size:14px}
.dsh-locator-launch:hover{opacity:1;background:rgba(120,125,135,.14)}
body[data-ds-dark-theme] .dsh-locator-panel{box-shadow:0 24px 64px rgba(0,0,0,.6)}
body[data-ds-dark-theme] .dsh-locator-overlay{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.55))}
.dsh-locator-target{outline:2px solid rgba(245,158,11,.75);outline-offset:2px;border-radius:6px}
.dsh-locator-notice{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:90;pointer-events:none;
  padding:7px 12px;border-radius:8px;font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
  background:var(--dsw-alias-bg-layer-2,rgba(30,32,38,.92));color:var(--dsw-alias-label-primary,#fff);
  border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.3));box-shadow:0 8px 24px rgba(0,0,0,.25);
  animation:dsh-locator-in 120ms ease-out}
::highlight(dsh-locator-find){background-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 28%,transparent);color:inherit}
::highlight(dsh-locator-find-active){background-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 50%,transparent);color:inherit;
  text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:2px}
::highlight(dsh-locator-find-scope){background-color:color-mix(in srgb,var(--dsw-alias-bg-document-selection,rgba(90,120,255,.25)) 35%,transparent)}
.dsh-locator-findbar{position:fixed;z-index:70;display:flex;flex-direction:column;width:min(560px,calc(100vw - 24px));
  border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-base,rgba(120,125,135,.28)));
  border-radius:var(--dsw-radius-md,12px);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-base,#fff));
  color:var(--dsw-alias-label-primary,inherit);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.24));
  font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;animation:dsh-locator-in 120ms ease-out}
@media (prefers-reduced-motion:reduce){.dsh-locator-findbar{animation:none}}
.dsh-locator-findbar-main{display:flex;align-items:center;gap:6px;padding:6px 8px}
.dsh-locator-findbar-glyph{font-size:14px;opacity:.6;padding:0 2px}
.dsh-locator-findbar-input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:13px;padding:3px 0}
.dsh-locator-findbar-count{font-variant-numeric:tabular-nums;font-size:12px;opacity:.75;white-space:nowrap;min-width:52px;text-align:right}
.dsh-locator-findbar-btn{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 5px;
  border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:13px}
.dsh-locator-findbar-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,125,135,.14))}
.dsh-locator-findbar-btn:disabled{opacity:.4;cursor:default}
.dsh-locator-findbar-btn[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active,rgba(64,116,255,.18));
  color:var(--dsw-alias-state-business-primary,#4f7cff)}
.dsh-locator-findbar-opts{display:flex;align-items:center;gap:8px;padding:5px 9px 7px;flex-wrap:wrap;
  border-top:1px solid var(--dsw-alias-border-l1,var(--dsw-alias-border-base,rgba(120,125,135,.16)));font-size:11.5px}
.dsh-locator-findbar-opts select{border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.3));border-radius:5px;
  background:transparent;color:inherit;font:inherit;font-size:11.5px;padding:1px 3px}
.dsh-locator-findbar-label{display:inline-flex;align-items:center;gap:4px;opacity:.8;white-space:nowrap}
.dsh-locator-findbar-status{display:flex;align-items:center;gap:8px;padding:4px 10px 6px;font-size:11.5px;opacity:.75;flex-wrap:wrap}
.dsh-locator-findbar-status .grow{flex:1}
.dsh-locator-findbar-error{padding:4px 10px 6px;font-size:11.5px;color:var(--dsw-alias-state-error-primary,#d33);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d33) 9%,transparent)}
.dsh-locator-findbar-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-2,rgba(120,125,135,.14));font-size:11px;white-space:nowrap}
.dsh-locator-findbar-chip button{border:0;background:transparent;color:inherit;cursor:pointer;padding:0 1px;font:inherit;font-size:12px}
.dsh-locator-findbar kbd{border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.3));border-radius:4px;padding:0 3px;font-size:10px;opacity:.6}
`
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + NS + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = NS
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── transport ───────────────────────────────────────────────────────────
    async function post(path, body, signal) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
        signal,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || data === null) throw new Error('HTTP ' + response.status)
      if (data.ok === false) throw new Error(typeof data.error === 'string' ? data.error : 'request failed')
      return data
    }

    // ── i18n ────────────────────────────────────────────────────────────────
    const STRINGS = {
      en: {
        scopeContent: 'Content', scopeFiles: 'Files', scopeDirs: 'Folders',
        placeholder: 'Search names, paths, bodies or sessions… e.g. ext:pdf size:>10mb dm:thisweek path:src',
        searchLabel: 'Search files', dialog: 'Local file search', closeTitle: 'Close (Esc)', closeLabel: 'Close',
        sortLabel: 'Sort', sortMtime: 'Modified', sortName: 'Name', sortSize: 'Size', sortPath: 'Path',
        asc: 'Ascending', descOrder: 'Descending',
        groupContent: 'Content', groupFiles: 'Files', groupDirs: 'Folders',
        relevance: 'by relevance', contentBuilding: 'indexing… {files} files / {messages} messages',
        contentShort: 'Type at least 3 characters to search bodies and sessions (Ctrl+F handles shorter queries)',
        contentDisabled: 'Content index is disabled (contentIndex: false)',
        contentCapped: 'first {n}', showing: 'first {n}', deduped: '{n} name hits merged into content', loading: 'Searching…',
        emptyQuery: 'Type to search file names, paths, bodies and sessions',
        emptyResults: 'No matches · try fewer scopes or another keyword',
        emptyScopes: 'Select at least one scope (Content, Files, Folders)',
        errorPrefix: 'Search failed: ', retry: 'Retry', indexing: 'indexing, results may be incomplete',
        statusLoading: 'Reading index status…', status: 'Index {entries} entries · {mode} · {roots} roots',
        live: 'live', snapshot: 'snapshot', usn: 'USN',
        copiedPath: 'Path copied', revealed: 'Revealed in file manager', opened: 'Opened', inserted: 'Inserted @file',
        insertFailed: 'Insert failed; @file copied', jumped: 'Opened session', jumpFailed: 'Opened the session but could not locate the match',
        footer: '↑↓ select · Enter open/jump · Ctrl+Shift+C copy path · Ctrl+O open · Alt+1–3 scopes · Esc close',
        results: 'content {content} · files {files} · folders {dirs} · {ms} ms',
        launcher: 'Local file search (Ctrl+Shift+F)',
        justNow: 'just now', minutesAgo: '{n} min ago', hoursAgo: '{n} h ago',
        phraseNotFound: 'No match in the conversation (it may not be loaded yet)',
        findOpen: 'Find in conversation', findTitle: 'Find in conversation', findAria: 'Find in conversation',
        findPlaceholder: 'Find in conversation…', findPlaceholderSelection: 'Find in selection…',
        findPrev: 'Previous match (Shift+F3)', findNext: 'Next match (F3)', findClose: 'Close (Esc)',
        findCase: 'Match case', findWhole: 'Whole word', findWrap: 'Wrap around', findReverse: 'Search backwards',
        findMode: 'Mode', modeNormal: 'Normal', modeExtended: 'Extended', modeRegex: 'Regex',
        findScope: 'In selection', findScopeChip: 'selection {n} chars', findSessionChip: 'this conversation',
        findNoMatch: 'No matches', findEmpty: 'Type to find in this conversation',
        findInvalidRegex: 'Invalid regular expression: {message}', findInvalidEscape: 'Invalid extended escape: {token}',
        findTimeout: 'Regex timed out; simplify the expression', findRegexUnavailable: 'Regex search is unavailable here (worker blocked)', findWrappedTop: 'Wrapped to top',
        findWrappedBottom: 'Wrapped to bottom', findNoWrapEnd: 'Reached the last match (wrap is off)',
        findNoWrapStart: 'Reached the first match (wrap is off)', findOlder: 'Load earlier messages and retry',
        findLoadingOlder: 'Loading earlier messages…', findLoadedOnly: 'loaded window only · earlier history not loaded',
        findCapped: 'capped', findCopied: 'Match copied', findSelectionLost: 'Selection expired; searching the whole conversation',
        findNoSession: 'Open a conversation first', findOptions: 'Options',
        findExtendedHelp: 'Extended: \\n \\r \\t \\0 \\xHH \\\\',
        panelTotal: 'selected {index}/{total}', panelRangeAll: 'All indexed', panelRangeSession: 'This conversation',
        panelSessionHint: 'This scope searches indexed session messages only; press Ctrl+F for live in-conversation find',
        panelRegexPaused: 'Content scope paused in regex mode', panelCountBounded: '≥ {n}', panelCountExact: '{n}',
contentWarning: 'Index warning: {list}', contentBudget: 'Content index budget reached; some files are not indexed', contentTooShort: 'Content needs at least 3 characters (use Ctrl+F for shorter searches)', contentTimeout: 'Content search timed out; narrow the query or scope', contentBadChars: 'Content search does not support NUL/control characters',
        panelCaseShort: 'Aa', panelWholeShort: 'Word', panelModeLabel: 'Mode',
        watchDegraded: 'watcher degraded; periodic refresh active',
        copyAll: 'Copy paths', copiedAll: 'Copied {n} paths',
        contentFullIndex: 'full-index', contentReasoningIndex: 'reasoning-indexed',
        panelFilter: 'Filter loaded results…', filterEmpty: 'No loaded result matches this filter', panelLoadMore: 'Load more', panelHistory: 'Recent searches', panelHistoryClear: 'Clear',
      },
      zh: {
        scopeContent: '内容', scopeFiles: '文件', scopeDirs: '目录',
        placeholder: '搜文件名、路径、正文或会话… 支持 ext:pdf size:>10mb dm:thisweek path:src',
        searchLabel: '文件搜索', dialog: '本地文件搜索', closeTitle: '关闭 (Esc)', closeLabel: '关闭',
        sortLabel: '排序', sortMtime: '修改时间', sortName: '名称', sortSize: '大小', sortPath: '路径',
        asc: '升序', descOrder: '降序',
        groupContent: '内容', groupFiles: '文件', groupDirs: '目录',
        relevance: '按相关度', contentBuilding: '索引构建中… {files} 文件 / {messages} 消息',
        contentShort: '输入至少 3 个字符后搜索正文与会话（更短的词请用 Ctrl+F）',
        contentDisabled: '内容索引已关闭（contentIndex: false）',
        contentCapped: '前 {n} 条', showing: '前 {n} 条', deduped: '{n} 条文件命中已并入内容', loading: '搜索中…',
        emptyQuery: '输入关键词：文件名、路径、正文或会话内容',
        emptyResults: '没有匹配结果 · 可试试减少范围或换个关键词',
        emptyScopes: '至少选择一个搜索范围（内容 / 文件 / 目录）',
        errorPrefix: '搜索失败：', retry: '重试', indexing: '索引构建中，结果可能不完整',
        statusLoading: '索引状态读取中…', status: '索引 {entries} 条 · {mode} · {roots} 个根目录',
        live: '实时监听', snapshot: '快照', usn: 'USN',
        copiedPath: '已复制路径', revealed: '已在文件管理器中定位', opened: '已打开', inserted: '已插入 @file',
        insertFailed: '插入失败，已复制 @file', jumped: '已打开会话', jumpFailed: '已打开会话，但未定位到该消息',
        footer: '↑↓ 选择 · Enter 打开/跳转 · Ctrl+Shift+C 复制路径 · Ctrl+O 打开 · Alt+1–3 切换范围 · Esc 关闭',
        results: '内容 {content} · 文件 {files} · 目录 {dirs} · {ms} ms',
        launcher: '本地文件搜索 (Ctrl+Shift+F)',
        justNow: '刚刚', minutesAgo: '{n} 分钟前', hoursAgo: '{n} 小时前',
        phraseNotFound: '会话里没有找到匹配内容（可能还没加载）',
        findOpen: '在会话中查找', findTitle: '在会话中查找', findAria: '在会话中查找',
        findPlaceholder: '在会话中查找…', findPlaceholderSelection: '在选区内查找…',
        findPrev: '上一个匹配 (Shift+F3)', findNext: '下一个匹配 (F3)', findClose: '关闭 (Esc)',
        findCase: '区分大小写', findWhole: '全词匹配', findWrap: '循环查找', findReverse: '反向查找',
        findMode: '模式', modeNormal: '普通', modeExtended: '扩展', modeRegex: '正则',
        findScope: '仅在选区内', findScopeChip: '选区 {n} 字', findSessionChip: '本会话',
        findNoMatch: '没有匹配', findEmpty: '输入关键词后在此会话中查找',
        findInvalidRegex: '正则无效：{message}', findInvalidEscape: '扩展转义无效：{token}',
        findTimeout: '正则执行超时，请简化表达式', findRegexUnavailable: '此处无法运行正则（worker 被阻止）', findWrappedTop: '已回到顶部',
        findWrappedBottom: '已到底部，回到开头', findNoWrapEnd: '已到最后一个匹配（循环查找已关闭）',
        findNoWrapStart: '已到第一个匹配（循环查找已关闭）', findOlder: '加载更早消息后重试',
        findLoadingOlder: '正在加载更早消息…', findLoadedOnly: '仅已加载窗口 · 更早历史未加载',
        findCapped: '已截断', findCopied: '已复制匹配', findSelectionLost: '选区已失效，已切回整个会话',
        findNoSession: '请先打开一个会话', findOptions: '选项',
        findExtendedHelp: '扩展：\\n \\r \\t \\0 \\xHH \\\\',
        panelTotal: '已选 {index}/{total}', panelRangeAll: '全部索引', panelRangeSession: '当前会话',
        panelSessionHint: '此范围只查已索引的会话消息；实时查找请按 Ctrl+F',
        panelRegexPaused: '正则模式下内容范围暂停', panelCountBounded: '≥ {n}', panelCountExact: '{n}',
contentWarning: '索引警告：{list}', contentBudget: '内容索引已达预算上限，部分文件未被收录', contentTooShort: '内容搜索至少需要 3 个字符（更短的词请用 Ctrl+F 在会话内查找）', contentTimeout: '内容搜索超时，请缩小关键词或范围', contentBadChars: '内容搜索不支持 NUL/控制字符',
        panelCaseShort: 'Aa', panelWholeShort: '全词', panelModeLabel: '模式',
        watchDegraded: '文件监听降级，正在周期刷新',
        copyAll: '复制路径', copiedAll: '已复制 {n} 条路径',
        contentFullIndex: '全量内容', contentReasoningIndex: '含思考内容',
        panelFilter: '过滤当前结果…', filterEmpty: '已加载结果中没有符合过滤条件的内容', panelLoadMore: '加载更多', panelHistory: '最近搜索', panelHistoryClear: '清空',
      },
      es: {
        scopeContent: 'Contenido', scopeFiles: 'Archivos', scopeDirs: 'Carpetas',
        placeholder: 'Busca nombres, rutas, contenido o sesiones… p. ej. ext:pdf size:>10mb dm:thisweek path:src',
        searchLabel: 'Buscar archivos', dialog: 'Búsqueda local de archivos', closeTitle: 'Cerrar (Esc)', closeLabel: 'Cerrar',
        sortLabel: 'Orden', sortMtime: 'Modificado', sortName: 'Nombre', sortSize: 'Tamaño', sortPath: 'Ruta',
        asc: 'Ascendente', descOrder: 'Descendente',
        groupContent: 'Contenido', groupFiles: 'Archivos', groupDirs: 'Carpetas',
        relevance: 'por relevancia', contentBuilding: 'indexando… {files} archivos / {messages} mensajes',
        contentShort: 'Escribe al menos 3 caracteres para buscar contenido y sesiones (Ctrl+F para consultas cortas)',
        contentDisabled: 'Índice de contenido desactivado (contentIndex: false)',
        contentCapped: 'primeros {n}', showing: 'primeros {n}', deduped: '{n} aciertos de nombre fusionados', loading: 'Buscando…',
        emptyQuery: 'Escribe para buscar nombres, rutas, contenido y sesiones',
        emptyResults: 'Sin coincidencias · prueba menos ámbitos u otra palabra',
        emptyScopes: 'Elige al menos un ámbito (Contenido, Archivos, Carpetas)',
        errorPrefix: 'Error de búsqueda: ', retry: 'Reintentar', indexing: 'indexando, resultados incompletos',
        statusLoading: 'Leyendo el estado del índice…', status: 'Índice: {entries} entradas · {mode} · {roots} raíces',
        live: 'en vivo', snapshot: 'instantánea', usn: 'USN',
        copiedPath: 'Ruta copiada', revealed: 'Mostrado en el gestor de archivos', opened: 'Abierto', inserted: '@file insertado',
        insertFailed: 'No se pudo insertar; @file copiado', jumped: 'Sesión abierta', jumpFailed: 'Sesión abierta, pero no se localizó el mensaje',
        footer: '↑↓ elegir · Enter abrir/ir · Ctrl+Shift+C copiar ruta · Ctrl+O abrir · Alt+1–3 ámbitos · Esc cerrar',
        results: 'contenido {content} · archivos {files} · carpetas {dirs} · {ms} ms',
        launcher: 'Búsqueda local (Ctrl+Shift+F)',
        justNow: 'ahora', minutesAgo: 'hace {n} min', hoursAgo: 'hace {n} h',
        phraseNotFound: 'No se encontró en la conversación (quizá no está cargada)',
        findOpen: 'Buscar en la conversación', findTitle: 'Buscar en la conversación', findAria: 'Buscar en la conversación',
        findPlaceholder: 'Buscar en la conversación…', findPlaceholderSelection: 'Buscar en la selección…',
        findPrev: 'Coincidencia anterior (Shift+F3)', findNext: 'Siguiente coincidencia (F3)', findClose: 'Cerrar (Esc)',
        findCase: 'Distinguir mayúsculas', findWhole: 'Palabra completa', findWrap: 'Continuar al inicio', findReverse: 'Buscar hacia atrás',
        findMode: 'Modo', modeNormal: 'Normal', modeExtended: 'Extendido', modeRegex: 'Regex',
        findScope: 'En la selección', findScopeChip: 'selección {n} caracteres', findSessionChip: 'esta conversación',
        findNoMatch: 'Sin coincidencias', findEmpty: 'Escribe para buscar en esta conversación',
        findInvalidRegex: 'Expresión regular no válida: {message}', findInvalidEscape: 'Escape extendido no válido: {token}',
        findTimeout: 'La regex agotó el tiempo; simplifícala', findRegexUnavailable: 'La búsqueda regex no está disponible aquí (worker bloqueado)', findWrappedTop: 'Vuelto al inicio',
        findWrappedBottom: 'Vuelto al final', findNoWrapEnd: 'Última coincidencia (continuación desactivada)',
        findNoWrapStart: 'Primera coincidencia (continuación desactivada)', findOlder: 'Cargar mensajes anteriores y reintentar',
        findLoadingOlder: 'Cargando mensajes anteriores…', findLoadedOnly: 'solo ventana cargada · historial anterior sin cargar',
        findCapped: 'limitado', findCopied: 'Coincidencia copiada', findSelectionLost: 'La selección caducó; buscando en toda la conversación',
        findNoSession: 'Abre primero una conversación', findOptions: 'Opciones',
        findExtendedHelp: 'Extendido: \\n \\r \\t \\0 \\xHH \\\\',
        panelTotal: 'seleccionado {index}/{total}', panelRangeAll: 'Todo el índice', panelRangeSession: 'Esta conversación',
        panelSessionHint: 'Este ámbito solo busca mensajes indexados; pulsa Ctrl+F para buscar en vivo',
        panelRegexPaused: 'Ámbito de contenido en pausa en modo regex', panelCountBounded: '≥ {n}', panelCountExact: '{n}',
contentWarning: 'Aviso del índice: {list}', contentBudget: 'Se alcanzó el presupuesto del índice; algunos archivos no están indexados', contentTooShort: 'El contenido requiere al menos 3 caracteres (usa Ctrl+F para búsquedas más cortas)', contentTimeout: 'La búsqueda de contenido agotó el tiempo; reduce la consulta o el ámbito', contentBadChars: 'La búsqueda de contenido no admite NUL/caracteres de control',
        panelCaseShort: 'Aa', panelWholeShort: 'Palabra', panelModeLabel: 'Modo',
        watchDegraded: 'vigilante degradado; refresco periódico activo',
        copyAll: 'Copiar rutas', copiedAll: 'Se copiaron {n} rutas',
        contentFullIndex: 'índice completo', contentReasoningIndex: 'razonamiento indexado',
        panelFilter: 'Filtrar resultados cargados…', filterEmpty: 'Ningún resultado cargado coincide con el filtro', panelLoadMore: 'Cargar más', panelHistory: 'Búsquedas recientes', panelHistoryClear: 'Borrar',
      },
      pt: {
        scopeContent: 'Conteúdo', scopeFiles: 'Arquivos', scopeDirs: 'Pastas',
        placeholder: 'Busque nomes, caminhos, conteúdo ou sessões… ex. ext:pdf size:>10mb dm:thisweek path:src',
        searchLabel: 'Buscar arquivos', dialog: 'Busca local de arquivos', closeTitle: 'Fechar (Esc)', closeLabel: 'Fechar',
        sortLabel: 'Ordem', sortMtime: 'Modificado', sortName: 'Nome', sortSize: 'Tamanho', sortPath: 'Caminho',
        asc: 'Ascendente', descOrder: 'Descendente',
        groupContent: 'Conteúdo', groupFiles: 'Arquivos', groupDirs: 'Pastas',
        relevance: 'por relevância', contentBuilding: 'indexando… {files} arquivos / {messages} mensagens',
        contentShort: 'Digite pelo menos 3 caracteres para buscar conteúdo e sessões (Ctrl+F para consultas curtas)',
        contentDisabled: 'Índice de conteúdo desativado (contentIndex: false)',
        contentCapped: 'primeiros {n}', showing: 'primeiros {n}', deduped: '{n} acertos de nome mesclados', loading: 'Buscando…',
        emptyQuery: 'Digite para buscar nomes, caminhos, conteúdo e sessões',
        emptyResults: 'Sem resultados · tente menos escopos ou outra palavra',
        emptyScopes: 'Escolha pelo menos um escopo (Conteúdo, Arquivos, Pastas)',
        errorPrefix: 'Falha na busca: ', retry: 'Tentar novamente', indexing: 'indexando, resultados incompletos',
        statusLoading: 'Lendo o estado do índice…', status: 'Índice: {entries} entradas · {mode} · {roots} raízes',
        live: 'ao vivo', snapshot: 'instantâneo', usn: 'USN',
        copiedPath: 'Caminho copiado', revealed: 'Mostrado no gerenciador de arquivos', opened: 'Aberto', inserted: '@file inserido',
        insertFailed: 'Falha ao inserir; @file copiado', jumped: 'Sessão aberta', jumpFailed: 'Sessão aberta, mas a mensagem não foi localizada',
        footer: '↑↓ escolher · Enter abrir/ir · Ctrl+Shift+C copiar caminho · Ctrl+O abrir · Alt+1–3 escopos · Esc fechar',
        results: 'conteúdo {content} · arquivos {files} · pastas {dirs} · {ms} ms',
        launcher: 'Busca local (Ctrl+Shift+F)',
        justNow: 'agora', minutesAgo: 'há {n} min', hoursAgo: 'há {n} h',
        phraseNotFound: 'Não encontrado na conversa (talvez ainda não carregada)',
        findOpen: 'Buscar na conversa', findTitle: 'Buscar na conversa', findAria: 'Buscar na conversa',
        findPlaceholder: 'Buscar na conversa…', findPlaceholderSelection: 'Buscar na seleção…',
        findPrev: 'Ocorrência anterior (Shift+F3)', findNext: 'Próxima ocorrência (F3)', findClose: 'Fechar (Esc)',
        findCase: 'Diferenciar maiúsculas', findWhole: 'Palavra inteira', findWrap: 'Continuar do início', findReverse: 'Buscar para trás',
        findMode: 'Modo', modeNormal: 'Normal', modeExtended: 'Estendido', modeRegex: 'Regex',
        findScope: 'Na seleção', findScopeChip: 'seleção {n} caracteres', findSessionChip: 'esta conversa',
        findNoMatch: 'Sem resultados', findEmpty: 'Digite para buscar nesta conversa',
        findInvalidRegex: 'Expressão regular inválida: {message}', findInvalidEscape: 'Escape estendido inválido: {token}',
        findTimeout: 'A regex excedeu o tempo; simplifique', findRegexUnavailable: 'A busca regex não está disponível aqui (worker bloqueado)', findWrappedTop: 'Voltou ao início',
        findWrappedBottom: 'Voltou ao fim', findNoWrapEnd: 'Última ocorrência (continuação desativada)',
        findNoWrapStart: 'Primeira ocorrência (continuação desativada)', findOlder: 'Carregar mensagens anteriores e tentar novamente',
        findLoadingOlder: 'Carregando mensagens anteriores…', findLoadedOnly: 'apenas janela carregada · histórico anterior não carregado',
        findCapped: 'limitado', findCopied: 'Ocorrência copiada', findSelectionLost: 'A seleção expirou; buscando em toda a conversa',
        findNoSession: 'Abra uma conversa primeiro', findOptions: 'Opções',
        findExtendedHelp: 'Estendido: \\n \\r \\t \\0 \\xHH \\\\',
        panelTotal: 'selecionado {index}/{total}', panelRangeAll: 'Todo o índice', panelRangeSession: 'Esta conversa',
        panelSessionHint: 'Este escopo busca apenas mensagens indexadas; use Ctrl+F para buscar ao vivo',
        panelRegexPaused: 'Escopo de conteúdo pausado no modo regex', panelCountBounded: '≥ {n}', panelCountExact: '{n}',
contentWarning: 'Aviso do índice: {list}', contentBudget: 'O orçamento do índice foi atingido; alguns arquivos não estão indexados', contentTooShort: 'O conteúdo exige pelo menos 3 caracteres (use Ctrl+F para buscas menores)', contentTimeout: 'A busca de conteúdo excedeu o tempo; reduza a consulta ou o escopo', contentBadChars: 'A busca de conteúdo não suporta NUL/caracteres de controle',
        panelCaseShort: 'Aa', panelWholeShort: 'Palavra', panelModeLabel: 'Modo',
        watchDegraded: 'watcher degradado; atualização periódica ativa',
        copyAll: 'Copiar caminhos', copiedAll: '{n} caminhos copiados',
        contentFullIndex: 'índice completo', contentReasoningIndex: 'raciocínio indexado',
        panelFilter: 'Filtrar resultados carregados…', filterEmpty: 'Nenhum resultado carregado corresponde ao filtro', panelLoadMore: 'Carregar mais', panelHistory: 'Buscas recentes', panelHistoryClear: 'Limpar',
      },
      hi: {
        scopeContent: 'सामग्री', scopeFiles: 'फ़ाइलें', scopeDirs: 'फ़ोल्डर',
        placeholder: 'नाम, पथ, सामग्री या सत्र खोजें… जैसे ext:pdf size:>10mb dm:thisweek path:src',
        searchLabel: 'फ़ाइल खोज', dialog: 'स्थानीय फ़ाइल खोज', closeTitle: 'बंद करें (Esc)', closeLabel: 'बंद करें',
        sortLabel: 'क्रम', sortMtime: 'संशोधित', sortName: 'नाम', sortSize: 'आकार', sortPath: 'पथ',
        asc: 'आरोही', descOrder: 'अवरोही',
        groupContent: 'सामग्री', groupFiles: 'फ़ाइलें', groupDirs: 'फ़ोल्डर',
        relevance: 'प्रासंगिकता से', contentBuilding: 'इंडेक्स बन रहा है… {files} फ़ाइलें / {messages} संदेश',
        contentShort: 'सामग्री और सत्र खोजने के लिए कम से कम 3 अक्षर लिखें (छोटी खोज के लिए Ctrl+F)',
        contentDisabled: 'सामग्री इंडेक्स बंद है (contentIndex: false)',
        contentCapped: 'पहले {n}', showing: 'पहले {n}', deduped: '{n} नाम-परिणाम सामग्री में मिलाए', loading: 'खोज रहे हैं…',
        emptyQuery: 'नाम, पथ, सामग्री और सत्र खोजने के लिए लिखें',
        emptyResults: 'कोई मेल नहीं · कम क्षेत्र या दूसरा शब्द आज़माएँ',
        emptyScopes: 'कम से कम एक क्षेत्र चुनें (सामग्री, फ़ाइलें, फ़ोल्डर)',
        errorPrefix: 'खोज विफल: ', retry: 'पुन: प्रयास', indexing: 'इंडेक्स बन रहा है, परिणाम अधूरे हो सकते हैं',
        statusLoading: 'इंडेक्स स्थिति पढ़ी जा रही है…', status: 'इंडेक्स {entries} प्रविष्टियाँ · {mode} · {roots} रूट',
        live: 'लाइव', snapshot: 'स्नैपशॉट', usn: 'USN',
        copiedPath: 'पथ कॉपी हुआ', revealed: 'फ़ाइल मैनेजर में दिखाया', opened: 'खोला गया', inserted: '@file डाला गया',
        insertFailed: 'डालना विफल; @file कॉपी हुआ', jumped: 'सत्र खुला', jumpFailed: 'सत्र खुला, पर संदेश नहीं मिला',
        footer: '↑↓ चुनें · Enter खोलें/जाएँ · Ctrl+Shift+C पथ कॉपी · Ctrl+O खोलें · Alt+1–3 क्षेत्र · Esc बंद',
        results: 'सामग्री {content} · फ़ाइलें {files} · फ़ोल्डर {dirs} · {ms} ms',
        launcher: 'स्थानीय फ़ाइल खोज (Ctrl+Shift+F)',
        justNow: 'अभी', minutesAgo: '{n} मिनट पहले', hoursAgo: '{n} घंटे पहले',
        phraseNotFound: 'बातचीत में नहीं मिला (शायद अभी लोड नहीं हुआ)',
        findOpen: 'बातचीत में खोजें', findTitle: 'बातचीत में खोजें', findAria: 'बातचीत में खोजें',
        findPlaceholder: 'बातचीत में खोजें…', findPlaceholderSelection: 'चयन में खोजें…',
        findPrev: 'पिछला मेल (Shift+F3)', findNext: 'अगला मेल (F3)', findClose: 'बंद करें (Esc)',
        findCase: 'केस मिलाएँ', findWhole: 'पूरा शब्द', findWrap: 'चक्रीय खोज', findReverse: 'उल्टा खोजें',
        findMode: 'मोड', modeNormal: 'सामान्य', modeExtended: 'विस्तृत', modeRegex: 'रेगेक्स',
        findScope: 'चयन में', findScopeChip: 'चयन {n} अक्षर', findSessionChip: 'यह बातचीत',
        findNoMatch: 'कोई मेल नहीं', findEmpty: 'इस बातचीत में खोजने के लिए लिखें',
        findInvalidRegex: 'अमान्य रेगुलर एक्सप्रेशन: {message}', findInvalidEscape: 'अमान्य विस्तृत एस्केप: {token}',
        findTimeout: 'रेगेक्स का समय समाप्त; सरल बनाएँ', findRegexUnavailable: 'यहाँ रेगेक्स उपलब्ध नहीं है (वर्कर अवरुद्ध)', findWrappedTop: 'शीर्ष पर लौटा',
        findWrappedBottom: 'अंत पर लौटा', findNoWrapEnd: 'अंतिम मेल (चक्र बंद)',
        findNoWrapStart: 'पहला मेल (चक्र बंद)', findOlder: 'पुराने संदेश लोड कर पुन: प्रयास',
        findLoadingOlder: 'पुराने संदेश लोड हो रहे हैं…', findLoadedOnly: 'केवल लोडेड विंडो · पुराना इतिहास लोड नहीं',
        findCapped: 'सीमित', findCopied: 'मेल कॉपी हुआ', findSelectionLost: 'चयन समाप्त; पूरी बातचीत में खोज',
        findNoSession: 'पहले एक बातचीत खोलें', findOptions: 'विकल्प',
        findExtendedHelp: 'विस्तृत: \\n \\r \\t \\0 \\xHH \\\\',
        panelTotal: 'चयनित {index}/{total}', panelRangeAll: 'पूरा इंडेक्स', panelRangeSession: 'यह बातचीत',
        panelSessionHint: 'यह क्षेत्र केवल इंडेक्स किए संदेश खोजता है; लाइव खोज के लिए Ctrl+F दबाएँ',
        panelRegexPaused: 'रेगेक्स मोड में सामग्री क्षेत्र रुका है', panelCountBounded: '≥ {n}', panelCountExact: '{n}',
contentWarning: 'इंडेक्स चेतावनी: {list}', contentBudget: 'सामग्री इंडेक्स बजट पूरा; कुछ फ़ाइलें इंडेक्स नहीं हैं', contentTooShort: 'सामग्री के लिए कम से कम 3 अक्षर चाहिए (छोटी खोज के लिए Ctrl+F)', contentTimeout: 'सामग्री खोज का समय समाप्त; क्वेरी या क्षेत्र घटाएँ', contentBadChars: 'सामग्री खोज NUL/नियंत्रण अक्षर नहीं लेती',
        panelCaseShort: 'Aa', panelWholeShort: 'शब्द', panelModeLabel: 'मोड',
        watchDegraded: 'वॉचर क्षीण; आवधिक रिफ्रेश सक्रिय',
        copyAll: 'पथ कॉपी करें', copiedAll: '{n} पथ कॉपी हुए',
        contentFullIndex: 'पूर्ण इंडेक्स', contentReasoningIndex: 'reasoning इंडेक्स',
        panelFilter: 'लोड किए गए परिणाम छाँटें…', filterEmpty: 'लोड किए गए परिणामों में फ़िल्टर से मेल नहीं', panelLoadMore: 'और लोड करें', panelHistory: 'हाल की खोजें', panelHistoryClear: 'साफ़ करें',
      },
    }
    const LANG = (() => {
      // The host sets <html lang> from the active DSH locale; prefer it over
      // the browser UI language so the panel follows the product setting.
      const hostTag = typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang : ''
      const tag = String(hostTag || (typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
      if (tag.startsWith('zh')) return 'zh'
      if (tag.startsWith('es')) return 'es'
      if (tag.startsWith('pt')) return 'pt'
      if (tag.startsWith('hi')) return 'hi'
      return 'en'
    })()
    const TEXT = STRINGS[LANG]
    function t(key, vars) {
      let value = TEXT[key] || STRINGS.en[key] || key
      if (vars) value = value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
      return value
    }

    function formatRelative(ms) {
      const diff = Date.now() - ms
      if (diff >= 0 && diff < 60_000) return t('justNow')
      if (diff >= 0 && diff < 3_600_000) return t('minutesAgo', { n: Math.floor(diff / 60_000) })
      if (diff >= 0 && diff < 86_400_000) return t('hoursAgo', { n: Math.floor(diff / 3_600_000) })
      return ''
    }

    function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') return navigator.clipboard.writeText(text)
      return new Promise((resolve, reject) => {
        const area = document.createElement('textarea')
        area.value = text
        document.body.appendChild(area)
        area.select()
        try {
          if (document.execCommand('copy')) resolve()
          else reject(new Error('copy failed'))
        } finally {
          area.remove()
        }
      })
    }

    function insertIntoComposer(text) {
      const element = document.querySelector('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')
      if (!element) return false
      element.focus()
      if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
        const start = typeof element.selectionStart === 'number' ? element.selectionStart : element.value.length
        const end = typeof element.selectionEnd === 'number' ? element.selectionEnd : start
        if (typeof element.setRangeText === 'function') element.setRangeText(text, start, end, 'end')
        else element.value = element.value.slice(0, start) + text + element.value.slice(end)
        element.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      return document.execCommand('insertText', false, text)
    }

    function formatSize(bytes) {
      if (!bytes) return ''
      if (bytes < 1024) return bytes + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = bytes / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
      }
      return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[unit]
    }

    function formatTime(ms) {
      if (!ms) return ''
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return ''
      const relative = formatRelative(ms)
      if (relative !== '') return relative
      const pad = value => String(value).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }

    function escapeRegExp(text) {
      return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    function queryWords(query) {
      const words = String(query || '').split(/\s+/).filter(word => word !== ''
        && !word.includes(':') && !word.startsWith('!') && !word.includes('*') && !word.includes('?'))
      return words.map(word => word.replace(/^"|"$/g, '')).filter(word => word.length > 0)
    }

    function highlight(text, query) {
      const words = queryWords(query)
      if (words.length === 0) return text
      try {
        const pattern = new RegExp('(' + words.map(escapeRegExp).join('|') + ')', 'gi')
        const parts = String(text).split(pattern)
        return parts.map((part, index) => (index % 2 === 1 ? h('mark', { className: 'dsh-locator-hit', key: index }, part) : part))
      } catch {
        return text
      }
    }

    // ── panel preferences ───────────────────────────────────────────────────
    const PREFS_KEY = 'dsh-locator.panel.v1'
    const SORTS = ['mtime', 'name', 'size', 'path']
    function readPrefs() {
      const fallback = { scopes: { content: true, files: true, dirs: true }, sort: 'mtime', desc: true,
        matchMode: 'normal', caseSensitive: false, wholeWord: false }
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (raw === null) return fallback
        const value = JSON.parse(raw)
        if (typeof value !== 'object' || value === null) return fallback
        const scopes = value.scopes
        return {
          scopes: {
            content: typeof scopes?.content === 'boolean' ? scopes.content : true,
            files: typeof scopes?.files === 'boolean' ? scopes.files : true,
            dirs: typeof scopes?.dirs === 'boolean' ? scopes.dirs : true,
          },
          sort: SORTS.includes(value.sort) ? value.sort : 'mtime',
          desc: typeof value.desc === 'boolean' ? value.desc : true,
          matchMode: ['normal', 'extended', 'regex'].includes(value.matchMode) ? value.matchMode : 'normal',
          caseSensitive: typeof value.caseSensitive === 'boolean' ? value.caseSensitive : false,
          wholeWord: typeof value.wholeWord === 'boolean' ? value.wholeWord : false,
        }
      } catch {
        return fallback
      }
    }
    function writePrefs(prefs) {
      try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* storage unavailable */ }
    }

    // ── find highlight: CSS Custom Highlight API ────────────────────────────
    const HL_BASE = 'dsh-locator-find'
    const HL_ACTIVE = 'dsh-locator-find-active'
    const GESTURES = ['wheel', 'touchstart', 'pointerdown', 'keydown']
    const EXCLUDED = '[hidden],[data-chat-history],[data-text-interaction-surface],[data-composer-seat],script,style,'
      + '.sr-only,[class*="visuallyHidden"],[role="status"],[aria-live]'
    const BLOCK_SELECTOR = 'p,li,pre,td,th,h1,h2,h3,h4,h5,h6,blockquote,dd,dt'
    const legacyTargets = new Set()

    function highlightsAvailable() {
      return typeof Highlight === 'function' && typeof CSS !== 'undefined' && CSS !== null
        && typeof CSS.highlights === 'object' && CSS.highlights !== null
    }

    function clearLegacyTargets() {
      for (const element of legacyTargets) element.classList.remove('dsh-locator-target')
      legacyTargets.clear()
    }

    const HL_SCOPE = 'dsh-locator-find-scope'
    let highlightOwner = null

    function clearFindHighlight(owner) {
      if (owner && highlightOwner !== null && owner !== highlightOwner) return
      highlightOwner = null
      clearLegacyTargets()
      if (!highlightsAvailable()) return
      CSS.highlights.delete(HL_BASE)
      CSS.highlights.delete(HL_ACTIVE)
      CSS.highlights.delete(HL_SCOPE)
    }

    function setFindHighlight(ranges, activeIndex, owner) {
      clearFindHighlight()
      if (ranges.length === 0) return
      highlightOwner = owner || null
      const active = ranges[Math.max(0, Math.min(ranges.length - 1, activeIndex || 0))]
      if (!highlightsAvailable()) {
        const node = active.startContainer
        const element = node instanceof Element ? node : node.parentElement
        const row = element === null ? null : element.closest('[data-chat-node-key]')
        if (row !== null) { row.classList.add('dsh-locator-target'); legacyTargets.add(row) }
        return
      }
      CSS.highlights.set(HL_BASE, new Highlight(...ranges))
      CSS.highlights.set(HL_ACTIVE, new Highlight(active))
    }

    function setFindScope(range) {
      if (!highlightsAvailable()) return
      CSS.highlights.delete(HL_SCOPE)
      if (range !== null) CSS.highlights.set(HL_SCOPE, new Highlight(range))
    }

    function isVisible(element) {
      if (element.getClientRects().length === 0) return false
      return getComputedStyle(element).visibility !== 'hidden'
    }

    function conversationScope(sessionId) {
      const id = sessionId === undefined || sessionId === null ? '' : String(sessionId)
      let visibleMain = null
      let visibleEmbedded = null
      for (const element of document.querySelectorAll('[data-conversation-content][data-conversation-session]')) {
        if (id !== '' && element.getAttribute('data-conversation-session') !== id) continue
        if (!isVisible(element)) continue
        if (element.closest('[data-sidebar-chat]') === null) visibleMain = element
        else visibleEmbedded = element
      }
      return visibleMain ?? visibleEmbedded
    }

    function chatFlow(scope) {
      return scope === null ? null : scope.querySelector('[data-chat-flow]')
    }

    function findMessageRows(flow, messageId, nodeKey) {
      if (flow === null) return []
      const rows = flow.querySelectorAll('[data-chat-node-key]')
      const exact = []
      if (nodeKey) {
        for (const row of rows) {
          if (row.getAttribute('data-chat-node-key') === String(nodeKey)) exact.push(row)
        }
      }
      if (exact.length === 0 && messageId) {
        const id = String(messageId)
        for (const row of rows) {
          const key = row.getAttribute('data-chat-node-key') || ''
          if (key === id || key.endsWith(id)) exact.push(row)
        }
      }
      // A single assistant step can be rendered as a reasoning row and a
      // response row under the same node key; prefer the response row.
      return exact.sort((left, right) => {
        const score = row => row.getAttribute('data-chat-group-part') === 'response' ? 0 : 1
        return score(left) - score(right)
      })
    }

    function needlesFromQuery(query) {
      const raw = String(query || '').trim()
      const words = queryWords(raw).filter(word => word.length >= 1)
      if (words.length === 0 && raw.length >= 2) return [raw]
      return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 8)
    }

    function projectGroups(root, excluded) {
      if (root === null) return []
      const groups = new Map()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.matches(excluded)) return NodeFilter.FILTER_REJECT
            if (node.tagName === 'BR') return NodeFilter.FILTER_ACCEPT
            return NodeFilter.FILTER_SKIP
          }
          return NodeFilter.FILTER_ACCEPT
        },
      })
      const groupFor = block => {
        let group = groups.get(block)
        if (group === undefined) {
          group = {
            block, raw: '', rawLength: 0, text: '', runs: [], nodes: [], breaks: [],
            collapse: !(block instanceof Element && block.tagName === 'PRE'),
          }
          groups.set(block, group)
        }
        return group
      }
      const appendText = (group, node) => {
        const value = node.nodeValue || ''
        if (value === '') return
        group.nodes.push({ node, start: group.raw.length, end: group.raw.length + value.length })
        group.raw += value
      }
      const appendBreak = group => {
        group.breaks.push(group.raw.length)
        group.raw += '\u0000'
      }
      let node = walker.nextNode()
      while (node !== null) {
        const parent = node.parentElement
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
          if (parent !== null && parent.closest(excluded) === null) {
            const block = parent.closest(BLOCK_SELECTOR)
              || parent.closest('[data-text-interaction-source]')
              || parent.closest('[data-chat-node-key]')
              || root
            appendBreak(groupFor(block))
          }
        } else if (parent !== null && parent.closest(excluded) === null) {
          const block = parent.closest(BLOCK_SELECTOR)
            || parent.closest('[data-text-interaction-source]')
            || parent.closest('[data-chat-node-key]')
            || root
          appendText(groupFor(block), node)
        }
        node = walker.nextNode()
      }
      // Project the concatenated raw text once per block. Soft newlines and
      // repeated whitespace become one space outside <pre>; <br> becomes a
      // separator. rums maps projected offsets back to raw offsets without
      // allocating one object per character (a multi-MB transcript would
      // otherwise create millions of position objects).
      for (const group of groups.values()) {
        const raw = group.raw
        group.rawLength = raw.length
        if (!group.collapse) {
          group.text = raw.replace(/\u0000/g, '\n')
          group.runs = []
          continue
        }
        let text = ''
        const runs = []
        let index = 0
        while (index < raw.length) {
          const char = raw[index]
          if (char === '\u0000' || /\s/u.test(char)) {
            const start = index
            while (index < raw.length && (raw[index] === '\u0000' || /\s/u.test(raw[index]))) index++
            runs.push({ rawStart: start, rawLength: index - start, projectedStart: text.length })
            text += ' '
          } else {
            text += char
            index++
          }
        }
        group.text = text
        group.runs = runs
      }
      return [...groups.values()]
    }

    function inlineGroups(root) {
      return projectGroups(root, EXCLUDED)
    }

    function projectedToRaw(group, index, isEnd) {
      if (!group.collapse) return Math.max(0, Math.min(group.rawLength, index))
      let extra = 0
      for (const run of group.runs) {
        if (run.projectedStart < index || (isEnd && run.projectedStart === index)) extra += run.rawLength - 1
        else break
      }
      return Math.max(0, Math.min(group.rawLength, index + extra))
    }

    function rawToProjected(group, raw) {
      if (!group.collapse) return Math.max(0, Math.min(group.rawLength, raw))
      let extra = 0
      for (const run of group.runs) {
        const end = run.rawStart + run.rawLength
        if (raw >= end) extra += run.rawLength - 1
        else if (raw > run.rawStart) return run.projectedStart
        else break
      }
      return Math.max(0, Math.min(group.rawLength, raw - extra))
    }

    function pointForRaw(group, raw, isEnd) {
      for (const entry of group.nodes) {
        if (raw < entry.start) continue
        if (raw <= entry.end) return { node: entry.node, offset: Math.min(raw - entry.start, entry.end - entry.start) }
      }
      for (const br of group.breaks) {
        if (raw !== br) continue
        if (isEnd) {
          for (let i = group.nodes.length - 1; i >= 0; i--) {
            const entry = group.nodes[i]
            if (entry.end <= br) return { node: entry.node, offset: entry.end - entry.start }
          }
        } else {
          for (const entry of group.nodes) {
            if (entry.start > br) return { node: entry.node, offset: 0 }
          }
        }
      }
      const last = group.nodes[group.nodes.length - 1]
      return last === undefined ? null : { node: last.node, offset: last.end - last.start }
    }

    function positionAt(group, index, isEnd) {
      const raw = projectedToRaw(group, index, isEnd)
      return pointForRaw(group, raw, isEnd)
    }

    function rangeAt(group, start, end) {
      const from = positionAt(group, start, false)
      const to = positionAt(group, end, true)
      if (from === null || to === null) return null
      const range = document.createRange()
      try {
        range.setStart(from.node, from.offset)
        range.setEnd(to.node, to.offset)
        return range
      } catch {
        return null
      }
    }

    function rangesForNeedles(root, needles) {
      const ranges = []
      if (root === null || needles.length === 0) return ranges
      const patterns = needles.map(escapeRegExp)
      const expression = new RegExp(patterns.join('|'), 'giu')
      for (const group of inlineGroups(root)) {
        expression.lastIndex = 0
        let match
        while (ranges.length < 200 && (match = expression.exec(group.text)) !== null) {
          if (match[0].length === 0) { expression.lastIndex++; continue }
          const range = rangeAt(group, match.index, match.index + match[0].length)
          if (range !== null) ranges.push(range)
        }
      }
      return ranges
    }

    function normalizePhrase(text) {
      return String(text || '').replace(/[\u0001\u0002\u2026]/g, ' ').replace(/\s+/g, ' ').trim()
    }

    function phraseCandidates(snippet) {
      const clean = normalizePhrase(snippet)
      const out = []
      const push = value => {
        const text = String(value || '').trim()
        if (text.length >= 2 && !out.includes(text)) out.push(text)
      }
      if (clean === '') return out
      push(clean)
      const words = clean.split(' ')
      if (words.length > 1) {
        push(words.slice(0, 8).join(' '))
        push(words.slice(0, 4).join(' '))
        push(words.slice(0, 2).join(' '))
      }
      push(clean.slice(0, 24))
      push(clean.slice(0, 12))
      return out
    }

    function phraseRange(root, snippet) {
      if (root === null) return null
      for (const phrase of phraseCandidates(snippet)) {
        const expression = new RegExp(escapeRegExp(phrase), 'iu')
        for (const group of inlineGroups(root)) {
          const match = expression.exec(group.text)
          if (match === null) continue
          const range = rangeAt(group, match.index, match.index + match[0].length)
          if (range !== null) return range
        }
      }
      return null
    }

    function rangeRect(range) {
      for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) return rect
      const rect = range.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? rect : null
    }

    function isScrollable(element) {
      if (!(element instanceof HTMLElement)) return false
      return /(auto|scroll|overlay)/u.test(getComputedStyle(element).overflowY)
        && element.scrollHeight - element.clientHeight > 2
    }

    function scrollChain(element) {
      const chain = []
      for (let node = element; node !== null; node = node.parentElement) if (isScrollable(node)) chain.push(node)
      return chain
    }

    function visibleBand(scroller) {
      const rect = scroller.getBoundingClientRect()
      const seat = scroller.querySelector('[data-composer-seat]')
      const seatRect = seat === null ? null : seat.getBoundingClientRect()
      const bottom = seatRect !== null && seatRect.height > 0 ? Math.min(rect.bottom, seatRect.top) : rect.bottom
      return { top: rect.top, bottom, height: Math.max(0, bottom - rect.top) }
    }

    function centerRange(range) {
      const start = range.startContainer
      const element = start instanceof Element ? start : start.parentElement
      if (element === null) return false
      let moved = false
      for (const scroller of scrollChain(element)) {
        const rect = rangeRect(range)
        if (rect === null) return moved
        const band = visibleBand(scroller)
        if (band.height <= 0) continue
        const next = Math.max(0, Math.min(
          Math.max(0, scroller.scrollHeight - scroller.clientHeight),
          scroller.scrollTop + (rect.top + rect.height / 2) - (band.top + band.height / 2),
        ))
        if (Math.abs(next - scroller.scrollTop) > 1) { scroller.scrollTop = next; moved = true }
      }
      return moved
    }

    function expandHidden(node) {
      let element = node instanceof Element ? node : node.parentElement
      for (; element !== null; element = element.parentElement) {
        if (element.getAttribute('hidden') === 'until-found') {
          element.dispatchEvent(new Event('beforematch'))
        }
      }
    }

    function waitFor(scope, test, timeoutMs, intervalMs) {
      return new Promise(resolve => {
        let settled = false
        const finish = value => {
          if (settled) return
          settled = true
          clearInterval(timer)
          clearTimeout(timeout)
          resolve(value)
        }
        const check = () => {
          try {
            const value = test()
            if (value !== null && value !== undefined) finish(value)
          } catch { /* DOM not ready yet */ }
        }
        const timer = setInterval(check, intervalMs || 120)
        const timeout = setTimeout(() => finish(null), timeoutMs)
        check()
      })
    }

    function waitForScope(sessionId, timeoutMs) {
      return waitFor(document, () => conversationScope(sessionId), timeoutMs, 120)
    }

    function revealOlder(scope) {
      const button = scope === null ? null : scope.querySelector('[data-chat-history] button')
      if (button === null || button.disabled === true) return false
      button.click()
      return true
    }

    let jumpSeq = 0
    let activeHighlight = null

    function clearJumpHighlight() {
      clearFindHighlight('jump')
      if (activeHighlight !== null) {
        const clear = activeHighlight
        activeHighlight = null
        clear()
      }
    }

    function cancelJump() {
      jumpSeq++
      clearJumpHighlight()
    }

    async function jumpToContentHit(hit, query, notify) {
      cancelJump()
      const token = jumpSeq
      const stale = () => token !== jumpSeq
      if (!hit || hit.kind !== 'session' || !hit.sessionId) return false
      if (!workspaceService || typeof workspaceService.openSession !== 'function') return false
      try { workspaceService.openSession(hit.sessionId) } catch { return false }
      const scope = await waitForScope(hit.sessionId, 10_000)
      if (stale()) return false
      if (scope === null) { showNotice(t('jumpFailed')); return false }
      const flow = chatFlow(scope)
      if (flow === null) { showNotice(t('jumpFailed')); return false }
      const needles = needlesFromQuery(query)
      const finder = () => {
        const rows = findMessageRows(flow, hit.messageId, hit.nodeKey)
        if (rows.length > 0) {
          for (const row of rows) {
            expandHidden(row)
            const ranges = rangesForNeedles(row, needles)
            if (ranges.length > 0) return { row, ranges }
            const phrase = phraseRange(row, hit.snippet)
            if (phrase !== null) {
              // Keep the phrase range inside the anchored row instead of
              // falling through to a wrong copy elsewhere in the transcript.
              const inside = row.contains(phrase.commonAncestorContainer)
              if (inside) return { row, ranges: [phrase] }
            }
          }
          return null
        }
        // With an exact node key there is nothing safe to fall back to in the
        // already loaded window; wait for older pages instead of landing on a
        // similar phrase in a different message.
        if (hit.nodeKey || hit.messageId) return null
        const phrase = phraseRange(flow, hit.snippet)
        if (phrase === null) return null
        expandHidden(phrase.startContainer)
        const phraseRow = phrase.startContainer instanceof Element
          ? phrase.startContainer.closest('[data-chat-node-key]')
          : phrase.startContainer.parentElement?.closest('[data-chat-node-key]') ?? null
        const ranges = phraseRow === null ? [phrase] : rangesForNeedles(phraseRow, needles)
        return { row: phraseRow, ranges: ranges.length > 0 ? ranges : [phrase] }
      }
      let target = await waitFor(flow, finder, 6_000, 120)
      for (let attempt = 0; target === null && attempt < 10; attempt++) {
        if (stale()) return false
        if (!revealOlder(scope)) break
        target = await waitFor(flow, finder, 1_500, 150)
      }
      if (stale()) return false
      if (target === null) { showNotice(t('phraseNotFound')); return false }
      setFindHighlight(target.ranges, 0, 'jump')
      centerRange(target.ranges[0])
      const start = target.ranges[0].startContainer
      const chain = scrollChain(start instanceof Element ? start : start.parentElement)
      const scroller = chain.length > 0 ? chain[chain.length - 1] : null
      const lockCleanup = []
      const highlightCleanup = []
      const unlock = () => {
        while (lockCleanup.length > 0) {
          const fn = lockCleanup.pop()
          try { fn() } catch { /* ignore */ }
        }
      }
      const clearHighlight = () => {
        while (highlightCleanup.length > 0) {
          const fn = highlightCleanup.pop()
          try { fn() } catch { /* ignore */ }
        }
        clearFindHighlight('jump')
      }
      // Cancelling must drop the scroll lock too, not only the paint: the lock
      // owns timers and scroll/pointer listeners that would otherwise outlive
      // the highlight.
      activeHighlight = () => { unlock(); clearHighlight() }
      if (scroller !== null) {
        let writing = false
        let expected = scroller.scrollTop
        const recenter = () => {
          if (token !== jumpSeq) return
          const rect = rangeRect(target.ranges[0])
          if (rect === null) { cancelJump(); return }
          writing = true
          centerRange(target.ranges[0])
          expected = scroller.scrollTop
          requestAnimationFrame(() => { writing = false })
        }
        for (const delay of [80, 240, 800, 1600]) {
          const id = setTimeout(recenter, delay)
          lockCleanup.push(() => clearTimeout(id))
        }
        const onUser = () => { if (!writing) unlock() }
        for (const type of GESTURES) {
          scroller.addEventListener(type, onUser, true)
          lockCleanup.push(() => scroller.removeEventListener(type, onUser, true))
        }
        const onScroll = event => {
          if (writing) return
          if (event.target === scroller && Math.abs(scroller.scrollTop - expected) <= 2) return
          unlock()
        }
        scroller.addEventListener('scroll', onScroll, true)
        lockCleanup.push(() => scroller.removeEventListener('scroll', onScroll, true))
      }
      const onKey = event => {
        if (event.key === 'Escape') cancelJump()
      }
      document.addEventListener('keydown', onKey, true)
      highlightCleanup.push(() => document.removeEventListener('keydown', onKey, true))
      const sessionWatch = setInterval(() => {
        if (conversationScope(hit.sessionId) === null) { cancelJump(); return }
        if (target.ranges[0].startContainer.isConnected) return
        const next = finder()
        if (next === null) { cancelJump(); return }
        target = next
        setFindHighlight(target.ranges, 0, 'jump')
        centerRange(target.ranges[0])
      }, 1_000)
      highlightCleanup.push(() => clearInterval(sessionWatch))
      showNotice(t('jumped'))
      return true
    }

    // ── panel ───────────────────────────────────────────────────────────────
    let workspaceService = null
    const PAGE_NAME = 50
    const PAGE_CONTENT = 30

    // ── in-conversation find bar ────────────────────────────────────────────
    const FIND_MAX_MATCHES = 2000
    const FIND_MAX_CHARS = 4_000_000
    const FIND_BLOCK_SELECTOR = 'p,li,pre,td,th,h1,h2,h3,h4,h5,h6,blockquote,dd,dt'
    const FIND_EXCLUDED = '[hidden]:not([hidden="until-found"]),[data-chat-history],[data-text-interaction-surface],'
      + '[data-composer-seat],[data-text-interaction-exclude],script,style,button,input,textarea,select,'
      + '.sr-only,[class*="visuallyHidden"],[role="status"],[aria-live],.katex-mathml,[aria-hidden="true"]:not(.katex-html)'

    function createFindStore() {
      const listeners = new Set()
      let state = {
        open: false, sessionId: '', scope: 'session', selection: null, query: '',
        mode: 'normal', caseSensitive: false, wholeWord: false, wrap: true, direction: 1,
        optionsOpen: false, count: 0, index: -1, capped: false, status: 'idle', error: '', hint: '',
      }
      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(patch) {
          state = { ...state, ...patch }
          for (const listener of listeners) listener()
        },
      }
    }
    const findStore = createFindStore()
    const findApi = { move: () => false, cancel: () => {}, focus: () => {} }
    function useFindState() {
      return useSyncExternalStore(findStore.subscribe, findStore.get, findStore.get)
    }

    function selectionSnapshot(scope) {
      if (scope === null || typeof window.getSelection !== 'function') return null
      const selection = window.getSelection()
      if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return null
      const range = selection.getRangeAt(0).cloneRange()
      if (!scope.contains(range.commonAncestorContainer)) return null
      const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
      if (startEl !== null && startEl.closest('[data-composer-seat]') !== null) return null
      const text = String(selection.toString() || '').replace(/\s+/g, ' ').trim()
      if (text === '') return null
      return { range, text: text.slice(0, 500), chars: text.length }
    }

    function openFind(options) {
      const opts = options || {}
      let scope = opts.sessionId ? conversationScope(opts.sessionId) : null
      if (scope === null) scope = conversationScope('')
      if (scope === null) { showNotice(t('findNoSession')); return false }
      const sessionId = scope.getAttribute('data-conversation-session') || opts.sessionId || ''
      const selection = opts.selection === false ? null : selectionSnapshot(scope)
      const useSelection = opts.selection === true && selection !== null
      findApi.cancel()
      cancelJump()
      if (store.isOpen()) store.set(false)
      findStore.set({
        open: true, sessionId, scope: useSelection ? 'selection' : 'session',
        selection: useSelection ? selection : null, query: '', mode: 'normal',
        caseSensitive: false, wholeWord: false, wrap: true, direction: 1,
        optionsOpen: false, count: 0, index: -1, capped: false, status: 'idle', error: '', hint: '',
      })
      return true
    }

    function closeFind() {
      if (!findStore.get().open) return
      findStore.set({ open: false, selection: null, query: '', error: '', hint: '', status: 'idle' })
      findApi.cancel()
      clearFindHighlight('find')
      setFindScope(null)
    }

    const FIND_WORKER_SRC = `
self.onmessage = event => {
  const { id, pattern, flags, texts } = event.data
  try {
    const re = new RegExp(pattern, flags)
    const out = []
    for (let ti = 0; ti < texts.length; ti++) {
      const text = texts[ti]
      re.lastIndex = 0
      let match
      while ((match = re.exec(text)) !== null) {
        if (match[0].length === 0) { re.lastIndex++; continue }
        out.push([ti, match.index, match.index + match[0].length])
        if (out.length >= 2000) break
      }
      if (out.length >= 2000) break
    }
    self.postMessage({ id, ok: true, matches: out, capped: out.length >= 2000 })
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) })
  }
}
`

    function scanRegexInWorker(texts, source, flags) {
      if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL.createObjectURL !== 'function') {
        return Promise.resolve(null)
      }
      return new Promise(resolve => {
        let worker = null
        let url = ''
        let done = false
        const finish = value => {
          if (done) return
          done = true
          clearTimeout(timer)
          try { if (worker !== null) worker.terminate() } catch { /* ignore */ }
          try { if (url !== '') URL.revokeObjectURL(url) } catch { /* ignore */ }
          resolve(value)
        }
        const timer = setTimeout(() => finish({ timeout: true }), 500)
        try {
          const blob = new Blob([FIND_WORKER_SRC], { type: 'text/javascript' })
          url = URL.createObjectURL(blob)
          worker = new Worker(url)
          worker.onmessage = event => finish(event.data)
          worker.onerror = () => finish(null)
          worker.postMessage({ id: 1, pattern: source, flags, texts })
        } catch {
          finish(null)
        }
      })
    }

    function expandExtended(input) {
      let out = ''
      for (let index = 0; index < input.length; index++) {
        const char = input[index]
        if (char !== '\\') { out += char; continue }
        const next = input[index + 1]
        if (next === undefined) { out += '\\'; continue }
        index++
        if (next === 'n') out += '\n'
        else if (next === 'r') out += '\r'
        else if (next === 't') out += '\t'
        else if (next === '0') out += '\u0000'
        else if (next === '\\') out += '\\'
        else if (next === 'x') {
          const hex = input.slice(index + 1, index + 3)
          if (!/^[0-9a-fA-F]{2}$/u.test(hex)) return { error: '\\x' }
          out += String.fromCharCode(parseInt(hex, 16))
          index += 2
        } else if (next === 'u') {
          const hex = input.slice(index + 1, index + 5)
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) return { error: '\\u' }
          out += String.fromCharCode(parseInt(hex, 16))
          index += 4
        } else out += '\\' + next
      }
      return { value: out }
    }

    function compileFind(query, mode, caseSensitive) {
      let source = String(query || '')
      if (mode === 'extended') {
        const expanded = expandExtended(source)
        if (expanded.error !== undefined) return { error: t('findInvalidEscape', { token: expanded.error }) }
        source = expanded.value
      }
      if (mode !== 'regex') source = escapeRegExp(source)
      const flags = 'g' + (caseSensitive ? '' : 'i')
      // Prefer the Unicode flag so \p{...}, astral literals and modern syntax
      // behave as users expect. Fall back once for legacy patterns that the
      // unicode grammar rejects (for example some lone escapes).
      try {
        return { source, flags: flags + 'u', re: new RegExp(source, flags + 'u') }
      } catch (error) {
        try {
          return { source, flags, re: new RegExp(source, flags) }
        } catch (fallbackError) {
          return { error: t('findInvalidRegex', { message: String(fallbackError && fallbackError.message || fallbackError).slice(0, 140) }) }
        }
      }
    }

    function isWordCharacter(char) {
      return typeof char === 'string' && char !== '' && /^[A-Za-z0-9_]$/u.test(char)
    }

    function wholeWordAt(text, start, end) {
      return !isWordCharacter(text[start - 1]) && !isWordCharacter(text[end])
    }

    function collectFindGroups(root) {
      return projectGroups(root, FIND_EXCLUDED)
    }

    function clipForGroup(group, range) {
      if (range === null) return null
      let rawStart = null
      let rawEnd = null
      for (const entry of group.nodes) {
        const node = entry.node
        const length = entry.end - entry.start
        try {
          if (!range.intersectsNode(node)) continue
        } catch { continue }
        let nodeStart = 0
        let nodeEnd = length
        if (node === range.startContainer) nodeStart = range.startOffset
        if (node === range.endContainer) nodeEnd = range.endOffset
        if (nodeStart < nodeEnd) {
          if (rawStart === null) rawStart = entry.start + nodeStart
          rawEnd = entry.start + nodeEnd
        }
      }
      if (rawStart === null || rawEnd === null) return null
      const start = rawToProjected(group, rawStart)
      const end = rawToProjected(group, rawEnd)
      if (start >= end) return null
      return [start, end]
    }

    function rangeForGroupOffsets(group, start, end) {
      if (group.nodes.length === 0) return null
      return rangeAt(group, start, end)
    }

    function findHistoryButton(scope) {
      return scope === null ? null : scope.querySelector('[data-chat-history] button')
    }

    function FindToggle(props) {
      const onClick = () => { openFind({ sessionId: props && props.sessionId ? props.sessionId : '', selection: false }) }
      return h('button', {
        className: 'dsh-locator-launch',
        title: t('findOpen') + ' (Ctrl+F)',
        'aria-label': t('findOpen'),
        onClick,
      }, '⌕')
    }

    function FindBar() {
      const state = useFindState()
      const inputRef = useRef(null)
      const barRef = useRef(null)
      const scopeRef = useRef(null)
      const matchesRef = useRef([])
      const activeRef = useRef(-1)
      const sequenceRef = useRef(0)
      const debounceRef = useRef(0)
      const observerRef = useRef(null)
      const revealTimersRef = useRef([])
      const revealFrameRef = useRef(0)
      const loadOlderTimerRef = useRef(0)
      const returnFocusRef = useRef(null)
      const [anchor, setAnchor] = useState(null)
      const composingRef = useRef(false)

      const applyHighlight = useCallback((index) => {
        const matches = matchesRef.current
        if (matches.length === 0) { clearFindHighlight('find'); setFindScope(null); return }
        const safe = Math.max(0, Math.min(matches.length - 1, index))
        activeRef.current = safe
        setFindHighlight(matches.map(match => match.range), safe, 'find')
        setFindScope(state.scope === 'selection' && state.selection ? state.selection.range : null)
      }, [state.scope, state.selection])

      const revealActive = useCallback(() => {
        const match = matchesRef.current[activeRef.current]
        if (!match || !match.range.startContainer.isConnected) return false
        expandHidden(match.range.startContainer)
        const run = () => {
          if (!match.range.startContainer.isConnected) return
          centerRange(match.range)
        }
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(revealFrameRef.current)
        revealFrameRef.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : 0
        if (revealFrameRef.current === 0) run()
        for (const delay of [80, 240]) {
          const timer = setTimeout(run, delay)
          revealTimersRef.current.push(timer)
        }
        return true
      }, [])

      const move = useCallback(delta => {
        const matches = matchesRef.current
        if (matches.length === 0) return false
        const direction = delta === 0 ? (findStore.get().direction === -1 ? -1 : 1) : delta
        if (!findStore.get().wrap && (activeRef.current + direction >= matches.length || activeRef.current + direction < 0)) {
          findStore.set({ hint: direction > 0 ? t('findNoWrapEnd') : t('findNoWrapStart') })
          return false
        }
        let next = activeRef.current + direction
        if (next >= matches.length) next = 0
        if (next < 0) next = matches.length - 1
        const wrapped = (activeRef.current + direction >= matches.length) || (activeRef.current + direction < 0)
        activeRef.current = next
        applyHighlight(next)
        findStore.set({
          index: next,
          hint: wrapped ? (direction > 0 ? t('findWrappedTop') : t('findWrappedBottom')) : '',
        })
        revealActive()
        return true
      }, [applyHighlight, revealActive])

      const runScan = useCallback(async (keepActive) => {
        const token = ++sequenceRef.current
        const scope = scopeRef.current || conversationScope(state.sessionId) || conversationScope('')
        if (scope === null) { return }
        scopeRef.current = scope
        if (state.query === '') {
          matchesRef.current = []
          activeRef.current = -1
          clearFindHighlight('find')
          setFindScope(state.scope === 'selection' && state.selection ? state.selection.range : null)
          findStore.set({ count: 0, index: -1, capped: false, status: 'idle', error: '', hint: '' })
          return
        }
        const compiled = compileFind(state.query, state.mode, state.caseSensitive)
        if (compiled.error !== undefined) {
          matchesRef.current = []
          activeRef.current = -1
          clearFindHighlight('find')
          findStore.set({ count: 0, index: -1, capped: false, status: 'error', error: compiled.error })
          return
        }
        let selectionRange = null
        if (state.scope === 'selection' && state.selection) {
          selectionRange = state.selection.range
          let selectionDead = !selectionRange.startContainer.isConnected || selectionRange.collapsed
          if (!selectionDead) {
            try { selectionDead = selectionRange.toString().trim() === '' } catch { selectionDead = true }
          }
          if (selectionDead) {
            findStore.set({ scope: 'session', selection: null, hint: t('findSelectionLost') })
            return
          }
        }
        const groups = collectFindGroups(scope)
        const texts = []
        const clips = []
        let chars = 0
        for (const group of groups) {
          const clip = selectionRange === null ? null : clipForGroup(group, selectionRange)
          if (selectionRange !== null && clip === null) { texts.push(null); clips.push(null); continue }
          const start = clip === null ? 0 : clip[0]
          const end = clip === null ? group.text.length : clip[1]
          const text = group.text.slice(start, end)
          chars += text.length
          if (chars > FIND_MAX_CHARS) { texts.push(null); clips.push(null); continue }
          texts.push(text)
          clips.push(clip === null ? [0, group.text.length] : clip)
        }
        if (selectionRange !== null && clips.every(clip => clip === null)) {
          findStore.set({ scope: 'session', selection: null, hint: t('findSelectionLost') })
          return
        }
        let rawMatches = null
        let capped = false
        if (state.mode === 'regex') {
          try {
            const result = await scanRegexInWorker(texts.filter(text => text !== null), compiled.source, compiled.flags)
            if (token !== sequenceRef.current) return
            if (result === null) {
              findStore.set({ count: 0, index: -1, capped: false, status: 'error', error: t('findRegexUnavailable') })
              return
            }
            if (result !== null) {
              if (result.timeout === true) {
                matchesRef.current = []
                clearFindHighlight('find')
                findStore.set({ count: 0, index: -1, capped: false, status: 'error', error: t('findTimeout') })
                return
              }
              if (result.ok === false) {
                matchesRef.current = []
                clearFindHighlight('find')
                findStore.set({ count: 0, index: -1, capped: false, status: 'error', error: t('findInvalidRegex', { message: String(result.error || '') }) })
                return
              }
              const compact = []
              let cursor = 0
              for (let groupIndex = 0; groupIndex < texts.length; groupIndex++) {
                if (texts[groupIndex] === null) continue
                compact.push(groupIndex)
                cursor++
              }
              rawMatches = []
              for (const item of result.matches) {
                const groupIndex = compact[item[0]]
                if (groupIndex === undefined) continue
                rawMatches.push({ groupIndex, start: item[1] + clips[groupIndex][0], end: item[2] + clips[groupIndex][0] })
              }
              capped = result.capped === true
            }
          } catch { /* fall back below */ }
        }
        if (rawMatches === null) {
          rawMatches = []
          const re = new RegExp(compiled.source, compiled.flags)
          const started = performance.now()
          for (let groupIndex = 0; groupIndex < texts.length; groupIndex++) {
            const text = texts[groupIndex]
            if (text === null) continue
            re.lastIndex = 0
            let match
            while ((match = re.exec(text)) !== null) {
              if (match[0].length === 0) { re.lastIndex++; continue }
              const start = clips[groupIndex][0] + match.index
              const end = start + match[0].length
              if (state.wholeWord && !wholeWordAt(groups[groupIndex].text, start, end)) continue
              rawMatches.push({ groupIndex, start, end })
              if (rawMatches.length >= FIND_MAX_MATCHES) break
            }
            if (rawMatches.length >= FIND_MAX_MATCHES) break
            if (performance.now() - started > 1500) { capped = true; break }
          }
          capped = capped || rawMatches.length >= FIND_MAX_MATCHES
        } else if (state.wholeWord) {
          rawMatches = rawMatches.filter(raw => {
            const group = groups[raw.groupIndex]
            return group !== undefined && wholeWordAt(group.text, raw.start, raw.end)
          })
          capped = capped || rawMatches.length >= FIND_MAX_MATCHES
        }
        if (token !== sequenceRef.current) return
        const matches = []
        for (const raw of rawMatches) {
          const group = groups[raw.groupIndex]
          if (group === undefined) continue
          const range = rangeForGroupOffsets(group, raw.start, raw.end)
          if (range === null) continue
          const row = group.block.closest('[data-chat-node-key]')
          matches.push({ range, rowKey: row === null ? '' : (row.getAttribute('data-chat-node-key') || '') })
        }
        if (token !== sequenceRef.current) return
        matchesRef.current = matches
        const next = matches.length === 0 ? -1 : (keepActive && activeRef.current >= 0 ? Math.min(activeRef.current, matches.length - 1) : 0)
        activeRef.current = next
        const history = findHistoryButton(scopeRef.current)
        findStore.set({
          count: matches.length,
          index: next,
          capped,
          status: matches.length === 0 ? 'none' : 'idle',
          error: '',
          hint: matches.length === 0 && history !== null && !history.disabled ? t('findLoadedOnly') : '',
        })
        if (next >= 0) { applyHighlight(next); revealActive() }
        else { clearFindHighlight('find'); setFindScope(state.scope === 'selection' && state.selection ? state.selection.range : null) }
      }, [applyHighlight, revealActive, state.caseSensitive, state.mode, state.query, state.scope, state.selection, state.sessionId, state.wholeWord])
      const runScanRef = useRef(runScan)
      runScanRef.current = runScan

      useEffect(() => {
        if (!state.open) return undefined
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const measure = () => {
          const scope = conversationScope(findStore.get().sessionId) || conversationScope('')
          if (scope === null) { closeFind(); return }
          scopeRef.current = scope
          const rect = scope.getBoundingClientRect()
          const width = Math.max(280, Math.min(560, rect.width - 24))
          setAnchor({ top: Math.max(8, rect.top + 8), right: Math.max(8, window.innerWidth - rect.right + 12), width })
        }
        measure()
        const timer = setTimeout(() => {
          if (inputRef.current !== null) { inputRef.current.focus(); inputRef.current.select() }
        }, 0)
        const onResize = () => measure()
        window.addEventListener('resize', onResize)
        let observer = null
        const schedule = () => {
          clearTimeout(debounceRef.current)
          debounceRef.current = setTimeout(() => { if (findStore.get().open) void runScanRef.current(true) }, 400)
        }
        const scope = scopeRef.current
        const observed = scope === null ? null : (chatFlow(scope) || scope)
        if (observed !== null) {
          try {
            observer = new MutationObserver(schedule)
            observer.observe(observed, { childList: true, subtree: true, characterData: true })
          } catch { /* observer unavailable */ }
        }
        return () => {
          clearTimeout(timer)
          window.removeEventListener('resize', onResize)
          clearTimeout(debounceRef.current)
          if (observer !== null) observer.disconnect()
          for (const id of revealTimersRef.current) clearTimeout(id)
          revealTimersRef.current = []
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(revealFrameRef.current)
          clearTimeout(loadOlderTimerRef.current)
          sequenceRef.current++
          clearFindHighlight('find')
          setFindScope(null)
          const target = returnFocusRef.current
          if (target !== null && target.isConnected) target.focus({ preventScroll: true })
        }
      }, [state.open])

      useEffect(() => {
        if (!state.open) return undefined
        const timer = setTimeout(() => { void runScan(false) }, 150)
        return () => clearTimeout(timer)
      }, [state.open, state.query, state.mode, state.caseSensitive, state.wholeWord, state.scope, state.sessionId, state.selection, runScan])

      // Close when the conversation is switched, hidden, or the panel opens.
      useEffect(() => {
        if (!state.open) return undefined
        const timer = setInterval(() => {
          if (!findStore.get().open) return
          if (store.isOpen()) { closeFind(); return }
          if (conversationScope(findStore.get().sessionId) === null) closeFind()
        }, 800)
        return () => clearInterval(timer)
      }, [state.open])

      useEffect(() => {
        findApi.move = delta => move(delta)
        findApi.cancel = () => { sequenceRef.current++ }
        findApi.focus = () => { if (inputRef.current !== null) { inputRef.current.focus(); inputRef.current.select() } }
        return () => { findApi.move = () => false; findApi.cancel = () => {}; findApi.focus = () => {} }
      }, [move])

      if (!state.open) return null
      const onInput = event => { findStore.set({ query: event.target.value, error: '', hint: '' }) }
      const onKeyDown = event => {
        if (composingRef.current || event.isComposing) return
        if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 0); return }
        if (event.key === 'Escape') { event.preventDefault(); closeFind(); return }
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && String(event.key).toLowerCase() === 'c') {
          const match = matchesRef.current[activeRef.current]
          const text = match && match.range.startContainer.isConnected ? match.range.toString() : findStore.get().query
          if (text !== '') { event.preventDefault(); copyText(text).then(() => findStore.set({ hint: t('findCopied') })).catch(() => {}) }
        }
      }
      const pickMode = event => {
        findStore.set({ mode: event.target.value })
        if (inputRef.current !== null) inputRef.current.focus()
      }
      const toggle = key => { findStore.set({ [key]: !findStore.get()[key] }) }
      const toggleScope = () => {
        if (state.scope === 'selection') findStore.set({ scope: 'session', selection: null, hint: '' })
        else {
          const scope = scopeRef.current
          const selection = scope === null ? null : selectionSnapshot(scope)
          if (selection === null) { findStore.set({ hint: t('findPlaceholderSelection') }); return }
          findStore.set({ scope: 'selection', selection })
        }
      }
      const countText = state.query === '' ? '—'
        : (state.count === 0 ? '0/0' : (state.index < 0 ? '…' : (state.index + 1) + '/' + state.count + (state.capped ? '+' : '')))
      const history = scopeRef.current === null ? null : findHistoryButton(scopeRef.current)
      const canLoadOlder = history !== null && !history.disabled
      const loadOlder = () => {
        if (scopeRef.current === null || !revealOlder(scopeRef.current)) return
        findStore.set({ hint: t('findLoadingOlder') })
        clearTimeout(loadOlderTimerRef.current)
        loadOlderTimerRef.current = setTimeout(() => { if (findStore.get().open) void runScanRef.current(true) }, 700)
      }
      return h('div', {
        ref: barRef,
        className: 'dsh-locator-findbar',
        role: 'search',
        'aria-label': t('findAria'),
        style: anchor === null ? { top: 12, right: 12, width: 'min(560px,calc(100vw - 24px))' } : { top: anchor.top, right: anchor.right, width: anchor.width },
      },
        h('div', { className: 'dsh-locator-findbar-main' },
          h('span', { className: 'dsh-locator-findbar-glyph', 'aria-hidden': 'true' }, '⌕'),
          h('input', {
            ref: inputRef,
            className: 'dsh-locator-findbar-input',
            value: state.query,
            placeholder: state.scope === 'selection' ? t('findPlaceholderSelection') : t('findPlaceholder'),
            'aria-label': t('findAria'),
            'aria-invalid': state.error !== '' ? 'true' : undefined,
            spellCheck: false,
            autoComplete: 'off',
            onInput,
            onKeyDown,
            onCompositionStart: () => { composingRef.current = true },
            onCompositionEnd: () => { composingRef.current = false; void runScan(false) },
          }),
          h('span', { className: 'dsh-locator-findbar-count', 'aria-hidden': 'true' }, countText),
          h('span', { style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
            state.error !== '' ? state.error
              : state.query === '' ? ''
                : state.count === 0 ? t('findNoMatch')
                  : (state.index + 1) + '/' + state.count),
          h('button', { className: 'dsh-locator-findbar-btn', title: t('findPrev'), 'aria-label': t('findPrev'),
            disabled: state.count === 0, onMouseDown: event => event.preventDefault(), onClick: () => move(-1) }, '↑'),
          h('button', { className: 'dsh-locator-findbar-btn', title: t('findNext'), 'aria-label': t('findNext'),
            disabled: state.count === 0, onMouseDown: event => event.preventDefault(), onClick: () => move(1) }, '↓'),
          h('button', { className: 'dsh-locator-findbar-btn', title: t('findClose'), 'aria-label': t('findClose'),
            onClick: () => closeFind() }, '×'),
        ),
        h('div', { className: 'dsh-locator-findbar-opts', onMouseDown: event => {
          if (event.target instanceof HTMLSelectElement) return
          event.preventDefault()
        } },
          h('label', { className: 'dsh-locator-findbar-label' }, t('findMode'),
            h('select', { value: state.mode, onChange: pickMode, 'aria-label': t('findMode') },
              h('option', { value: 'normal' }, t('modeNormal')),
              h('option', { value: 'extended' }, t('modeExtended')),
              h('option', { value: 'regex' }, t('modeRegex')),
            )),
          h('button', { className: 'dsh-locator-findbar-btn', title: t('findCase'), 'aria-label': t('findCase'),
            'aria-pressed': state.caseSensitive ? 'true' : 'false', onClick: () => toggle('caseSensitive') }, t('panelCaseShort')),
          h('button', { className: 'dsh-locator-findbar-btn', title: t('findWhole'), 'aria-label': t('findWhole'),
            'aria-pressed': state.wholeWord ? 'true' : 'false', onClick: () => toggle('wholeWord') }, t('panelWholeShort')),
          h('button', { className: 'dsh-locator-findbar-btn', title: t('findWrap'), 'aria-label': t('findWrap'),
            'aria-pressed': state.wrap ? 'true' : 'false', onClick: () => toggle('wrap') }, '↻'),
          h('button', { className: 'dsh-locator-findbar-btn', title: t('findReverse'), 'aria-label': t('findReverse'),
            'aria-pressed': state.direction === -1 ? 'true' : 'false', onClick: () => findStore.set({ direction: state.direction === -1 ? 1 : -1 }) }, '⇅'),
          h('button', { className: 'dsh-locator-findbar-btn', title: t('findScope'), 'aria-label': t('findScope'),
            'aria-pressed': state.scope === 'selection' ? 'true' : 'false', onClick: toggleScope }, '⛶'),
          state.scope === 'selection' && state.selection
            ? h('span', { className: 'dsh-locator-findbar-chip' }, t('findScopeChip', { n: state.selection.chars }),
              h('button', { onClick: () => findStore.set({ scope: 'session', selection: null, hint: '' }), 'aria-label': t('findClose') }, '×'))
            : h('span', { className: 'dsh-locator-findbar-chip' }, t('findSessionChip')),
          state.mode === 'extended' ? h('span', { className: 'dsh-locator-findbar-label', style: { opacity: .55 } }, t('findExtendedHelp')) : null,
        ),
        state.error !== '' ? h('div', { className: 'dsh-locator-findbar-error', role: 'alert' }, state.error) : null,
        h('div', { className: 'dsh-locator-findbar-status' },
          h('span', null, state.query === '' ? t('findEmpty') : state.count === 0 ? t('findNoMatch') : (state.capped ? t('findCapped') : '')),
          state.hint !== '' ? h('span', null, state.hint) : null,
          h('span', { className: 'grow' }),
          canLoadOlder && state.query !== '' && state.count === 0
            ? h('button', { className: 'dsh-locator-dirbtn', onClick: loadOlder }, t('findOlder'))
            : null,
          h('kbd', null, 'Enter'), h('span', null, '↓'),
          h('kbd', null, 'Shift+Enter'), h('span', null, '↑'),
          h('kbd', null, 'Esc'),
        ),
      )
    }

    const PANEL_HISTORY_KEY = 'dsh-locator-panel-history-v1'
    function readPanelHistory() {
      try {
        const parsed = JSON.parse(localStorage.getItem(PANEL_HISTORY_KEY) || '[]')
        return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string').slice(0, 10) : []
      } catch { return [] }
    }
    function writePanelHistory(list) {
      try { localStorage.setItem(PANEL_HISTORY_KEY, JSON.stringify(list.slice(0, 10))) } catch { /* ignore */ }
    }

    function Panel() {
      const open = useOpen()
      const prefs = useMemo(readPrefs, [])
      const [query, setQuery] = useState('')
      const [sort, setSort] = useState(prefs.sort)
      const [desc, setDesc] = useState(prefs.desc)
      const [scopes, setScopes] = useState(prefs.scopes)
      const [groups, setGroups] = useState(null)
      const [loading, setLoading] = useState(false)
      const [loadingMore, setLoadingMore] = useState(false)
      const [filter, setFilter] = useState('')
      const [history, setHistory] = useState(readPanelHistory)
      const [offsets, setOffsets] = useState({ files: 0, dirs: 0, content: 0 })
      const [error, setError] = useState('')
      const [took, setTook] = useState(0)
      const [status, setStatus] = useState(null)
      const [availableContent, setAvailableContent] = useState(true)
      const [matchMode, setMatchMode] = useState(prefs.matchMode || 'normal')
      const [caseSensitive, setCaseSensitive] = useState(prefs.caseSensitive === true)
      const [wholeWord, setWholeWord] = useState(prefs.wholeWord === true)
      const [sessionOnly, setSessionOnly] = useState(false)
      const [selected, setSelected] = useState(0)
      const [toast, setToast] = useState('')
      const [refreshTick, setRefreshTick] = useState(0)
      const inputRef = useRef(null)
      const panelRef = useRef(null)
      const abortRef = useRef(null)
      const listRef = useRef(null)
      const toastTimerRef = useRef(0)
      const insertTimerRef = useRef(0)

      const close = useCallback(() => store.set(false), [])
      const activeScope = conversationScope('')
      const activeSessionId = activeScope === null ? '' : (activeScope.getAttribute('data-conversation-session') || '')
      const effectiveScopes = sessionOnly
        ? { content: scopes.content, files: false, dirs: false }
        : { content: scopes.content, files: scopes.files, dirs: scopes.dirs }
      const anyScope = effectiveScopes.content || effectiveScopes.files || effectiveScopes.dirs

      useEffect(() => {
        writePrefs({ scopes, sort, desc, matchMode, caseSensitive, wholeWord })
      }, [scopes, sort, desc, matchMode, caseSensitive, wholeWord])

      useEffect(() => {
        if (!open) return undefined
        const text = query.trim()
        if (text.length < 2) return undefined
        const timer = setTimeout(() => {
          setHistory(previous => {
            if (previous[0] === text) return previous
            const next = [text, ...previous.filter(value => value !== text)].slice(0, 10)
            writePanelHistory(next)
            return next
          })
        }, 900)
        return () => clearTimeout(timer)
      }, [open, query])

      useEffect(() => {
        if (!open) return undefined
        if (sessionOnly && activeSessionId === '') setSessionOnly(false)
        closeFind()
        setGroups(null)
        const previous = document.activeElement
        setError('')
        const timer = setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus()
            if (inputRef.current.value !== '') inputRef.current.select()
          }
        }, 30)
        return () => {
          clearTimeout(timer)
          if (abortRef.current !== null) { abortRef.current.abort(); abortRef.current = null }
          setGroups(null)
          if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
        }
      }, [open, sessionOnly, activeSessionId])

      useEffect(() => {
        if (!open) return undefined
        const onDocumentKey = event => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          const target = event.target
          if (target instanceof Element && target.closest('.dsh-locator-panel') !== null) return
          event.preventDefault()
          close()
        }
        document.addEventListener('keydown', onDocumentKey, true)
        return () => document.removeEventListener('keydown', onDocumentKey, true)
      }, [open, close])

      useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        let timer = 0
        const load = () => {
          post('/dsh-locator/status', {}).then(next => {
            if (cancelled) return
            setStatus(next)
            if (next && next.content && next.content.enabled === false) {
              setAvailableContent(false)
              setScopes(value => (value.content ? { ...value, content: false } : value))
            }
            if (next && next.scanning) timer = setTimeout(load, 1500)
          }).catch(() => {})
        }
        load()
        return () => { cancelled = true; clearTimeout(timer) }
      }, [open])

      // One request for every enabled scope; the server owns the grouping and
      // de-duplication. Empty and one-character queries never start a content
      // build (see src/combined.ts), so opening the panel stays cheap.
      useEffect(() => {
        if (!open) return undefined
        if (!anyScope) {
          setGroups(null)
          setLoading(false)
          setError('')
          return undefined
        }
        const timer = setTimeout(() => {
          if (abortRef.current) abortRef.current.abort()
          const controller = new AbortController()
          abortRef.current = controller
          setLoading(true)
          setError('')
          setOffsets({ files: 0, dirs: 0, content: 0 })
          post('/dsh-locator/combined', {
            query,
            content: effectiveScopes.content,
            files: effectiveScopes.files,
            dirs: effectiveScopes.dirs,
            limit: PAGE_NAME,
            contentLimit: PAGE_CONTENT,
            filesOffset: 0,
            dirsOffset: 0,
            contentOffset: 0,
            sort,
            desc,
            matchMode,
            caseSensitive,
            wholeWord,
            sessionId: sessionOnly ? activeSessionId : '',
            count: matchMode === 'regex' ? 'none' : 'exact',
          }, controller.signal).then(data => {
            if (controller.signal.aborted) return
            setGroups({
              content: data.content,
              files: data.files,
              dirs: data.dirs,
            })
            setOffsets({
              files: data.files?.returned ?? 0,
              dirs: data.dirs?.returned ?? 0,
              content: data.content?.returned ?? 0,
            })
            if (typeof data.contentEnabled === 'boolean') setAvailableContent(data.contentEnabled)
            setTook(typeof data.tookMs === 'number' ? data.tookMs : 0)
            setLoading(false)
          }).catch(cause => {
            if (controller.signal.aborted) return
            setError(cause instanceof Error ? cause.message : String(cause))
            setLoading(false)
          })
        }, 140)
        return () => clearTimeout(timer)
      }, [open, query, sort, desc, scopes.content, scopes.files, scopes.dirs, matchMode, caseSensitive, wholeWord, sessionOnly, activeSessionId, refreshTick, anyScope, effectiveScopes.content, effectiveScopes.files, effectiveScopes.dirs])

      const contentBuilding = groups !== null && groups.content !== undefined && groups.content.building === true
      useEffect(() => {
        if (!open || !contentBuilding) return undefined
        const timer = setTimeout(() => setRefreshTick(value => value + 1), 2500)
        return () => clearTimeout(timer)
      }, [open, contentBuilding, refreshTick])

      const panelHitKey = (group, hit) => group + '|' + String(hit.path || '') + '|' + String(hit.messageId || '')
      const rows = useMemo(() => {
        if (groups === null) return []
        const needle = filter.trim().toLowerCase()
        const out = []
        for (const group of ['content', 'files', 'dirs']) {
          if (!effectiveScopes[group]) continue
          const hits = groups[group] && Array.isArray(groups[group].hits) ? groups[group].hits : []
          for (const hit of hits) {
            if (needle !== '') {
              const haystack = [hit.path, hit.name, hit.title, hit.snippet].filter(value => typeof value === 'string').join(' ').toLowerCase()
              if (!haystack.includes(needle)) continue
            }
            out.push({ group, hit })
          }
        }
        return out
      }, [groups, effectiveScopes.content, effectiveScopes.files, effectiveScopes.dirs, filter])
      const rowIndexByKey = useMemo(() => new Map(rows.map((entry, index) => [panelHitKey(entry.group, entry.hit), index])), [rows])

      useEffect(() => {
        setSelected(value => Math.min(Math.max(0, value), Math.max(0, rows.length - 1)))
      }, [rows.length])

      useEffect(() => {
        if (!open) return
        const row = document.getElementById('dsh-locator-opt-' + selected)
        if (row !== null) row.scrollIntoView({ block: 'nearest' })
      }, [open, selected, rows.length])

      const notify = useCallback(message => {
        setToast(message)
        clearTimeout(toastTimerRef.current)
        toastTimerRef.current = setTimeout(() => setToast(''), 1600)
      }, [])
      useEffect(() => () => {
        clearTimeout(toastTimerRef.current)
        clearTimeout(insertTimerRef.current)
      }, [])

      const copy = useCallback(hit => {
        if (!hit) return
        copyText(hit.path).then(() => notify(t('copiedPath'))).catch(() => {})
      }, [notify])

      const copyAll = useCallback(() => {
        const paths = rows.map(entry => entry.hit.path).filter(path => typeof path === 'string' && path !== '')
        if (paths.length === 0) return
        copyText(paths.join('\n')).then(() => notify(t('copiedAll', { n: paths.length }))).catch(() => {})
      }, [notify, rows])

      const reveal = useCallback(hit => {
        if (!hit || loading) return
        post('/dsh-locator/reveal', { path: hit.path }).then(() => notify(t('revealed'))).catch(() => copy(hit))
      }, [copy, loading, notify])

      const openFile = useCallback(hit => {
        if (!hit || hit.dir || loading) return
        post('/dsh-locator/open', { path: hit.path }).then(() => notify(t('opened'))).catch(() => copy(hit))
      }, [copy, loading, notify])

      const activate = useCallback(hit => {
        if (!hit || loading) return
        if (hit.kind === 'session' && hit.sessionId) {
          close()
          void jumpToContentHit(hit, query, notify)
          return
        }
        reveal(hit)
      }, [close, loading, notify, query, reveal])

      const insert = useCallback(hit => {
        if (!hit || hit.kind === 'session' || loading) return
        const mention = '@"' + hit.path.replace(/"/g, '') + '" '
        close()
        clearTimeout(insertTimerRef.current)
        insertTimerRef.current = setTimeout(() => {
          if (insertIntoComposer(mention)) notify(t('inserted'))
          else copyText(mention).then(() => notify(t('insertFailed'))).catch(() => {})
        }, 80)
      }, [close, loading, notify])

      const toggleScope = useCallback(key => {
        if (key === 'content' && !availableContent) return
        setScopes(value => ({ ...value, [key]: !value[key] }))
      }, [availableContent])

      const onKeyDown = useCallback(event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
          return
        }
        if (event.key === 'Tab') {
          const panel = panelRef.current
          if (!panel) return
          const focusables = [...panel.querySelectorAll('input,select,button')].filter(element => !element.disabled)
          if (focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          return
        }
        const interactive = event.target instanceof HTMLElement
          && (event.target.tagName === 'BUTTON' || event.target.tagName === 'SELECT'
            || (event.target.tagName === 'INPUT' && event.target.type !== 'text'))
        if (interactive) return
        const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')
        const scopeDigit = event.altKey && !event.ctrlKey && !event.metaKey && !altGraph
          ? (event.code === 'Digit1' ? '1' : event.code === 'Digit2' ? '2' : event.code === 'Digit3' ? '3' : ['1', '2', '3'].includes(event.key) ? event.key : '')
          : ''
        if (scopeDigit !== '') {
          event.preventDefault()
          toggleScope(scopeDigit === '1' ? 'content' : scopeDigit === '2' ? 'files' : 'dirs')
          return
        }
        if (event.key === 'F3') {
          event.preventDefault()
          if (rows.length > 0) setSelected(value => (value + (event.shiftKey ? -1 : 1) + rows.length) % rows.length)
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setSelected(value => Math.max(0, Math.min(rows.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))))
          return
        }
        if ((event.key === 'Home' || event.key === 'End') && event.target === inputRef.current) return
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          setSelected(event.key === 'Home' ? 0 : Math.max(0, rows.length - 1))
          return
        }
        if (event.key === 'PageDown' || event.key === 'PageUp') {
          event.preventDefault()
          setSelected(value => Math.max(0, Math.min(rows.length - 1, value + (event.key === 'PageDown' ? 8 : -8))))
          return
        }
        if (event.key === 'Enter' && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          activate(rows[selected]?.hit)
          return
        }
        const modifier = event.ctrlKey || event.metaKey
        if (modifier && event.shiftKey && String(event.key).toLowerCase() === 'c') {
          event.preventDefault()
          copy(rows[selected]?.hit)
          return
        }
        if (modifier && event.shiftKey && String(event.key).toLowerCase() === 'o') {
          event.preventDefault()
          reveal(rows[selected]?.hit)
          return
        }
        if (modifier && String(event.key).toLowerCase() === 'o') {
          event.preventDefault()
          openFile(rows[selected]?.hit)
          return
        }
        if (modifier && event.key === 'Enter' && !event.isComposing) {
          event.preventDefault()
          insert(rows[selected]?.hit)
        }
      }, [activate, close, copy, insert, loading, openFile, reveal, rows, selected, toggleScope])

      useEffect(() => {
        const list = listRef.current
        if (!list) return
        const row = list.querySelector('[data-index="' + selected + '"]')
        if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
      }, [selected])

      const loadMore = useCallback(async () => {
        if (loading || loadingMore || groups === null) return
        setLoadingMore(true)
        setError('')
        try {
          const data = await post('/dsh-locator/combined', {
            query,
            content: effectiveScopes.content,
            files: effectiveScopes.files,
            dirs: effectiveScopes.dirs,
            limit: PAGE_NAME,
            contentLimit: PAGE_CONTENT,
            filesOffset: offsets.files,
            dirsOffset: offsets.dirs,
            contentOffset: offsets.content,
            sort,
            desc,
            matchMode,
            caseSensitive,
            wholeWord,
            sessionId: sessionOnly ? activeSessionId : '',
            count: matchMode === 'regex' ? 'none' : 'exact',
          })
          setGroups(previous => {
            if (previous === null) return previous
            const merged = { ...previous }
            for (const key of ['content', 'files', 'dirs']) {
              const oldGroup = previous[key]
              const nextGroup = data[key]
              if (oldGroup === undefined || nextGroup === undefined) continue
              const oldHits = Array.isArray(oldGroup.hits) ? oldGroup.hits : []
              const nextHits = Array.isArray(nextGroup.hits) ? nextGroup.hits : []
              const seen = new Set(oldHits.map(hit => panelHitKey(key, hit)))
              const added = nextHits.filter(hit => !seen.has(panelHitKey(key, hit)))
              merged[key] = {
                ...nextGroup,
                hits: [...oldHits, ...added],
                returned: oldHits.length + added.length,
                total: Math.max(oldGroup.total ?? 0, nextGroup.total ?? 0),
                count: oldGroup.count?.kind === 'exact' ? oldGroup.count : nextGroup.count,
              }
            }
            // Keep the one-row-per-path invariant across pages too.
            const contentPaths = new Set((merged.content?.hits ?? []).map(hit => hit.path))
            if (merged.files !== undefined) {
              merged.files = { ...merged.files, hits: (merged.files.hits ?? []).filter(hit => !contentPaths.has(hit.path)) }
              merged.files.returned = merged.files.hits.length
            }
            return merged
          })
          setOffsets(current => ({
            files: current.files + (data.files?.returned ?? 0),
            dirs: current.dirs + (data.dirs?.returned ?? 0),
            content: current.content + (data.content?.returned ?? 0),
          }))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setLoadingMore(false)
        }
      }, [activeSessionId, caseSensitive, desc, effectiveScopes.content, effectiveScopes.dirs, effectiveScopes.files, groups, loading, loadingMore, matchMode, offsets, query, sessionOnly, sort, wholeWord])

      const canLoadMore = groups !== null && ['content', 'files', 'dirs'].some(key => {
        if (!effectiveScopes[key]) return false
        const group = groups[key]
        if (group === undefined) return false
        const fetched = offsets[key]
        if (key === 'content') {
          const count = group.count
          if (count !== undefined && count.kind === 'exact') return count.value > fetched
          return (group.returned ?? 0) >= PAGE_CONTENT && typeof group.error !== 'string'
        }
        return (group.total ?? 0) > fetched
      })

      if (!open) return null

      const content = groups !== null ? groups.content : undefined
      const files = groups !== null ? groups.files : undefined
      const dirs = groups !== null ? groups.dirs : undefined
      const countLabel = (group, fallback) => {
        const count = group && group.count
        if (count && typeof count.value === 'number' && Number.isFinite(count.value)) {
          return (count.kind === 'bounded' ? '≥ ' : '') + String(count.value)
        }
        return String(fallback)
      }
      const contentCount = content === undefined ? 0 : (content.returned ?? 0)
      const filesCount = files === undefined ? 0 : (files.returned ?? files.hits?.length ?? 0)
      const dirsCount = dirs === undefined ? 0 : (dirs.returned ?? dirs.hits?.length ?? 0)
      const contentCountText = content === undefined ? '' : countLabel(content, contentCount)
      const filesCountText = files === undefined ? '' : countLabel(files, filesCount)
      const dirsCountText = dirs === undefined ? '' : countLabel(dirs, dirsCount)
      const totalRows = rows.length

      const scopeBox = (key, label, count) => h('label', {
        className: 'dsh-locator-check' + (key === 'content' && !availableContent ? ' disabled' : '')
          + (sessionOnly && key !== 'content' ? ' disabled' : ''),
        title: key === 'content' && !availableContent ? t('contentDisabled')
          : sessionOnly && key !== 'content' ? t('panelSessionHint') : label,
      },
        h('input', {
          type: 'checkbox',
          checked: scopes[key],
          disabled: (key === 'content' && !availableContent) || (sessionOnly && key !== 'content'),
          onChange: () => toggleScope(key),
        }),
        label,
        count ? h('span', { className: 'dsh-locator-count' }, count) : null,
      )

      const groupHead = (key, label, count, note) => h('div', {
        className: 'dsh-locator-grouphead',
        id: 'dsh-locator-group-' + key,
        onMouseDown: event => event.preventDefault(),
      },
        h('span', null, label),
        h('span', { className: 'dsh-locator-count' }, String(count)),
        h('span', { className: 'grow' }),
        note === null ? null : h('span', { className: 'dsh-locator-count' }, note),
      )

      const rowFor = (group, hit, index) => {
        const isContent = group === 'content'
        const isSession = isContent && hit.kind === 'session'
        const badge = isContent
          ? (isSession ? t('groupContent') : (hit.title || '').split('.').pop() || t('groupFiles'))
          : (hit.dir ? t('groupDirs') : (hit.ext || t('groupFiles')))
        const name = isSession ? (hit.title || hit.path) : (hit.name || hit.path)
        const meta = isContent
          ? formatTime(hit.mtime)
          : [formatSize(hit.size), formatTime(hit.mtime)].filter(Boolean).join(' · ')
        return h('div', {
          key: group + ':' + hit.path + ':' + String(hit.messageId || index),
          id: 'dsh-locator-opt-' + index,
          role: 'option',
          'aria-selected': index === selected ? 'true' : 'false',
          'data-index': index,
          className: 'dsh-locator-row' + (isContent ? ' dsh-locator-rowcontent' : '') + (index === selected ? ' sel' : ''),
          title: hit.path,
          onClick: () => setSelected(index),
          onMouseDown: event => event.preventDefault(),
          onDoubleClick: () => activate(hit),
        },
          h('div', { className: 'dsh-locator-title' },
            h('span', { className: 'dsh-locator-badge' + (isSession ? ' chat' : '') }, String(badge).slice(0, 6)),
            h('span', { className: 'dsh-locator-name' }, isSession ? name : highlight(name, query)),
            h('span', { className: 'dsh-locator-meta', style: { marginLeft: 'auto' } }, meta),
          ),
          isContent && hit.snippet
            ? h('div', { className: 'dsh-locator-snippet' }, highlight(hit.snippet, query))
            : null,
          h('div', { className: 'dsh-locator-path' }, hit.path),
        )
      }

      const contentErrorText = code => {
        if (code === 'content-regex-not-supported') return t('panelRegexPaused')
        if (code === 'content-query-too-short') return t('contentTooShort')
        if (code === 'content-search-timeout') return t('contentTimeout')
        if (code === 'invalid-control-char') return t('contentBadChars')
        return code
      }
      const renderGroup = (key, label, group, extra) => {
        if (!scopes[key] || group === undefined) return null
        const hits = Array.isArray(group.hits) ? group.hits : []
        const visibleHits = hits.filter(hit => rowIndexByKey.has(panelHitKey(key, hit)))
        const count = typeof group.returned === 'number' ? group.returned : hits.length
        const warnings = Array.isArray(group.warnings) && group.warnings.length > 0
          ? t('contentWarning', { list: group.warnings.join(', ') })
          : null
        const budget = key === 'content' && group.truncated === true ? t('contentBudget') : null
        const note = key === 'content'
          ? (matchMode === 'regex' ? t('panelRegexPaused')
            : contentBuilding ? t('contentBuilding', { files: content?.files ?? 0, messages: content?.messages ?? 0 })
              : (content?.capped ? t('contentCapped', { n: count }) : (query.trim() !== '' ? t('relevance') : null)))
          : (group.deduped > 0 ? t('deduped', { n: group.deduped }) : (group.truncated ? t('showing', { n: hits.length }) : null))
        const combinedNote = [note, warnings, budget].filter(value => value !== null && value !== '').join(' · ')
        if (typeof group.error === 'string' && group.error !== '') {
          const informational = ['content-regex-not-supported', 'content-query-too-short', 'invalid-control-char'].includes(group.error)
          const message = contentErrorText(group.error)
          return h('div', { className: 'dsh-locator-group', role: 'group', 'aria-labelledby': 'dsh-locator-group-' + key },
            groupHead(key, label, countLabel(group, count), combinedNote === '' ? null : combinedNote),
            h('div', { className: 'dsh-locator-groupempty', role: informational ? 'status' : 'alert' },
              informational ? message : t('errorPrefix') + message,
              informational ? null : h('button', { className: 'dsh-locator-dirbtn dsh-locator-retry', onClick: () => setRefreshTick(v => v + 1) }, t('retry'))),
          )
        }
        return h('div', { className: 'dsh-locator-group', role: 'group', 'aria-labelledby': 'dsh-locator-group-' + key },
          groupHead(key, label, countLabel(group, count), combinedNote === '' ? null : combinedNote),
          extra === undefined ? null : extra,
          visibleHits.length === 0
            ? h('div', { className: 'dsh-locator-groupempty' },
                filter.trim() !== '' && hits.length > 0
                  ? t('filterEmpty')
                  : (key === 'content' && scopes.content
                    ? (sessionOnly && query.trim().length >= 3 ? t('panelSessionHint')
                      : query.trim().length < 3 ? t('contentShort') : (contentBuilding ? t('loading') : t('emptyResults')))
                    : (query.trim() === '' ? t('emptyQuery') : t('emptyResults'))))
            : visibleHits.map(hit => rowFor(key, hit, rowIndexByKey.get(panelHitKey(key, hit)))),
        )
      }

      return h('div', {
        className: 'dsh-locator-overlay',
        onMouseDown: event => { if (event.target === event.currentTarget) close() },
      }, h('div', {
        ref: panelRef,
        className: 'dsh-locator-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('dialog'),
        onKeyDown,
      },
        h('div', { className: 'dsh-locator-head' },
          h('span', { className: 'dsh-locator-glyph' }, '🔎'),
          h('input', {
            ref: inputRef,
            className: 'dsh-locator-input',
            value: query,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: t('placeholder'),
            onChange: event => { setQuery(event.target.value); setFilter(''); setSelected(0) },
            onInput: event => { setQuery(event.target.value); setFilter(''); setSelected(0) },
            'aria-label': t('searchLabel'),
            role: 'combobox',
            'aria-expanded': 'true',
            'aria-controls': 'dsh-locator-results',
            'aria-autocomplete': 'list',
            'aria-activedescendant': totalRows > 0 ? 'dsh-locator-opt-' + selected : undefined,
          }),
          h('span', { className: 'dsh-locator-count', 'aria-hidden': 'true' },
            loading ? t('loading') : totalRows > 0 ? t('panelTotal', { index: selected + 1, total: totalRows }) : ''),
          h('span', { className: 'dsh-locator-kbd' }, 'Ctrl+Shift+F'),
          h('button', { className: 'dsh-locator-close', onClick: close, title: t('closeTitle'), 'aria-label': t('closeLabel') }, '×'),
        ),
        h('div', { className: 'dsh-locator-bar' },
          scopeBox('content', t('scopeContent'), contentCountText),
          scopeBox('files', t('scopeFiles'), filesCountText),
          scopeBox('dirs', t('scopeDirs'), dirsCountText),
          h('span', { className: 'grow' }),
          h('label', { className: 'dsh-locator-check' + (activeSessionId === '' ? ' disabled' : ''),
            title: activeSessionId === '' ? t('findNoSession') : t('panelSessionHint') },
            h('input', { type: 'checkbox', checked: sessionOnly, disabled: activeSessionId === '',
              onChange: () => setSessionOnly(value => !value) }),
            t('panelRangeSession')),
          h('label', { className: 'dsh-locator-check' }, t('panelModeLabel'),
            h('select', { className: 'dsh-locator-sort', value: matchMode,
              onChange: event => setMatchMode(['normal', 'extended', 'regex'].includes(event.target.value) ? event.target.value : 'normal') },
              h('option', { value: 'normal' }, t('modeNormal')),
              h('option', { value: 'extended' }, t('modeExtended')),
              h('option', { value: 'regex' }, t('modeRegex')),
            )),
          h('button', { className: 'dsh-locator-dirbtn', title: t('findCase'),
            'aria-pressed': caseSensitive ? 'true' : 'false', onClick: () => setCaseSensitive(value => !value) }, t('panelCaseShort')),
          h('button', { className: 'dsh-locator-dirbtn', title: t('findWhole'),
            'aria-pressed': wholeWord ? 'true' : 'false', onClick: () => setWholeWord(value => !value) }, t('panelWholeShort')),
          h('label', { className: 'dsh-locator-check' }, t('sortLabel'),
            h('select', {
              className: 'dsh-locator-sort',
              value: sort,
              onChange: event => setSort(SORTS.includes(event.target.value) ? event.target.value : 'mtime'),
              'aria-label': t('sortLabel'),
            },
              h('option', { value: 'mtime' }, t('sortMtime')),
              h('option', { value: 'name' }, t('sortName')),
              h('option', { value: 'size' }, t('sortSize')),
              h('option', { value: 'path' }, t('sortPath')),
            )),
          h('button', {
            className: 'dsh-locator-dirbtn',
            onClick: () => setDesc(value => !value),
            title: desc ? t('descOrder') : t('asc'),
            'aria-label': desc ? t('descOrder') : t('asc'),
          }, desc ? '↓' : '↑'),
          h('span', { className: 'dsh-locator-status' },
            status === null
              ? t('statusLoading')
              : t('status', {
                  entries: (status.entries || 0).toLocaleString(),
                  mode: status.watching ? t('live') : t('snapshot'),
                  roots: (status.roots || []).length,
                }) + (status.watchDegraded === true || status.refreshFallback === true
                  ? ' · ' + t('watchDegraded')
                  : '')
                  + (status.content && status.content.fullIndex === true ? ' · ' + t('contentFullIndex') : '')
                  + (status.content && status.content.reasoningIndex === true ? ' · ' + t('contentReasoningIndex') : '')),
        ),
        history.length > 0
          ? h('div', { className: 'dsh-locator-history' },
              h('span', { className: 'dsh-locator-history-label' }, t('panelHistory')),
              history.map(text => h('span', { key: 'hist-' + text, className: 'dsh-locator-chip' },
                h('button', { className: 'dsh-locator-chip-go', onClick: () => { setQuery(text); setFilter(''); setSelected(0) } }, text),
                h('button', { className: 'dsh-locator-chip-x', 'aria-label': t('panelHistoryClear'),
                  onClick: () => setHistory(previous => { const next = previous.filter(value => value !== text); writePanelHistory(next); return next }) }, '×'))),
              h('button', { className: 'dsh-locator-dirbtn', onClick: () => { setHistory([]); writePanelHistory([]) } }, t('panelHistoryClear')),
            )
          : null,
        h('div', { className: 'dsh-locator-filterbar' },
          h('input', {
            className: 'dsh-locator-filter',
            value: filter,
            placeholder: t('panelFilter'),
            spellCheck: false,
            'aria-label': t('panelFilter'),
            onChange: event => { setFilter(event.target.value); setSelected(0) },
            onInput: event => { setFilter(event.target.value); setSelected(0) },
          }),
          filter.trim() === '' ? null : h('span', { className: 'dsh-locator-count' }, String(rows.length)),
        ),
        sessionOnly ? h('div', { className: 'dsh-locator-groupempty' }, t('panelSessionHint')) : null,
        h('div', { id: 'dsh-locator-results', className: 'dsh-locator-scroll', ref: listRef, role: 'listbox', 'aria-busy': loading ? 'true' : 'false' },
          error !== ''
            ? h('div', { className: 'dsh-locator-empty', role: 'alert' }, t('errorPrefix') + error,
                h('button', { className: 'dsh-locator-dirbtn dsh-locator-retry', onClick: () => setRefreshTick(v => v + 1) }, t('retry')))
            : null,
          !anyScope
            ? h('div', { className: 'dsh-locator-empty' }, t('emptyScopes'))
            : groups === null
              ? (error === '' ? h('div', { className: 'dsh-locator-empty' }, t('loading')) : null)
              : [
                  renderGroup('content', t('groupContent'), content),
                  renderGroup('files', t('groupFiles'), files),
                  renderGroup('dirs', t('groupDirs'), dirs),
                ],
        ),
        h('div', { className: 'dsh-locator-foot' },
          h('span', null, (loading ? t('loading') + ' · ' : '') + t('results', {
            content: contentCountText || '0',
            files: filesCountText || '0',
            dirs: dirsCountText || '0',
            ms: took.toFixed(1),
          })
            + (status && status.scanning ? ' · ' + t('indexing') : '')
            + (contentBuilding ? ' · ' + t('indexing') : '')),
          h('span', { className: 'grow' }),
          rows.length > 0
            ? h('button', { className: 'dsh-locator-dirbtn', onClick: copyAll, title: t('copyAll') }, t('copyAll'))
            : null,
          canLoadMore
            ? h('button', { className: 'dsh-locator-dirbtn', disabled: loadingMore, onClick: loadMore }, loadingMore ? t('loading') : t('panelLoadMore'))
            : null,
          toast === '' ? null : h('span', { className: 'dsh-locator-toast' }, toast),
          h('span', null, t('footer') + ' · Ctrl+F ' + t('findOpen')),
        ),
        h('div', { style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }, role: 'status', 'aria-live': 'polite' },
          t('results', { content: contentCount, files: filesCount, dirs: dirsCount, ms: Math.round(took) })),
      ))
    }

    function Launcher() {
      return h('button', {
        className: 'dsh-locator-launch',
        title: t('launcher'),
        'aria-label': t('searchLabel'),
        onClick: () => store.toggle(),
      }, '🔎')
    }

    // ── plugin ──────────────────────────────────────────────────────────────
    const plugin = {
      name: 'dsh-locator-client',
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        workspaceService = ctx.uiWorkspace ?? (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null)
        ctx.effect(() => {
          ensureStyles()
          return () => {
            const tag = document.querySelector('style[data-plugin-css="' + NS + '"]')
            if (tag !== null) tag.remove()
          }
        }, 'dsh-locator: styles')
        ctx.effect(() => {
          const onKey = event => {
            if (event.defaultPrevented || event.isComposing || event.repeat) return
            if (!((event.metaKey || event.ctrlKey) && event.shiftKey && String(event.key).toLowerCase() === 'f')) return
            const target = event.target
            if (target instanceof Element && target.closest('.xterm,.monaco-editor,[data-code-editor]') !== null) return
            const foreignModal = document.querySelector('[role="dialog"][aria-modal="true"]:not(.dsh-locator-panel)')
            if (foreignModal !== null) return
            event.preventDefault()
            event.stopPropagation()
            closeFind()
            store.toggle()
          }
          document.addEventListener('keydown', onKey, true)
          return () => document.removeEventListener('keydown', onKey, true)
        }, 'dsh-locator: search hotkey')
        ctx.effect(() => {
          const onFindKey = event => {
            if (event.defaultPrevented || event.isComposing) return
            const target = event.target
            if (target instanceof Element && target.closest('.xterm,.monaco-editor,[data-code-editor]') !== null) return
            const inFind = target instanceof Element && target.closest('.dsh-locator-findbar') !== null
            const ctrl = event.ctrlKey || event.metaKey
            if (ctrl && !event.shiftKey && !event.altKey && event.code === 'KeyF') {
              if (store.isOpen()) {
                event.preventDefault()
                event.stopPropagation()
                const panelInput = document.querySelector('.dsh-locator-input')
                if (panelInput !== null) { panelInput.focus(); panelInput.select() }
                return
              }
              if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null && !inFind) return
              if (findStore.get().open) { event.preventDefault(); event.stopPropagation(); findApi.focus(); return }
              if (conversationScope('') === null) return
              event.preventDefault()
              event.stopPropagation()
              openFind({ selection: true })
              return
            }
            if (!ctrl && !event.altKey && event.code === 'F3') {
              if (!findStore.get().open) return
              event.preventDefault()
              event.stopPropagation()
              findApi.move(event.shiftKey ? -1 : 1)
              return
            }
            if (event.key === 'Escape' && findStore.get().open) {
              event.preventDefault()
              event.stopPropagation()
              closeFind()
            }
          }
          document.addEventListener('keydown', onFindKey, true)
          return () => document.removeEventListener('keydown', onFindKey, true)
        }, 'dsh-locator: find hotkeys')
        ctx.effect(() => () => {
          closeFind()
          cancelJump()
          store.set(false)
        }, 'dsh-locator: find cleanup')
        try {
          ctx.slots.inject('shell.overlay', () => {
            const disposers = [
              ctx.slots.register({ name: 'shell.overlay', id: 'dsh-locator-findbar', order: 59 }, FindBar),
              ctx.slots.register({ name: 'shell.overlay', id: 'dsh-locator-panel', order: 60 }, Panel),
              ctx.slots.register({ name: 'shell.overlay', id: 'dsh-locator-notice', order: 61 }, Notice),
            ]
            return () => {
              for (const dispose of disposers.reverse()) {
                if (typeof dispose === 'function') dispose()
              }
            }
          })
        } catch (error) {
          console.error('dsh-locator: overlay slot unavailable', error)
        }
        try {
          ctx.slots.inject('conversation.session.header.utilities', () =>
            ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-locator-find-toggle', order: 30 }, FindToggle))
        } catch (error) {
          console.error('dsh-locator: session header slot unavailable', error)
        }
        try {
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-locator-launch', order: 36 }, Launcher))
        } catch (error) {
          console.error('dsh-locator: sidebar action slot unavailable', error)
        }
      },
    }
    return plugin
  },
})

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
::highlight(dsh-locator-find){background-color:rgba(245,158,11,.28);color:inherit}
::highlight(dsh-locator-find-active){background-color:rgba(245,158,11,.45);color:inherit}
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
        contentShort: 'Type at least 2 characters to search bodies and sessions',
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
      },
      zh: {
        scopeContent: '内容', scopeFiles: '文件', scopeDirs: '目录',
        placeholder: '搜文件名、路径、正文或会话… 支持 ext:pdf size:>10mb dm:thisweek path:src',
        searchLabel: '文件搜索', dialog: '本地文件搜索', closeTitle: '关闭 (Esc)', closeLabel: '关闭',
        sortLabel: '排序', sortMtime: '修改时间', sortName: '名称', sortSize: '大小', sortPath: '路径',
        asc: '升序', descOrder: '降序',
        groupContent: '内容', groupFiles: '文件', groupDirs: '目录',
        relevance: '按相关度', contentBuilding: '索引构建中… {files} 文件 / {messages} 消息',
        contentShort: '输入至少 2 个字符后搜索正文与会话',
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
      },
      es: {
        scopeContent: 'Contenido', scopeFiles: 'Archivos', scopeDirs: 'Carpetas',
        placeholder: 'Busca nombres, rutas, contenido o sesiones… p. ej. ext:pdf size:>10mb dm:thisweek path:src',
        searchLabel: 'Buscar archivos', dialog: 'Búsqueda local de archivos', closeTitle: 'Cerrar (Esc)', closeLabel: 'Cerrar',
        sortLabel: 'Orden', sortMtime: 'Modificado', sortName: 'Nombre', sortSize: 'Tamaño', sortPath: 'Ruta',
        asc: 'Ascendente', descOrder: 'Descendente',
        groupContent: 'Contenido', groupFiles: 'Archivos', groupDirs: 'Carpetas',
        relevance: 'por relevancia', contentBuilding: 'indexando… {files} archivos / {messages} mensajes',
        contentShort: 'Escribe al menos 2 caracteres para buscar contenido y sesiones',
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
      },
      pt: {
        scopeContent: 'Conteúdo', scopeFiles: 'Arquivos', scopeDirs: 'Pastas',
        placeholder: 'Busque nomes, caminhos, conteúdo ou sessões… ex. ext:pdf size:>10mb dm:thisweek path:src',
        searchLabel: 'Buscar arquivos', dialog: 'Busca local de arquivos', closeTitle: 'Fechar (Esc)', closeLabel: 'Fechar',
        sortLabel: 'Ordem', sortMtime: 'Modificado', sortName: 'Nome', sortSize: 'Tamanho', sortPath: 'Caminho',
        asc: 'Ascendente', descOrder: 'Descendente',
        groupContent: 'Conteúdo', groupFiles: 'Arquivos', groupDirs: 'Pastas',
        relevance: 'por relevância', contentBuilding: 'indexando… {files} arquivos / {messages} mensagens',
        contentShort: 'Digite pelo menos 2 caracteres para buscar conteúdo e sessões',
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
      },
      hi: {
        scopeContent: 'सामग्री', scopeFiles: 'फ़ाइलें', scopeDirs: 'फ़ोल्डर',
        placeholder: 'नाम, पथ, सामग्री या सत्र खोजें… जैसे ext:pdf size:>10mb dm:thisweek path:src',
        searchLabel: 'फ़ाइल खोज', dialog: 'स्थानीय फ़ाइल खोज', closeTitle: 'बंद करें (Esc)', closeLabel: 'बंद करें',
        sortLabel: 'क्रम', sortMtime: 'संशोधित', sortName: 'नाम', sortSize: 'आकार', sortPath: 'पथ',
        asc: 'आरोही', descOrder: 'अवरोही',
        groupContent: 'सामग्री', groupFiles: 'फ़ाइलें', groupDirs: 'फ़ोल्डर',
        relevance: 'प्रासंगिकता से', contentBuilding: 'इंडेक्स बन रहा है… {files} फ़ाइलें / {messages} संदेश',
        contentShort: 'सामग्री और सत्र खोजने के लिए कम से कम 2 अक्षर लिखें',
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
      },
    }
    const LANG = (() => {
      const tag = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase()
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
      const fallback = { scopes: { content: true, files: true, dirs: true }, sort: 'mtime', desc: true }
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
    const EXCLUDED = '[hidden],[data-chat-history],[data-text-interaction-surface],[data-composer-seat],script,style'
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

    function clearFindHighlight() {
      clearLegacyTargets()
      if (!highlightsAvailable()) return
      CSS.highlights.delete(HL_BASE)
      CSS.highlights.delete(HL_ACTIVE)
    }

    function setFindHighlight(ranges) {
      if (!highlightsAvailable()) {
        for (const range of ranges.slice(0, 1)) {
          const node = range.startContainer
          const element = node instanceof Element ? node : node.parentElement
          const row = element === null ? null : element.closest('[data-chat-node-key]')
          if (row !== null) { row.classList.add('dsh-locator-target'); legacyTargets.add(row) }
        }
        return
      }
      if (ranges.length === 0) return
      CSS.highlights.set(HL_BASE, new Highlight(...ranges))
      CSS.highlights.set(HL_ACTIVE, new Highlight(ranges[0]))
    }

    function conversationScope(sessionId) {
      const id = sessionId === undefined || sessionId === null ? '' : String(sessionId)
      let embedded = null
      for (const element of document.querySelectorAll('[data-conversation-content][data-conversation-session]')) {
        if (id !== '' && element.getAttribute('data-conversation-session') !== id) continue
        if (element.closest('[data-sidebar-chat]') === null) return element
        embedded = element
      }
      return embedded
    }

    function chatFlow(scope) {
      return scope === null ? null : scope.querySelector('[data-chat-flow]')
    }

    function findMessageRow(flow, messageId) {
      if (flow === null || !messageId) return null
      const id = String(messageId)
      for (const row of flow.querySelectorAll('[data-chat-node-key]')) {
        const key = row.getAttribute('data-chat-node-key') || ''
        if (key === id || key.endsWith(id)) return row
      }
      return null
    }

    function needlesFromQuery(query) {
      const raw = String(query || '').trim()
      const words = queryWords(raw).filter(word => word.length >= 1)
      if (words.length === 0 && raw.length >= 2) return [raw]
      return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 8)
    }

    function inlineGroups(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const groups = new Map()
      let node = walker.nextNode()
      while (node !== null) {
        const parent = node.parentElement
        if (parent !== null && parent.closest(EXCLUDED) === null) {
          const value = node.nodeValue || ''
          if (value !== '') {
            const block = parent.closest(BLOCK_SELECTOR) || root
            let group = groups.get(block)
            if (group === undefined) { group = { nodes: [], text: '' }; groups.set(block, group) }
            group.nodes.push(node)
            group.text += value
          }
        }
        node = walker.nextNode()
      }
      return [...groups.values()]
    }

    function offsetInGroup(group, index) {
      let consumed = 0
      for (const node of group.nodes) {
        const length = (node.nodeValue || '').length
        if (index <= consumed + length) return [node, index - consumed]
        consumed += length
      }
      const last = group.nodes[group.nodes.length - 1]
      return [last, (last.nodeValue || '').length]
    }

    function rangesForNeedles(root, needles) {
      const ranges = []
      if (root === null || needles.length === 0) return ranges
      for (const group of inlineGroups(root)) {
        const lower = group.text.toLowerCase()
        for (const needle of needles) {
          const target = needle.toLowerCase()
          let from = 0
          while (ranges.length < 200) {
            const index = lower.indexOf(target, from)
            if (index < 0) break
            const start = offsetInGroup(group, index)
            const end = offsetInGroup(group, index + target.length)
            const range = document.createRange()
            range.setStart(start[0], start[1])
            range.setEnd(end[0], end[1])
            ranges.push(range)
            from = index + target.length
          }
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
        const needle = phrase.toLowerCase()
        for (const group of inlineGroups(root)) {
          const index = group.text.toLowerCase().indexOf(needle)
          if (index < 0) continue
          const start = offsetInGroup(group, index)
          const end = offsetInGroup(group, index + needle.length)
          const range = document.createRange()
          range.setStart(start[0], start[1])
          range.setEnd(end[0], end[1])
          return range
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

    let activeJump = null

    function cancelJump() {
      clearFindHighlight()
      if (activeJump !== null) {
        const cancel = activeJump
        activeJump = null
        cancel()
      }
    }

    async function jumpToContentHit(hit, query, notify) {
      cancelJump()
      if (!hit || hit.kind !== 'session' || !hit.sessionId) return false
      if (!workspaceService || typeof workspaceService.openSession !== 'function') return false
      try { workspaceService.openSession(hit.sessionId) } catch { return false }
      const scope = await waitForScope(hit.sessionId, 10_000)
      if (scope === null) { notify?.(t('jumpFailed')); return false }
      const flow = chatFlow(scope)
      if (flow === null) { notify?.(t('jumpFailed')); return false }
      const needles = needlesFromQuery(query)
      const finder = () => {
        const row = findMessageRow(flow, hit.messageId)
        if (row !== null) {
          expandHidden(row)
          const ranges = rangesForNeedles(row, needles)
          if (ranges.length > 0) return { row, ranges }
          const phrase = phraseRange(row, hit.snippet)
          if (phrase !== null) return { row, ranges: [phrase] }
          return null
        }
        const phrase = phraseRange(flow, hit.snippet)
        if (phrase === null) return null
        const phraseRow = phrase.startContainer instanceof Element
          ? phrase.startContainer.closest('[data-chat-node-key]')
          : phrase.startContainer.parentElement?.closest('[data-chat-node-key]') ?? null
        if (phraseRow !== null) expandHidden(phraseRow)
        const ranges = phraseRow === null ? [phrase] : rangesForNeedles(phraseRow, needles)
        return { row: phraseRow, ranges: ranges.length > 0 ? ranges : [phrase] }
      }
      let target = await waitFor(flow, finder, 6_000, 120)
      for (let attempt = 0; target === null && attempt < 10; attempt++) {
        if (!revealOlder(scope)) break
        target = await waitFor(flow, finder, 1_500, 150)
      }
      if (target === null) { notify?.(t('phraseNotFound')); return false }
      setFindHighlight(target.ranges)
      centerRange(target.ranges[0])
      const start = target.ranges[0].startContainer
      const chain = scrollChain(start instanceof Element ? start : start.parentElement)
      const scroller = chain.length > 0 ? chain[chain.length - 1] : null
      const cleanup = []
      const release = () => {
        while (cleanup.length > 0) {
          const fn = cleanup.pop()
          try { fn() } catch { /* ignore */ }
        }
      }
      activeJump = release
      if (scroller !== null) {
        let writing = false
        const expected = scroller.scrollTop
        const recenter = () => {
          if (activeJump !== release) return
          const rect = rangeRect(target.ranges[0])
          if (rect === null) { release(); clearFindHighlight(); activeJump = null; return }
          writing = true
          centerRange(target.ranges[0])
          requestAnimationFrame(() => { writing = false })
        }
        for (const delay of [80, 240, 800, 1600]) {
          const id = setTimeout(recenter, delay)
          cleanup.push(() => clearTimeout(id))
        }
        const onUser = () => { if (!writing) release() }
        for (const type of GESTURES) {
          scroller.addEventListener(type, onUser, true)
          cleanup.push(() => scroller.removeEventListener(type, onUser, true))
        }
        const onScroll = event => {
          if (writing) return
          if (event.target === scroller && Math.abs(scroller.scrollTop - expected) <= 2) return
          release()
        }
        scroller.addEventListener('scroll', onScroll, true)
        cleanup.push(() => scroller.removeEventListener('scroll', onScroll, true))
      }
      const onKey = event => {
        if (event.key !== 'Escape') return
        cancelJump()
      }
      document.addEventListener('keydown', onKey, true)
      cleanup.push(() => document.removeEventListener('keydown', onKey, true))
      const sessionWatch = setInterval(() => {
        const still = target.ranges[0].startContainer.isConnected && conversationScope(hit.sessionId) !== null
        if (!still) cancelJump()
      }, 1_000)
      cleanup.push(() => clearInterval(sessionWatch))
      cleanup.push(() => clearFindHighlight())
      notify?.(t('jumped'))
      return true
    }

    // ── panel ───────────────────────────────────────────────────────────────
    let workspaceService = null
    const PAGE_NAME = 50
    const PAGE_CONTENT = 30

    function Panel() {
      const open = useOpen()
      const prefs = useMemo(readPrefs, [])
      const [query, setQuery] = useState('')
      const [sort, setSort] = useState(prefs.sort)
      const [desc, setDesc] = useState(prefs.desc)
      const [scopes, setScopes] = useState(prefs.scopes)
      const [groups, setGroups] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [took, setTook] = useState(0)
      const [status, setStatus] = useState(null)
      const [availableContent, setAvailableContent] = useState(true)
      const [selected, setSelected] = useState(0)
      const [toast, setToast] = useState('')
      const [refreshTick, setRefreshTick] = useState(0)
      const inputRef = useRef(null)
      const panelRef = useRef(null)
      const abortRef = useRef(null)
      const listRef = useRef(null)

      const close = useCallback(() => store.set(false), [])
      const anyScope = scopes.content || scopes.files || scopes.dirs

      useEffect(() => {
        writePrefs({ scopes, sort, desc })
      }, [scopes, sort, desc])

      useEffect(() => {
        if (!open) return undefined
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
          if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
        }
      }, [open])

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
          post('/dsh-locator/combined', {
            query,
            content: scopes.content,
            files: scopes.files,
            dirs: scopes.dirs,
            limit: PAGE_NAME,
            contentLimit: PAGE_CONTENT,
            sort,
            desc,
          }, controller.signal).then(data => {
            if (controller.signal.aborted) return
            setGroups({
              content: data.content,
              files: data.files,
              dirs: data.dirs,
            })
            if (typeof data.availableContent === 'boolean') setAvailableContent(data.availableContent)
            setTook(typeof data.tookMs === 'number' ? data.tookMs : 0)
            setLoading(false)
          }).catch(cause => {
            if (controller.signal.aborted) return
            setError(cause instanceof Error ? cause.message : String(cause))
            setLoading(false)
          })
        }, 140)
        return () => clearTimeout(timer)
      }, [open, query, sort, desc, scopes.content, scopes.files, scopes.dirs, refreshTick, anyScope])

      const contentBuilding = groups !== null && groups.content !== undefined && groups.content.building === true
      useEffect(() => {
        if (!open || !contentBuilding) return undefined
        const timer = setTimeout(() => setRefreshTick(value => value + 1), 2500)
        return () => clearTimeout(timer)
      }, [open, contentBuilding, refreshTick])

      const rows = useMemo(() => {
        if (groups === null) return []
        const out = []
        for (const group of ['content', 'files', 'dirs']) {
          const hits = groups[group] && Array.isArray(groups[group].hits) ? groups[group].hits : []
          for (const hit of hits) out.push({ group, hit })
        }
        return out
      }, [groups])

      useEffect(() => {
        setSelected(value => Math.min(Math.max(0, value), Math.max(0, rows.length - 1)))
      }, [rows.length])

      const notify = useCallback(message => {
        setToast(message)
        setTimeout(() => setToast(''), 1600)
      }, [])

      const copy = useCallback(hit => {
        if (!hit) return
        copyText(hit.path).then(() => notify(t('copiedPath'))).catch(() => {})
      }, [notify])

      const reveal = useCallback(hit => {
        if (!hit) return
        post('/dsh-locator/reveal', { path: hit.path }).then(() => notify(t('revealed'))).catch(() => copy(hit))
      }, [copy, notify])

      const openFile = useCallback(hit => {
        if (!hit || hit.dir) return
        post('/dsh-locator/open', { path: hit.path }).then(() => notify(t('opened'))).catch(() => copy(hit))
      }, [copy, notify])

      const activate = useCallback(hit => {
        if (!hit) return
        if (hit.kind === 'session' && hit.sessionId) {
          close()
          void jumpToContentHit(hit, query, notify)
          return
        }
        reveal(hit)
      }, [close, notify, query, reveal])

      const insert = useCallback(hit => {
        if (!hit || hit.kind === 'session') return
        const mention = '@"' + hit.path.replace(/"/g, '') + '" '
        close()
        setTimeout(() => {
          if (insertIntoComposer(mention)) notify(t('inserted'))
          else copyText(mention).then(() => notify(t('insertFailed'))).catch(() => {})
        }, 80)
      }, [close, notify])

      const toggleScope = useCallback(key => {
        if (key === 'content' && !availableContent) return
        setScopes(value => ({ ...value, [key]: !value[key] }))
      }, [availableContent])

      const onKeyDown = useCallback(event => {
        if (event.target instanceof HTMLSelectElement) return
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
        if (event.altKey && ['1', '2', '3'].includes(event.key)) {
          event.preventDefault()
          toggleScope(event.key === '1' ? 'content' : event.key === '2' ? 'files' : 'dirs')
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setSelected(value => Math.max(0, Math.min(rows.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))))
          return
        }
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
      }, [activate, close, copy, insert, openFile, reveal, rows, selected, toggleScope])

      useEffect(() => {
        const list = listRef.current
        if (!list) return
        const row = list.querySelector('[data-index="' + selected + '"]')
        if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
      }, [selected])

      if (!open) return null

      const content = groups !== null ? groups.content : undefined
      const files = groups !== null ? groups.files : undefined
      const dirs = groups !== null ? groups.dirs : undefined
      const contentCount = content === undefined ? 0 : (content.returned ?? 0)
      const filesCount = files === undefined ? 0 : (files.returned ?? files.hits?.length ?? 0)
      const dirsCount = dirs === undefined ? 0 : (dirs.returned ?? dirs.hits?.length ?? 0)
      const totalRows = rows.length

      const scopeBox = (key, label, count) => h('label', {
        className: 'dsh-locator-check' + (key === 'content' && !availableContent ? ' disabled' : ''),
        title: key === 'content' && !availableContent ? t('contentDisabled') : label,
      },
        h('input', {
          type: 'checkbox',
          checked: scopes[key],
          disabled: key === 'content' && !availableContent,
          onChange: () => toggleScope(key),
        }),
        label,
        count > 0 ? h('span', { className: 'dsh-locator-count' }, String(count)) : null,
      )

      const groupHead = (key, label, count, note) => h('div', {
        className: 'dsh-locator-grouphead',
        id: 'dsh-locator-group-' + key,
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

      let index = -1
      const renderGroup = (key, label, group, extra) => {
        if (!scopes[key] || group === undefined) return null
        const hits = Array.isArray(group.hits) ? group.hits : []
        const count = typeof group.returned === 'number' ? group.returned : hits.length
        const note = key === 'content'
          ? (contentBuilding ? t('contentBuilding', { files: content?.files ?? 0, messages: content?.messages ?? 0 })
            : (content?.capped ? t('contentCapped', { n: count }) : (query.trim() !== '' ? t('relevance') : null)))
          : (group.deduped > 0 ? t('deduped', { n: group.deduped }) : (group.truncated ? t('showing', { n: hits.length }) : null))
        return h('div', { className: 'dsh-locator-group', role: 'group', 'aria-labelledby': 'dsh-locator-group-' + key },
          groupHead(key, label, count, note),
          extra === undefined ? null : extra,
          hits.length === 0
            ? h('div', { className: 'dsh-locator-groupempty' },
                key === 'content' && scopes.content
                  ? (query.trim().length < 2 ? t('contentShort') : (contentBuilding ? t('loading') : t('emptyResults')))
                  : (query.trim() === '' ? t('emptyQuery') : t('emptyResults')))
            : hits.map(hit => { index++; return rowFor(key, hit, index) }),
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
            onChange: event => { setQuery(event.target.value); setSelected(0) },
            'aria-label': t('searchLabel'),
            role: 'combobox',
            'aria-expanded': 'true',
            'aria-controls': 'dsh-locator-results',
            'aria-autocomplete': 'list',
            'aria-activedescendant': totalRows > 0 ? 'dsh-locator-opt-' + selected : undefined,
          }),
          h('span', { className: 'dsh-locator-kbd' }, 'Ctrl+Shift+F'),
          h('button', { className: 'dsh-locator-close', onClick: close, title: t('closeTitle'), 'aria-label': t('closeLabel') }, '×'),
        ),
        h('div', { className: 'dsh-locator-bar' },
          scopeBox('content', t('scopeContent'), contentCount),
          scopeBox('files', t('scopeFiles'), filesCount),
          scopeBox('dirs', t('scopeDirs'), dirsCount),
          h('span', { className: 'grow' }),
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
                })),
        ),
        h('div', { id: 'dsh-locator-results', className: 'dsh-locator-scroll', ref: listRef, role: 'listbox', 'aria-busy': loading ? 'true' : 'false' },
          !anyScope
            ? h('div', { className: 'dsh-locator-empty' }, t('emptyScopes'))
            : error !== ''
              ? h('div', { className: 'dsh-locator-empty', role: 'alert' }, t('errorPrefix') + error,
                  h('button', { className: 'dsh-locator-dirbtn dsh-locator-retry', onClick: () => setRefreshTick(v => v + 1) }, t('retry')))
              : groups === null
                ? h('div', { className: 'dsh-locator-empty' }, t('loading'))
                : [
                    renderGroup('content', t('groupContent'), content),
                    renderGroup('files', t('groupFiles'), files),
                    renderGroup('dirs', t('groupDirs'), dirs),
                  ],
        ),
        h('div', { className: 'dsh-locator-foot' },
          h('span', null, t('results', { content: contentCount, files: filesCount, dirs: dirsCount, ms: took.toFixed(1) })
            + (status && status.scanning ? ' · ' + t('indexing') : '')
            + (contentBuilding ? ' · ' + t('indexing') : '')),
          h('span', { className: 'grow' }),
          toast === '' ? null : h('span', { className: 'dsh-locator-toast' }, toast),
          h('span', null, t('footer')),
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
        ensureStyles()
        ctx.effect(() => {
          const onKey = event => {
            if ((event.metaKey || event.ctrlKey) && event.shiftKey && String(event.key).toLowerCase() === 'f') {
              event.preventDefault()
              event.stopPropagation()
              store.toggle()
            }
          }
          document.addEventListener('keydown', onKey, true)
          return () => document.removeEventListener('keydown', onKey, true)
        }, 'dsh-locator: search hotkey')
        ctx.effect(() => () => { cancelJump() }, 'dsh-locator: find highlight')
        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-locator-panel', order: 60 }, Panel))
        } catch (error) {
          console.error('dsh-locator: overlay slot unavailable', error)
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

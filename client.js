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
  padding:9vh 16px 16px;background:rgba(15,17,21,.38);backdrop-filter:blur(3px);color-scheme:light dark}
.dsh-locator-panel{display:flex;flex-direction:column;width:min(960px,94vw);max-height:76vh;overflow:hidden;
  border-radius:14px;border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.28));
  background:var(--dsw-alias-bg-base,#fff);box-shadow:0 24px 64px rgba(0,0,0,.28);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-locator-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.2))}
.dsh-locator-glyph{font-size:15px;opacity:.7}
.dsh-locator-input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:14px;padding:2px 0}
.dsh-locator-kbd{border:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.35));border-radius:6px;padding:1px 6px;font-size:11px;opacity:.6;white-space:nowrap}
.dsh-locator-close{border:0;background:transparent;color:inherit;opacity:.55;cursor:pointer;font-size:16px;padding:2px 4px;border-radius:6px}
.dsh-locator-close:hover{opacity:.9;background:rgba(120,125,135,.12)}
.dsh-locator-bar{display:flex;align-items:center;gap:12px;padding:7px 14px;border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.16));
  font-size:12px;opacity:.85;flex-wrap:wrap}
.dsh-locator-check{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none}
.dsh-locator-status{margin-left:auto;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}
.dsh-locator-scroll{overflow:auto;flex:1;min-height:120px}
.dsh-locator-table{width:100%;border-collapse:collapse;table-layout:fixed}
.dsh-locator-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-base,#fff);text-align:left;font-weight:500;font-size:11px;
  letter-spacing:.03em;text-transform:uppercase;opacity:.6;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.16));
  cursor:pointer;user-select:none;white-space:nowrap}
.dsh-locator-table th:hover{opacity:.9}
.dsh-locator-table th.sorted{opacity:1}
.dsh-locator-table td{padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.09));
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.dsh-locator-row{cursor:pointer}
.dsh-locator-row:hover td{background:rgba(120,125,135,.08)}
.dsh-locator-row.sel td{background:rgba(64,116,255,.12)}
.dsh-locator-name{display:flex;align-items:center;gap:7px;min-width:0}
.dsh-locator-badge{flex:none;font-size:10px;padding:0 5px;border-radius:4px;background:rgba(120,125,135,.14);opacity:.8}
.dsh-locator-hit{background:rgba(255,196,0,.35);border-radius:2px;color:inherit}
.dsh-locator-path{opacity:.55;font-size:11.5px}
.dsh-locator-size,.dsh-locator-time{opacity:.7;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-locator-empty{padding:36px 16px;text-align:center;opacity:.6}
.dsh-locator-foot{display:flex;align-items:center;gap:10px;padding:7px 14px;border-top:1px solid var(--dsw-alias-border-base,rgba(120,125,135,.16));
  font-size:11.5px;opacity:.7;flex-wrap:wrap}
.dsh-locator-foot .grow{flex:1}
.dsh-locator-toast{color:#2e7d32}
@media (prefers-color-scheme:dark){
  .dsh-locator-overlay{background:rgba(0,0,0,.55)}
  .dsh-locator-panel{box-shadow:0 24px 64px rgba(0,0,0,.6)}
}
.dsh-locator-launch{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:7px;
  background:transparent;color:inherit;opacity:.65;cursor:pointer;font-size:14px}
.dsh-locator-launch:hover{opacity:1;background:rgba(120,125,135,.14)}
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
        placeholder: 'Search file names or paths… e.g. ext:pdf size:>10mb dm:thisweek path:src !tmp',
        searchLabel: 'Search files', dialog: 'Local file search', closeTitle: 'Close (Esc)', closeLabel: 'Close',
        filesOnly: 'Files only', dirsOnly: 'Directories only', statusLoading: 'Reading index status…',
        status: 'Index {entries} entries · {mode} · {roots} roots', live: 'live', snapshot: 'snapshot', usn: 'USN',
        sortTitle: 'Click to change sorting', name: 'Name', size: 'Size', mtime: 'Modified', path: 'Path',
        dirBadge: 'DIR', fileBadge: 'FILE', loading: 'Searching…', errorPrefix: 'Search failed: ', empty: 'No matching files',
        results: '{total} results', showing: 'showing first {n}', indexing: 'indexing, results may be incomplete',
        copied: 'Path copied', revealed: 'Revealed in file manager', opened: 'Opened', inserted: 'Inserted @file',
        insertFailed: 'Insert failed; @file copied', footer: '↑↓ select · Enter copy · Ctrl+O open · Ctrl+Enter insert @file · double-click reveal · Esc close',
        launcher: 'Local file search (Ctrl+Shift+F)',
        justNow: 'just now', minutesAgo: '{n} min ago', hoursAgo: '{n} h ago',
      },
      zh: {
        placeholder: '搜索文件名或路径… 支持 ext:pdf size:>10mb dm:thisweek path:src !tmp',
        searchLabel: '文件搜索', dialog: '本地文件搜索', closeTitle: '关闭 (Esc)', closeLabel: '关闭',
        filesOnly: '只看文件', dirsOnly: '只看目录', statusLoading: '索引状态读取中…',
        status: '索引 {entries} 条 · {mode} · {roots} 个根目录', live: '实时监听', snapshot: '快照', usn: 'USN',
        sortTitle: '点击切换排序', name: '名称', size: '大小', mtime: '修改时间', path: '路径',
        dirBadge: '目录', fileBadge: '文件', loading: '搜索中…', errorPrefix: '搜索失败：', empty: '没有匹配的文件',
        results: '{total} 条结果', showing: '显示前 {n} 条', indexing: '索引构建中，结果可能不完整',
        copied: '已复制路径', revealed: '已在文件管理器中定位', opened: '已打开', inserted: '已插入 @file',
        insertFailed: '插入失败，已复制 @file', footer: '↑↓ 选择 · Enter 复制 · Ctrl+O 打开 · Ctrl+Enter 插入 @file · 双击定位 · Esc 关闭',
        launcher: '本地文件搜索 (Ctrl+Shift+F)',
        justNow: '刚刚', minutesAgo: '{n} 分钟前', hoursAgo: '{n} 小时前',
      },
      es: {
        placeholder: 'Busca nombres o rutas… p. ej. ext:pdf size:>10mb dm:thisweek path:src !tmp',
        searchLabel: 'Buscar archivos', dialog: 'Búsqueda local de archivos', closeTitle: 'Cerrar (Esc)', closeLabel: 'Cerrar',
        filesOnly: 'Solo archivos', dirsOnly: 'Solo carpetas', statusLoading: 'Leyendo el estado del índice…',
        status: 'Índice: {entries} entradas · {mode} · {roots} raíces', live: 'en vivo', snapshot: 'instantánea', usn: 'USN',
        sortTitle: 'Clic para cambiar el orden', name: 'Nombre', size: 'Tamaño', mtime: 'Modificado', path: 'Ruta',
        dirBadge: 'DIR', fileBadge: 'ARCH', loading: 'Buscando…', errorPrefix: 'Error de búsqueda: ', empty: 'Sin coincidencias',
        results: '{total} resultados', showing: 'mostrando {n}', indexing: 'indexando, resultados incompletos',
        copied: 'Ruta copiada', revealed: 'Mostrado en el gestor de archivos', opened: 'Abierto', inserted: '@file insertado',
        insertFailed: 'No se pudo insertar; @file copiado', footer: '↑↓ elegir · Enter copiar · Ctrl+O abrir · Ctrl+Enter insertar @file · doble clic revelar · Esc cerrar',
        launcher: 'Búsqueda local (Ctrl+Shift+F)',
        justNow: 'ahora', minutesAgo: 'hace {n} min', hoursAgo: 'hace {n} h',
      },
      pt: {
        placeholder: 'Busque nomes ou caminhos… ex. ext:pdf size:>10mb dm:thisweek path:src !tmp',
        searchLabel: 'Buscar arquivos', dialog: 'Busca local de arquivos', closeTitle: 'Fechar (Esc)', closeLabel: 'Fechar',
        filesOnly: 'Somente arquivos', dirsOnly: 'Somente pastas', statusLoading: 'Lendo o estado do índice…',
        status: 'Índice: {entries} entradas · {mode} · {roots} raízes', live: 'ao vivo', snapshot: 'instantâneo', usn: 'USN',
        sortTitle: 'Clique para mudar a ordem', name: 'Nome', size: 'Tamanho', mtime: 'Modificado', path: 'Caminho',
        dirBadge: 'DIR', fileBadge: 'ARQ', loading: 'Buscando…', errorPrefix: 'Falha na busca: ', empty: 'Nenhum resultado',
        results: '{total} resultados', showing: 'mostrando {n}', indexing: 'indexando, resultados incompletos',
        copied: 'Caminho copiado', revealed: 'Mostrado no gerenciador de arquivos', opened: 'Aberto', inserted: '@file inserido',
        insertFailed: 'Falha ao inserir; @file copiado', footer: '↑↓ escolher · Enter copiar · Ctrl+O abrir · Ctrl+Enter inserir @file · clique duplo revelar · Esc fechar',
        launcher: 'Busca local (Ctrl+Shift+F)',
        justNow: 'agora', minutesAgo: 'há {n} min', hoursAgo: 'há {n} h',
      },
      hi: {
        placeholder: 'फ़ाइल नाम या पथ खोजें… जैसे ext:pdf size:>10mb dm:thisweek path:src !tmp',
        searchLabel: 'फ़ाइल खोज', dialog: 'स्थानीय फ़ाइल खोज', closeTitle: 'बंद करें (Esc)', closeLabel: 'बंद करें',
        filesOnly: 'केवल फ़ाइलें', dirsOnly: 'केवल फ़ोल्डर', statusLoading: 'इंडेक्स स्थिति पढ़ी जा रही है…',
        status: 'इंडेक्स {entries} प्रविष्टियाँ · {mode} · {roots} रूट', live: 'लाइव', snapshot: 'स्नैपशॉट', usn: 'USN',
        sortTitle: 'क्रम बदलने के लिए क्लिक करें', name: 'नाम', size: 'आकार', mtime: 'संशोधित', path: 'पथ',
        dirBadge: 'DIR', fileBadge: 'FILE', loading: 'खोज रहे हैं…', errorPrefix: 'खोज विफल: ', empty: 'कोई मेल नहीं',
        results: '{total} परिणाम', showing: 'पहले {n} दिखाए', indexing: 'इंडेक्स बन रहा है, परिणाम अधूरे हो सकते हैं',
        copied: 'पथ कॉपी हुआ', revealed: 'फ़ाइल मैनेजर में दिखाया', opened: 'खोला गया', inserted: '@file डाला गया',
        insertFailed: 'डालना विफल; @file कॉपी हुआ', footer: '↑↓ चुनें · Enter कॉपी · Ctrl+O खोलें · Ctrl+Enter @file डालें · डबल-क्लिक दिखाएँ · Esc बंद',
        launcher: 'स्थानीय फ़ाइल खोज (Ctrl+Shift+F)',
        justNow: 'अभी', minutesAgo: '{n} मिनट पहले', hoursAgo: '{n} घंटे पहले',
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
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text)
      }
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

    // ── helpers ─────────────────────────────────────────────────────────────
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

    function highlight(name, query) {
      const words = query.split(/\s+/).filter(word => word !== '' && !word.includes(':') && !word.startsWith('!') && !word.includes('*') && !word.includes('?'))
      if (words.length === 0) return name
      try {
        const pattern = new RegExp('(' + words.map(escapeRegExp).join('|') + ')', 'gi')
        const parts = name.split(pattern)
        return parts.map((part, index) => (index % 2 === 1 ? h('mark', { className: 'dsh-locator-hit', key: index }, part) : part))
      } catch {
        return name
      }
    }

    // ── panel ───────────────────────────────────────────────────────────────
    const PAGE = 100

    function Panel() {
      const open = useOpen()
      const [query, setQuery] = useState('')
      const [sort, setSort] = useState('mtime')
      const [desc, setDesc] = useState(true)
      const [filesOnly, setFilesOnly] = useState(false)
      const [dirsOnly, setDirsOnly] = useState(false)
      const [hits, setHits] = useState([])
      const [total, setTotal] = useState(0)
      const [took, setTook] = useState(0)
      const [truncated, setTruncated] = useState(false)
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      const [selected, setSelected] = useState(0)
      const [toast, setToast] = useState('')
      const inputRef = useRef(null)
      const abortRef = useRef(null)
      const listRef = useRef(null)

      const close = useCallback(() => store.set(false), [])

      useEffect(() => {
        if (!open) return undefined
        setError('')
        const timer = setTimeout(() => inputRef.current && inputRef.current.focus(), 30)
        return () => clearTimeout(timer)
      }, [open])

      useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        let timer = 0
        const load = () => {
          const controller = new AbortController()
          post('/dsh-locator/status', {}, controller.signal).then(next => {
            if (cancelled) return
            setStatus(next)
            if (next && next.scanning) timer = setTimeout(load, 1500)
          }).catch(() => {})
        }
        load()
        return () => { cancelled = true; clearTimeout(timer) }
      }, [open])

      useEffect(() => {
        if (!open) return undefined
        const timer = setTimeout(() => {
          if (abortRef.current) abortRef.current.abort()
          const controller = new AbortController()
          abortRef.current = controller
          setLoading(true)
          setError('')
          post('/dsh-locator/search', {
            query,
            limit: PAGE,
            offset: 0,
            sort,
            desc,
            filesOnly,
            dirsOnly,
          }, controller.signal).then(data => {
            if (controller.signal.aborted) return
            setHits(Array.isArray(data.hits) ? data.hits : [])
            setTotal(typeof data.total === 'number' ? data.total : 0)
            setTook(typeof data.tookMs === 'number' ? data.tookMs : 0)
            setTruncated(data.truncated === true)
            setSelected(0)
            setLoading(false)
          }).catch(cause => {
            if (controller.signal.aborted) return
            setHits([])
            setTotal(0)
            setError(cause instanceof Error ? cause.message : String(cause))
            setLoading(false)
          })
        }, 110)
        return () => clearTimeout(timer)
      }, [open, query, sort, desc, filesOnly, dirsOnly])

      const toggleSort = useCallback(key => {
        if (sort === key) {
          setDesc(value => !value)
        } else {
          setSort(key)
          setDesc(key === 'mtime' || key === 'size')
        }
      }, [sort])

      const notify = useCallback(message => {
        setToast(message)
        setTimeout(() => setToast(''), 1600)
      }, [])

      const copy = useCallback(hit => {
        if (!hit) return
        copyText(hit.path).then(() => notify(t('copied'))).catch(() => {})
      }, [notify])

      const reveal = useCallback(hit => {
        if (!hit) return
        post('/dsh-locator/reveal', { path: hit.path }).then(() => notify(t('revealed'))).catch(() => copy(hit))
      }, [copy, notify])

      const openFile = useCallback(hit => {
        if (!hit || hit.dir) return
        post('/dsh-locator/open', { path: hit.path }).then(() => notify(t('opened'))).catch(() => copy(hit))
      }, [copy, notify])

      const insert = useCallback(hit => {
        if (!hit) return
        const mention = '@"' + hit.path.replace(/"/g, '') + '" '
        close()
        setTimeout(() => {
          if (insertIntoComposer(mention)) {
            notify(t('inserted'))
          } else {
            copyText(mention).then(() => notify(t('insertFailed'))).catch(() => {})
          }
        }, 80)
      }, [close, notify])

      const onKeyDown = useCallback(event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSelected(value => Math.min(hits.length - 1, value + 1))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSelected(value => Math.max(0, value - 1))
          return
        }
        const modifier = event.ctrlKey || event.metaKey
        if (modifier && String(event.key).toLowerCase() === 'o') {
          event.preventDefault()
          openFile(hits[selected])
          return
        }
        if (modifier && event.key === 'Enter' && !event.isComposing) {
          event.preventDefault()
          insert(hits[selected])
          return
        }
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault()
          copy(hits[selected])
        }
      }, [close, copy, hits, insert, openFile, selected])

      useEffect(() => {
        const list = listRef.current
        if (!list) return
        const row = list.querySelector('[data-index="' + selected + '"]')
        if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
      }, [selected])

      if (!open) return null

      const header = (key, label, width) => h('th', {
        key,
        className: sort === key ? 'sorted' : '',
        style: { width },
        onClick: () => toggleSort(key),
        title: t('sortTitle'),
      }, label + (sort === key ? (desc ? ' ↓' : ' ↑') : ''))

      return h('div', {
        className: 'dsh-locator-overlay',
        onMouseDown: event => { if (event.target === event.currentTarget) close() },
      }, h('div', {
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
            onChange: event => setQuery(event.target.value),
            'aria-label': t('searchLabel'),
          }),
          h('span', { className: 'dsh-locator-kbd' }, 'Ctrl+Shift+F'),
          h('button', { className: 'dsh-locator-close', onClick: close, title: t('closeTitle'), 'aria-label': t('closeLabel') }, '✕'),
        ),
        h('div', { className: 'dsh-locator-bar' },
          h('label', { className: 'dsh-locator-check' },
            h('input', { type: 'checkbox', checked: filesOnly, onChange: event => { setFilesOnly(event.target.checked); if (event.target.checked) setDirsOnly(false) } }),
            t('filesOnly')),
          h('label', { className: 'dsh-locator-check' },
            h('input', { type: 'checkbox', checked: dirsOnly, onChange: event => { setDirsOnly(event.target.checked); if (event.target.checked) setFilesOnly(false) } }),
            t('dirsOnly')),
          h('span', { className: 'dsh-locator-status' },
            status === null
              ? t('statusLoading')
              : t('status', {
                  entries: (status.entries || 0).toLocaleString(),
                  mode: status.watching ? t('live') : t('snapshot'),
                  roots: (status.roots || []).length,
                }) + ((status.usnActive || status.usn) ? ' · ' + t('usn') : '')),
        ),
        h('div', { className: 'dsh-locator-scroll', ref: listRef },
          h('table', { className: 'dsh-locator-table' },
            h('colgroup', null,
              h('col', { style: { width: '34%' } }),
              h('col', { style: { width: '12%' } }),
              h('col', { style: { width: '13%' } }),
              h('col', { style: { width: '41%' } }),
            ),
            h('thead', null, h('tr', null,
              header('name', t('name')),
              header('size', t('size')),
              header('mtime', t('mtime')),
              header('path', t('path')),
            )),
            h('tbody', null,
              hits.length === 0
                ? h('tr', null, h('td', { colSpan: 4, className: 'dsh-locator-empty' },
                    loading ? t('loading') : error !== '' ? t('errorPrefix') + error : t('empty')))
                : hits.map((hit, index) => h('tr', {
                    key: hit.path,
                    'data-index': index,
                    className: 'dsh-locator-row' + (index === selected ? ' sel' : ''),
                    title: hit.path,
                    onClick: () => setSelected(index),
                    onDoubleClick: () => reveal(hit),
                  },
                  h('td', null, h('div', { className: 'dsh-locator-name' },
                    h('span', { className: 'dsh-locator-badge' }, hit.dir ? t('dirBadge') : (hit.ext || t('fileBadge')).toUpperCase()),
                    h('span', null, highlight(hit.name, query)),
                  )),
                  h('td', { className: 'dsh-locator-size' }, hit.dir ? '' : formatSize(hit.size)),
                  h('td', { className: 'dsh-locator-time' }, formatTime(hit.mtime)),
                  h('td', { className: 'dsh-locator-path' }, hit.path),
                )),
            ),
          ),
        ),
        h('div', { className: 'dsh-locator-foot' },
          h('span', null,
            loading
              ? t('loading')
              : t('results', { total: total.toLocaleString() }) + (truncated ? ' (' + t('showing', { n: hits.length }) + ')' : '') + ' · ' + took.toFixed(1) + ' ms'
                + (status && status.scanning ? ' · ' + t('indexing') : '')),
          h('span', { className: 'grow' }),
          toast === '' ? null : h('span', { className: 'dsh-locator-toast' }, toast),
          h('span', null, t('footer')),
        ),
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
      inject: ['slots'],
      apply(ctx) {
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

/**
 * Client half of the default-session-mode plugin.
 *
 * Registers one entry in `plugins.detail.actions`, the action row at the head of
 * the official Plugins page: a compact 「模式」 button that opens the settings
 * panel. It does not take a left-sidebar slot, and it does not use
 * `plugins.bundle.config`, because the page renders the package README as its
 * long description and that slot is placed *after* it — the setting would sit
 * below the whole README.
 *
 * Permission modes render bilingually: the Chinese name leads and the English
 * name follows as the secondary line, matching the wording of DSH's own
 * permission picker.
 *
 * All data comes from the Host half's same-origin routes, so the browser's DSH
 * session authorizes the read and the write; nothing is stored in the page.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-default-auto-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATE_ENDPOINT = '/dsh-default-preset/state'
    const SAVE_ENDPOINT = '/dsh-default-preset/preset'
    const POLL_INTERVAL_MS = 10000
    const FETCH_TIMEOUT_MS = 8000

    const PluginContext = React.createContext(null)

    const DICT = {
      zh: {
        panel: '新会话模式',
        title: '新会话默认权限模式',
        subtitle: '新建会话时自动套用的权限模式；已有会话、恢复的会话和派生会话都不受影响。',
        current: '当前设置',
        effective: '生效中',
        unavailable: '不可用',
        sourceSettings: '来源：本机设置文件 ~/.dsh/dsh-default-preset.json',
        sourcePinned: '来源：cordis.patch.yml（已固定，面板只读）',
        pick: '选择模式',
        pickHint: '点一下就会保存并立即用于之后新建的会话。',
        applyToSeeded: '也套用到恢复的会话',
        applyToSeededHint: '默认关闭：恢复的会话保留它原本的权限设置。',
        applyToSubagents: '也套用到子代理会话',
        applyToSubagentsHint: '默认关闭：子代理沿用父会话交给它的权限。',
        on: '开',
        off: '关',
        stats: '本次启动已应用到',
        sessions: '个新会话',
        none: '本次启动还没有新建会话',
        recent: '最近应用',
        noRecent: '暂无记录',
        loading: '正在读取设置…',
        loadFailed: '读取设置失败',
        retry: '重试',
        saving: '保存中…',
        saved: '已保存',
        catalogError: '读取可选模式失败：',
        noPresets: '当前没有可选的权限模式。',
        autoHint: 'Auto review（自动审查）由内置集成提供，只有该集成启用时才可选。',
        sessionLabel: '会话',
        fixed: '该项由 cordis.patch.yml 固定',
        modeButton: '模式',
        close: '关闭'
      },
      en: {
        panel: 'New-session mode',
        title: 'Default permission mode for new sessions',
        subtitle:
          'The permission mode applied to new sessions. Existing, resumed, and delegated sessions are unaffected.',
        current: 'Current setting',
        effective: 'Active',
        unavailable: 'Unavailable',
        sourceSettings: 'Source: local settings file ~/.dsh/dsh-default-preset.json',
        sourcePinned: 'Source: cordis.patch.yml (pinned — read-only here)',
        pick: 'Choose a mode',
        pickHint: 'Selecting one saves it and applies it to every session created afterwards.',
        applyToSeeded: 'Also apply to resumed sessions',
        applyToSeededHint: 'Off by default: a resumed session keeps the policy it already carries.',
        applyToSubagents: 'Also apply to delegated sessions',
        applyToSubagentsHint: 'Off by default: a delegated session keeps the policy its parent handed it.',
        on: 'On',
        off: 'Off',
        stats: 'Applied to',
        sessions: 'new sessions since launch',
        none: 'No new session since launch',
        recent: 'Recently applied',
        noRecent: 'No records yet',
        loading: 'Reading the setting…',
        loadFailed: 'Could not read the setting',
        retry: 'Retry',
        saving: 'Saving…',
        saved: 'Saved',
        catalogError: 'Could not read the preset catalog: ',
        noPresets: 'No permission mode is selectable right now.',
        autoHint: 'Auto review comes from the built-in integration and is selectable only while it is enabled.',
        sessionLabel: 'Session',
        fixed: 'Pinned by cordis.patch.yml',
        modeButton: 'Mode',
        close: 'Close'
      }
    }

    /** @param {string} lang @param {string} key */
    function dictFor(lang, key) {
      const table = DICT[lang] || DICT.en
      const value = table[key]
      return typeof value === 'string' ? value : key
    }

    /**
     * Display names for the built-in permission presets, using the wording the
     * Harness itself uses (`@deepseek-ai/dsh-client-ui-permission-presets`:
     * 「仅可查看」「工作区内修改」「完全权限」「自动审查」 / `Read Only`,
     * `Workspace Write`, `Full access`, `Auto review`). The catalog reports the
     * raw value as both name and description, which is why the picker used to
     * show `read-only` twice; the Chinese label leads and the English one sits
     * underneath as the secondary line.
     */
    const PRESET_LABELS = {
      'read-only': { zh: '仅可查看', en: 'Read Only' },
      'workspace-write': { zh: '工作区内修改', en: 'Workspace Write' },
      'danger-full-access': { zh: '完全权限', en: 'Full access' },
      auto: { zh: '自动审查', en: 'Auto review' }
    }

    /**
     * The two lines of one preset: the Chinese name first, the English name
     * second. A preset the table does not know (a custom preset from the
     * profile) falls back to whatever the catalog calls it, so nothing ever
     * renders as an empty row.
     * @param {{ value: string, name: string, description: string }} option
     * @returns {{ primary: string, secondary: string, note: string }}
     */
    function presetText(option) {
      const known = PRESET_LABELS[option.value]
      if (known !== undefined) {
        return { primary: known.zh, secondary: known.en, note: option.description === option.value ? '' : option.description }
      }
      const primary = option.name && option.name !== option.value ? option.name : option.value
      const secondary = option.value === primary ? '' : option.value
      const note = option.description && option.description !== option.value && option.description !== primary
        ? option.description
        : ''
      return { primary, secondary, note }
    }

    /** The two-line label of the preset currently in effect, by its value. */
    function presetTextOf(value) {
      return presetText({ value, name: value, description: value })
    }

    function activeLang(ctx) {
      try {
        const snapshot = ctx.locale?.getLocale?.()
        const id = String((snapshot && snapshot.active) || 'en').toLowerCase()
        return id.indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (_error) {
        return 'en'
      }
    }

    function useTranslate(ctx) {
      const [lang, setLang] = React.useState(() => activeLang(ctx))
      React.useEffect(() => {
        setLang(activeLang(ctx))
        if (!ctx.locale || typeof ctx.locale.subscribe !== 'function') return undefined
        return ctx.locale.subscribe(() => setLang(activeLang(ctx)))
      }, [ctx])
      return React.useCallback((key) => dictFor(lang, key), [lang])
    }

    const styles = {
      // The form is rendered inside the plugin page's own section, which
      // already supplies the outer padding and a 12px stack gap.
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        maxWidth: '860px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: '20px'
      },
      header: { display: 'flex', flexDirection: 'column', gap: '4px' },
      sectionTitle: { margin: 0, fontSize: '14px', fontWeight: 500 },
      subtitle: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      currentValue: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '14px 16px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)'
      },
      cardTitle: { margin: 0, fontSize: '13px', fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: '10px', justifyContent: 'space-between' },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '0 8px',
        borderRadius: '999px',
        fontSize: '11px',
        lineHeight: '18px',
        border: '1px solid var(--dsw-alias-border-l2)'
      },
      dot: { width: '6px', height: '6px', borderRadius: '999px', background: 'currentColor' },
      okText: { color: 'var(--dsw-alias-state-success-primary)' },
      errorText: { color: 'var(--dsw-alias-state-error-primary)' },
      idleText: { color: 'var(--dsw-alias-state-idle-primary)' },
      warnText: { color: 'var(--dsw-alias-state-warn-primary)' },
      option: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '10px 12px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        width: '100%'
      },
      optionActive: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-bg-layer-2)'
      },
      optionTitle: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 auto' },
      optionName: { fontWeight: 600, fontSize: '13px' },
      optionEnglish: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', lineHeight: '15px' },
      optionValue: {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
      },
      radio: {
        flex: '0 0 auto',
        width: '14px',
        height: '14px',
        marginTop: '2px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center'
      },
      radioDot: {
        width: '7px',
        height: '7px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-brand-primary)'
      },
      button: {
        padding: '6px 12px',
        borderRadius: '9px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer'
      },
      actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
      code: {
        padding: '1px 6px',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '12px'
      },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      notice: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '12px 14px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px'
      },
      recentRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)'
      },
      spinner: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      // The header control sits in the plugin page's action row, next to the
      // enable switch; the panel it opens floats below it.
      anchor: { position: 'relative', display: 'inline-flex' },
      modeButton: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 10px',
        height: '28px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer'
      },
      modeButtonLabel: { color: 'var(--dsw-alias-label-secondary)' },
      modeButtonValue: { fontWeight: 600 },
      caret: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' },
      popover: {
        position: 'absolute',
        top: 'calc(100% + 8px)',
        right: 0,
        zIndex: 40,
        width: '360px',
        maxWidth: 'calc(100vw - 48px)',
        maxHeight: '70vh',
        overflowY: 'auto',
        padding: '16px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
        textAlign: 'left'
      },
      popoverHead: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: '-6px' },
      iconButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '24px',
        height: '24px',
        padding: 0,
        borderRadius: '6px',
        border: 0,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: '14px',
        lineHeight: '1',
        cursor: 'pointer'
      }
    }

    function StatusPill(props) {
      const style = {
        ...styles.pill,
        ...(props.tone === 'ok' ? styles.okText : props.tone === 'error' ? styles.errorText : styles.idleText)
      }
      return h('span', { style }, h('span', { style: styles.dot, 'aria-hidden': true }), props.children)
    }

    function ToggleButton(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          disabled: props.disabled,
          style: { ...styles.button, opacity: props.disabled ? 0.55 : 1 },
          onClick: () => props.onChange(!props.checked)
        },
        `${props.label}：${props.checked ? props.t('on') : props.t('off')}`
      )
    }

    function usePresetState() {
      const [snapshot, setSnapshot] = React.useState({ phase: 'loading', data: null, error: '' })
      const aliveRef = React.useRef(true)
      React.useEffect(
        () => () => {
          aliveRef.current = false
        },
        []
      )

      const load = React.useCallback(async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
          const response = await fetch(STATE_ENDPOINT, {
            signal: controller.signal,
            credentials: 'same-origin',
            headers: { accept: 'application/json' }
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (!aliveRef.current) return
          setSnapshot({ phase: 'ready', data, error: '' })
        } catch (error) {
          if (!aliveRef.current) return
          if (error && error.name === 'AbortError') return
          setSnapshot((previous) => ({
            phase: previous.data ? 'ready' : 'failed',
            data: previous.data,
            error: error instanceof Error ? error.message : String(error)
          }))
        } finally {
          clearTimeout(timer)
        }
      }, [])

      React.useEffect(() => {
        void load()
        const interval = setInterval(() => void load(), POLL_INTERVAL_MS)
        return () => clearInterval(interval)
      }, [load])

      const save = React.useCallback(
        async (patch) => {
          const response = await fetch(SAVE_ENDPOINT, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(patch)
          })
          const result = await response.json().catch(() => null)
          if (!result || result.ok !== true) {
            throw new Error((result && result.error) || `HTTP ${response.status}`)
          }
          if (aliveRef.current && result.state) {
            setSnapshot({ phase: 'ready', data: result.state, error: '' })
          }
          return result.state
        },
        []
      )

      return { ...snapshot, reload: load, save }
    }

    /**
     * The settings panel body: current mode, the picker, the two scopes, and
     * what this launch has applied. It renders inside the header popover, which
     * owns the data read so the button and the panel never poll separately.
     * @param {{ snapshot: any, t: (key: string) => string }} props
     */
    function PresetPanel(props) {
      const t = props.t
      const snapshot = props.snapshot
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [failure, setFailure] = React.useState('')

      const data = snapshot.data
      const settings = data ? data.settings : null
      const pinned = data && Array.isArray(data.pinned) ? data.pinned : []
      const presets = data && Array.isArray(data.presets) ? data.presets : []

      const commit = async (patch) => {
        setSaving(true)
        setFailure('')
        setNotice('')
        try {
          await snapshot.save(patch)
          setNotice(t('saved'))
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setSaving(false)
        }
      }

      const header = h(
        'div',
        { style: styles.header },
        h('h2', { style: styles.sectionTitle }, t('title')),
        h('p', { style: styles.subtitle }, t('subtitle'))
      )

      if (snapshot.phase === 'loading' && !data) {
        return h('div', { style: styles.page }, header, h('p', { style: styles.spinner }, t('loading')))
      }

      if (snapshot.phase === 'failed' && !data) {
        return h(
          'div',
          { style: styles.page },
          header,
          h(
            'div',
            { style: styles.notice },
            h('strong', { style: styles.errorText }, t('loadFailed')),
            h('span', null, snapshot.error || ''),
            h(
              'div',
              { style: styles.actions },
              h('button', { type: 'button', style: styles.button, onClick: () => void snapshot.reload() }, t('retry'))
            )
          )
        )
      }

      const currentOption = presets.find((option) => option.value === (settings && settings.preset))
      const currentText = currentOption
        ? presetText(currentOption)
        : presetTextOf(String((settings && settings.preset) || ''))
      const pinnedPreset = pinned.indexOf('preset') >= 0
      const pinnedSeeded = pinned.indexOf('skipSeeded') >= 0
      const pinnedSubagents = pinned.indexOf('skipSubagents') >= 0

      const currentCard = h(
        'section',
        { style: styles.card },
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.subtitle }, t('current')),
          currentOption
            ? h(StatusPill, { tone: 'ok' }, t('effective'))
            : h(StatusPill, { tone: 'error' }, t('unavailable'))
        ),
        h(
          'div',
          { style: styles.currentValue },
          h('span', { style: styles.optionName }, currentText.primary),
          currentText.secondary ? h('span', { style: styles.optionEnglish }, currentText.secondary) : null,
          h('code', { style: styles.code }, (settings && settings.preset) || '—')
        ),
        currentText.note ? h('p', { style: styles.subtitle }, currentText.note) : null,
        h('p', { style: styles.subtitle }, pinned.length > 0 ? t('sourcePinned') : t('sourceSettings')),
        (settings && settings.preset === 'auto' && !currentOption) || (data && data.catalogError)
          ? h(
              'p',
              { style: { ...styles.subtitle, ...styles.warnText } },
              data && data.catalogError ? `${t('catalogError')}${data.catalogError}` : '',
              settings && settings.preset === 'auto' && !currentOption ? t('autoHint') : ''
            )
          : null
      )

      const optionRows = presets.map((option) => {
        const text = presetText(option)
        return h(
          'button',
          {
            key: option.value,
            type: 'button',
            style: {
              ...styles.option,
              ...(settings && settings.preset === option.value ? styles.optionActive : {})
            },
            disabled: saving || pinnedPreset,
            onClick: () => {
              if (saving || pinnedPreset || (settings && settings.preset === option.value)) return
              void commit({ preset: option.value })
            }
          },
          h(
            'span',
            { style: styles.radio, 'aria-hidden': true },
            settings && settings.preset === option.value ? h('span', { style: styles.radioDot }) : null
          ),
          h(
            'span',
            { style: styles.optionTitle },
            h('span', { style: styles.optionName }, text.primary),
            text.secondary ? h('span', { style: styles.optionEnglish }, text.secondary) : null,
            text.note ? h('span', { style: styles.subtitle }, text.note) : null
          ),
          h('span', { style: styles.optionValue }, option.value)
        )
      })

      const pickerCard = h(
        'section',
        { style: styles.card },
        h('h2', { style: styles.cardTitle }, t('pick')),
        h('p', { style: styles.subtitle }, t('pickHint')),
        presets.length > 0
          ? h('div', { style: styles.list }, ...optionRows)
          : h('p', { style: styles.subtitle }, t('noPresets')),
        pinnedPreset ? h('p', { style: { ...styles.subtitle, ...styles.warnText } }, t('fixed')) : null,
        h(
          'div',
          { style: styles.actions },
          h(ToggleButton, {
            t,
            label: t('applyToSeeded'),
            checked: Boolean(settings && settings.skipSeeded),
            disabled: saving || pinnedSeeded,
            onChange: (value) => void commit({ skipSeeded: value })
          }),
          h(ToggleButton, {
            t,
            label: t('applyToSubagents'),
            checked: Boolean(settings && settings.skipSubagents),
            disabled: saving || pinnedSubagents,
            onChange: (value) => void commit({ skipSubagents: value })
          }),
          saving ? h('span', { style: styles.spinner }, t('saving')) : null,
          notice ? h('span', { style: { ...styles.subtitle, ...styles.okText } }, notice) : null
        ),
        h('p', { style: styles.subtitle }, t('applyToSeededHint')),
        h('p', { style: styles.subtitle }, t('applyToSubagentsHint'))
      )

      const recent = data && Array.isArray(data.recent) ? data.recent : []
      const statsCard = h(
        'section',
        { style: styles.card },
        h(
          'div',
          { style: styles.row },
          h(
            'span',
            { style: styles.subtitle },
            t('stats'),
            ' ',
            h('strong', { style: { color: 'var(--dsw-alias-label-primary)' } }, String((data && data.appliedCount) || 0)),
            ' ',
            t('sessions')
          )
        ),
        recent.length === 0
          ? h('p', { style: styles.subtitle }, t('none'))
          : h(
              'div',
              { style: styles.list },
              h('p', { style: styles.subtitle }, t('recent')),
              ...recent.map((entry) =>
                h(
                  'div',
                  { key: `${entry.id}-${entry.at}`, style: styles.recentRow },
                  h('span', null, `${t('sessionLabel')} ${String(entry.id).slice(0, 18)}`),
                  h('span', null, `${entry.preset} · ${new Date(entry.at).toLocaleTimeString()}`)
                )
              )
            )
      )

      return h(
        'div',
        { style: styles.page, 'data-plugin': 'default-auto-review' },
        header,
        currentCard,
        failure ? h('p', { style: { ...styles.subtitle, ...styles.errorText } }, failure) : null,
        pickerCard,
        statsCard
      )
    }

    /** The package name doubles as the client module id. */
    const PACKAGE_NAME = 'dsh-plugin-default-auto-review'

    /**
     * The header control: a compact button naming the mode new sessions start
     * in, opening the settings panel below it.
     *
     * Why the header: the Plugins page renders a bundle's README as its long
     * description, and the configuration slot (`plugins.bundle.config`) is
     * always placed after that document. `plugins.detail.actions` is the only
     * slot rendered above it, so this is where a one-click settings control can
     * live without scrolling past the README.
     */
    function ModeControl() {
      const ctx = React.useContext(PluginContext)
      const t = useTranslate(ctx)
      const snapshot = usePresetState()
      const [open, setOpen] = React.useState(false)
      const anchorRef = React.useRef(null)

      const settings = snapshot.data ? snapshot.data.settings : null
      const current = presetTextOf(String((settings && settings.preset) || ''))

      // Close on an outside press or Escape, the way a menu in this page does.
      React.useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined') return undefined
        const onPointerDown = (event) => {
          const anchor = anchorRef.current
          if (anchor !== null && anchor.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      return h(
        'div',
        { style: styles.anchor, ref: anchorRef },
        h(
          'button',
          {
            type: 'button',
            style: styles.modeButton,
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            title: t('title'),
            onClick: () => setOpen((value) => !value)
          },
          h('span', { style: styles.modeButtonLabel }, t('modeButton')),
          h('span', { style: styles.modeButtonValue }, current.primary),
          h('span', { style: styles.caret, 'aria-hidden': true }, '▾')
        ),
        open
          ? h(
              'div',
              { style: styles.popover, role: 'dialog', 'aria-label': t('title') },
              h(
                'div',
                { style: styles.popoverHead },
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.iconButton,
                    'aria-label': t('close'),
                    onClick: () => setOpen(false)
                  },
                  '✕'
                )
              ),
              h(PresetPanel, { snapshot, t })
            )
          : null
      )
    }

    /**
     * The page renders this entry in its header for every subject; only the
     * bundle this plugin belongs to gets a control.
     * @param {{ subject?: { kind?: string, pkg?: { name?: string } } }} [props]
     */
    function ModeAction(props) {
      const subject = props && props.subject
      const mine = Boolean(
        subject
        && subject.kind === 'bundle'
        && subject.pkg
        && subject.pkg.name === PACKAGE_NAME
      )
      return mine ? h(ModeControl) : null
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The settings live in the plugin page's header instead of a
        // left-sidebar entry of its own: the page renders the package README as
        // its long description, and the configuration slot sits below that
        // document, so a header control is what keeps the setting above it.
        ctx.slots.inject('plugins.detail.actions', () =>
          ctx.slots.register(
            {
              name: 'plugins.detail.actions',
              id: 'default-auto-review-mode',
              order: 0
            },
            (props) => h(PluginContext.Provider, { value: ctx }, h(ModeAction, props))
          )
        )
      }
    }
  }
})

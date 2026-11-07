#!/usr/bin/env node
/**
 * Client-half checks for dsh-plugin-default-auto-review.
 *
 * The browser half is a `window.__ModuleLoader__` factory, so nothing here can
 * import it: the test evaluates the file with a fake loader and a fake `require`
 * that hands back a miniature React. That is enough to render the panel and
 * assert what the user sees — which slot it registers into, and whether each
 * permission mode carries its Chinese name above its English one.
 *
 * Run: node test/client-unit.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = path.join(HERE, '..', 'client.js')
const PACKAGE_NAME = 'dsh-plugin-default-auto-review'

const results = []
/** @param {string} name @param {() => void} body */
function check(name, body) {
  try {
    body()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** @param {() => Promise<void>} body */
async function checkAsync(name, body) {
  try {
    await body()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
  }
}

// --- a miniature React -------------------------------------------------------
// Hooks are stored per component instance (a path in the rendered tree) and
// read through the `current` render frame, so the panel's hooks keep identity
// across the re-render that follows its first fetch.
function createReact() {
  const store = new Map()
  let current = { cells: [], index: 0, effects: [], dirty: false }

  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity)
      // Real React puts children on props, and components such as a context
      // Provider read them from there.
      return { type, props: { ...(props || {}), children: flat }, children: flat }
    },
    createContext(initial) {
      const context = { value: initial }
      context.Provider = function Provider(providerProps) {
        context.value = providerProps.value
        return providerProps.children
      }
      return context
    },
    useContext(context) {
      return context.value
    },
    useState(initial) {
      // The setter keeps its own component's cell list and marks the whole
      // pass dirty, so a state update that lands after an await still
      // triggers the re-render the test waits for.
      const frame = current
      const cell = frame.index++
      if (!(cell in frame.cells)) {
        frame.cells[cell] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => {
        const value = typeof next === 'function' ? next(frame.cells[cell]) : next
        if (value === frame.cells[cell]) return
        frame.cells[cell] = value
        frame.pass.dirty = true
      }
      return [frame.cells[cell], set]
    },
    useRef(initial) {
      const frame = current
      const cell = frame.index++
      if (!(cell in frame.cells)) frame.cells[cell] = { current: initial }
      return frame.cells[cell]
    },
    useCallback(fn, deps) {
      const frame = current
      const cell = frame.index++
      const previous = frame.cells[cell]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.fn
      frame.cells[cell] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const frame = current
      const cell = frame.index++
      const previous = frame.cells[cell]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
      const value = fn()
      frame.cells[cell] = { value, deps }
      return value
    },
    useEffect(fn, deps) {
      const frame = current
      const cell = frame.index++
      frame.effects.push({ cell, fn, deps })
    }
  }

  /** @param {unknown[] | undefined} a @param {unknown[] | undefined} b */
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index])

  /** @param {any} cells @param {any[]} effects */
  function runEffects(cells, effects) {
    for (const { cell, fn, deps } of effects) {
      const previous = cells[cell]
      if (previous !== undefined && sameDeps(previous.deps, deps)) continue
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = fn()
      cells[cell] = { deps, cleanup }
    }
  }

  /**
   * @param {any} node
   * @param {string} key
   * @param {{ dirty: boolean }} pass
   * @returns {any}
   */
  function renderNode(node, key, pass) {
    if (node === null || node === undefined || node === true || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${key}.${index}`, pass))
    if (typeof node.type === 'function') {
      const label = typeof node.type.name === 'string' && node.type.name !== '' ? node.type.name : 'anonymous'
      const childKey = `${key}>${label}`
      const cells = store.get(childKey) || []
      store.set(childKey, cells)
      const parent = current
      current = { cells, index: 0, effects: [], pass }
      const rendered = node.type(node.props)
      runEffects(cells, current.effects)
      current = parent
      return renderNode(rendered, childKey, pass)
    }
    return { tag: String(node.type), props: node.props, children: node.children.map((child, index) => renderNode(child, `${key}.${index}`, pass)) }
  }

  /**
   * Render a component, let its effects settle, and re-render until nothing
   * schedules another update. Bounded so a render loop fails instead of hanging.
   * @param {any} component
   * @param {any} props
   */
  async function render(component, props) {
    let tree = null
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const key = 'root'
      const cells = store.get(key) || []
      store.set(key, cells)
      const pass = { dirty: false }
      current = { cells, index: 0, effects: [], pass }
      tree = renderNode({ type: component, props: props || {}, children: [] }, key, pass)
      runEffects(cells, current.effects)
      await new Promise((resolve) => setImmediate(resolve))
      if (!pass.dirty) return tree
    }
    throw new Error('component kept scheduling updates after 25 renders')
  }

  return { React, render }
}

/** Every text node of a rendered tree, in document order. */
function textsOf(tree, out = []) {
  if (tree === null || tree === undefined) return out
  if (typeof tree === 'string') {
    out.push(tree)
    return out
  }
  if (Array.isArray(tree)) {
    for (const child of tree) textsOf(child, out)
    return out
  }
  textsOf(tree.children, out)
  return out
}

// --- loading the client half -------------------------------------------------
/**
 * Evaluate client.js the way the page does: capture the loader entry, then run
 * its factory with a `require` that resolves `react`.
 */
function loadClient(fetchImpl) {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  let entry = null
  const window = {
    __ModuleLoader__: {
      load(loaded) {
        entry = loaded
      }
    }
  }
  const { React, render } = createReact()
  const require = (specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require('${specifier}')`)
  }
  // The panel polls with `setInterval`; in the test the initial fetch is the
  // only load that matters, and a live interval would keep the process alive.
  const timers = { intervals: 0, cleared: 0 }
  const setIntervalStub = () => {
    timers.intervals += 1
    return timers.intervals
  }
  const clearIntervalStub = () => {
    timers.cleared += 1
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', 'fetch', 'setInterval', 'clearInterval', source)(
    window,
    require,
    fetchImpl,
    setIntervalStub,
    clearIntervalStub
  )
  assert.ok(entry !== null, 'client.js did not register a module loader entry')
  return { entry, plugin: entry.factory(require), render, timers }
}

const STATE_PAYLOAD = {
  ok: true,
  now: Date.now(),
  settings: { preset: 'auto', skipSeeded: true, skipSubagents: true },
  pinned: [],
  presets: [
    { value: 'read-only', name: 'read-only', description: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write', description: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access', description: 'danger-full-access' },
    { value: 'auto', name: 'auto', description: 'auto' }
  ],
  defaultPreset: 'workspace-write',
  catalogError: '',
  appliedCount: 3,
  recent: [{ id: 'session-abc123def456', preset: 'auto', at: Date.now() }]
}

/** A fetch stub that answers the panel's state route and records saves. */
function createFetch(payload = STATE_PAYLOAD) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/dsh-default-preset/preset')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, state: payload }) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  impl.calls = calls
  return impl
}

/** A slot registry that records injections and registrations. */
function createContext() {
  const injected = []
  const registrations = []
  const ctx = {
    slots: {
      inject(name, factory) {
        injected.push(name)
        return factory()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      }
    },
    locale: {
      getLocale: () => ({ active: 'zh', locales: ['zh', 'en'], revision: 1 }),
      getSnapshot: () => ({ active: 'zh', locales: ['zh', 'en'], revision: 1 }),
      subscribe: () => () => {}
    },
    logger: { warn() {}, info() {} }
  }
  return { ctx, injected, registrations }
}

// --- checks ------------------------------------------------------------------
const loaded = loadClient(createFetch())

/** The subject the Plugins page passes for this bundle's own page. */
const SUBJECT = { kind: 'bundle', pkg: { name: PACKAGE_NAME } }

/**
 * A fresh client instance per check: the renderer keeps component state in the
 * client, so sharing one instance would leak an open panel into the next check.
 * @param {any} [payload]
 */
function setup(payload) {
  const fetchImpl = createFetch(payload)
  const client = loadClient(fetchImpl)
  const { ctx, injected, registrations } = createContext()
  client.plugin.apply(ctx)
  return { client, fetchImpl, injected, registrations, component: registrations[0].component }
}

/** Every button in a rendered tree, in document order. */
function buttonsOf(tree, out = []) {
  if (tree === null || tree === undefined || typeof tree === 'string') return out
  if (Array.isArray(tree)) {
    for (const child of tree) buttonsOf(child, out)
    return out
  }
  if (tree.tag === 'button') out.push(tree)
  buttonsOf(tree.children, out)
  return out
}

/** The first button whose subtree mentions `needle`. */
function buttonMentioning(tree, needle) {
  return buttonsOf(tree).find((button) => textsOf(button).join(' | ').includes(needle))
}

/**
 * Render the header entry, then press the mode button to open the panel.
 * @param {{ render: Function }} client
 * @param {any} component
 * @param {any} [subject]
 */
async function openPanel(client, component, subject = SUBJECT) {
  const closed = await client.render(component, { subject })
  const opener = buttonMentioning(closed, '模式')
  assert.ok(opener !== undefined, `the header button is missing\nrendered: ${textsOf(closed).join(' | ')}`)
  assert.ok(!textsOf(closed).join(' | ').includes('选择模式'), 'the panel starts closed')
  opener.props.onClick()
  return client.render(component, { subject })
}

check('module id is the package name', () => {
  assert.equal(loaded.entry.id, PACKAGE_NAME)
})

check('client half injects slots and locale', () => {
  assert.deepEqual(loaded.plugin.inject, ['slots', 'locale'])
})

check('registers into the plugin page header, not the sidebar', () => {
  const { injected, registrations } = setup()
  assert.deepEqual(injected, ['plugins.detail.actions'], `injected slots: ${injected.join(', ')}`)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'plugins.detail.actions')
  assert.equal(registrations[0].options.id, 'default-auto-review-mode')
  assert.ok(!injected.includes('sidebar.panellist'), 'no sidebar entry')
  assert.ok(!injected.includes('main'), 'no full-panel registration')
  // `plugins.bundle.config` renders below the README, which is exactly what
  // this plugin moved away from.
  assert.ok(!injected.includes('plugins.bundle.config'), 'no body config section')
})

check('applied registration is a component', () => {
  const { registrations } = setup()
  assert.equal(typeof registrations[0].component, 'function')
})

await checkAsync('renders nothing for another plugin\'s page', async () => {
  const { client, component } = setup()
  for (const subject of [{ kind: 'bundle', pkg: { name: 'some-other-plugin' } }, { kind: 'row', pkg: { name: PACKAGE_NAME }, row: 'x' }]) {
    const tree = await client.render(component, { subject })
    assert.equal(buttonsOf(tree).length, 0, `expected no control for ${JSON.stringify(subject)}`)
    assert.equal(textsOf(tree).join(''), '', `expected no text for ${JSON.stringify(subject)}`)
  }
})

await checkAsync('the header button names the current mode', async () => {
  const { client, component } = setup()
  const tree = await client.render(component, { subject: SUBJECT })
  const joined = textsOf(tree).join(' | ')
  assert.ok(joined.includes('模式'), 'the control is labelled 模式')
  assert.ok(joined.includes('自动审查'), 'the current mode is named on the button')
  assert.ok(!joined.includes('选择模式'), 'the panel starts closed')
})

await checkAsync('the panel opens from the header', async () => {
  const { client, component } = setup()
  const tree = await openPanel(client, component)
  const joined = textsOf(tree).join(' | ')
  assert.ok(joined.includes('选择模式'), 'the picker is rendered once the panel opens')
})

await checkAsync('every mode shows its Chinese name above its English name', async () => {
  const { client, component } = setup()
  const tree = await openPanel(client, component)
  const joined = textsOf(tree).join(' | ')

  const pairs = [
    ['仅可查看', 'Read Only'],
    ['工作区内修改', 'Workspace Write'],
    ['完全权限', 'Full access'],
    ['自动审查', 'Auto review']
  ]
  for (const [zh, en] of pairs) {
    assert.ok(joined.includes(zh), `missing Chinese label ${zh}\nrendered: ${joined}`)
    assert.ok(joined.includes(en), `missing English label ${en}\nrendered: ${joined}`)
    assert.ok(joined.indexOf(zh) < joined.indexOf(en), `${zh} must render before ${en}`)
  }
})

await checkAsync('the raw preset values are no longer used as the only label', async () => {
  const { client, component } = setup()
  const tree = await openPanel(client, component)
  const joined = textsOf(tree).join(' | ')
  assert.ok(joined.includes('仅可查看'), 'the Chinese label leads')
  assert.ok(!joined.includes('read-only | read-only'), 'no duplicated raw value')
})

await checkAsync('the panel reports what this launch applied', async () => {
  const { client, component } = setup()
  const tree = await openPanel(client, component)
  const joined = textsOf(tree).join(' | ')
  assert.ok(joined.includes('自动审查'), 'current mode in Chinese')
  assert.ok(joined.includes('Auto review'), 'current mode in English')
  assert.ok(joined.includes('3'), 'applied session count is rendered')
})

await checkAsync('an unknown preset falls back to its raw name', async () => {
  const { client, component } = setup({
    ...STATE_PAYLOAD,
    settings: { preset: 'custom-sandbox', skipSeeded: true, skipSubagents: true },
    presets: [...STATE_PAYLOAD.presets, { value: 'custom-sandbox', name: 'custom-sandbox', description: '' }]
  })
  const tree = await openPanel(client, component)
  const joined = textsOf(tree).join(' | ')
  assert.ok(joined.includes('custom-sandbox'), 'unknown preset still renders its name')
})

await checkAsync('choosing a mode posts to the save route', async () => {
  const { client, component, fetchImpl } = setup()
  const tree = await openPanel(client, component)

  const target = buttonMentioning(tree, '仅可查看')
  assert.ok(target !== undefined, 'the read-only option is a button')
  assert.equal(typeof target.props.onClick, 'function', 'the option is clickable')
  target.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  const save = fetchImpl.calls.find((call) => call.url.includes('/dsh-default-preset/preset'))
  assert.ok(save !== undefined, 'clicking an option posts to the save route')
  assert.equal(save.init.method, 'POST')
  assert.equal(JSON.parse(save.init.body).preset, 'read-only')
})

await checkAsync('the close button hides the panel', async () => {
  const { client, component } = setup()
  const tree = await openPanel(client, component)
  const closer = buttonMentioning(tree, '✕')
  assert.ok(closer !== undefined, 'the panel has a close button')
  closer.props.onClick()
  const closed = await client.render(component, { subject: SUBJECT })
  assert.ok(!textsOf(closed).join(' | ').includes('选择模式'), 'the panel is closed again')
})

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1

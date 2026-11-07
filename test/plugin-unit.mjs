// @ts-check
/**
 * Unit test for the default-session-mode plugin.
 *
 * The plugin touches a small set of ctx surfaces (effect, on, inject,
 * permissionPresets, logger), so a hand-built stub is enough — no Cordis
 * runtime, no DSH server, no real sessions. The settings file is redirected to
 * a temporary directory so the test never touches the user's home.
 *
 *   node test/plugin-unit.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-default-preset-'))
const settingsFile = path.join(tmpDir, 'settings.json')
process.env.DSH_DEFAULT_PRESET_FILE = settingsFile

const { apply, inject, name } = await import('../index.js')

const AUTO = 'auto'

function makeCtx(options = {}) {
  const {
    available = ['workspace-write', 'danger-full-access', AUTO],
    currentPreset = 'workspace-write',
    throwOnSet = false,
    errorOnCatalog = false
  } = options

  /** @type {Array<(session: any) => void>} */
  const listeners = []
  const sets = []
  const warns = []
  /** @type {any[]} */
  const routes = []

  const ctx = {
    effect(fn) {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    on(event, listener) {
      if (event !== 'session/created') throw new Error(`unexpected event ${event}`)
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    inject(names, callback) {
      if (!names.includes('webServer')) return
      callback({
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          }
        },
        effect(fn) {
          return fn()
        }
      })
    },
    permissionPresets: {
      catalog() {
        if (errorOnCatalog) throw new Error('permission presets unavailable')
        return {
          options: available.map((value) => ({ value, name: value.toUpperCase(), description: `${value} mode` })),
          defaultPreset: 'workspace-write'
        }
      },
      optionOf(preset) {
        if (!available.includes(preset)) throw new Error(`unknown preset: ${preset}`)
        return { value: preset, name: preset.toUpperCase() }
      },
      current: () => currentPreset,
      set(session, preset) {
        if (throwOnSet) throw new Error('integration is closing')
        sets.push(`${session.id}:${preset}`)
      }
    },
    logger: {
      info() {},
      warn(message) {
        warns.push(message)
      }
    }
  }

  return {
    ctx,
    sets,
    warns,
    routes,
    emit(session) {
      for (const listener of [...listeners]) listener(session)
    }
  }
}

function makeReq(method, url, body) {
  /** @type {Record<string, Function[]>} */
  const handlers = {}
  const req = {
    method,
    url,
    headers: {},
    on(event, fn) {
      ;(handlers[event] || (handlers[event] = [])).push(fn)
      return req
    },
    destroy() {}
  }
  if (body !== undefined) {
    queueMicrotask(() => {
      for (const fn of [...(handlers.data || [])]) fn(Buffer.from(body))
      for (const fn of [...(handlers.end || [])]) fn()
    })
  }
  return req
}

function makeRes() {
  const out = { status: 0, headers: null, body: '' }
  const res = {
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
      return res
    },
    end(body) {
      out.body = body === undefined ? '' : String(body)
      return res
    },
    get headersSent() {
      return out.status !== 0
    },
    get writableEnded() {
      return out.status !== 0
    }
  }
  return Object.assign(out, { res })
}

/** @param {any[]} routes @param {string} path */
function routeFor(routes, path) {
  const route = routes.find((entry) => entry.path === path)
  if (!route) throw new Error(`route not registered: ${path}`)
  return route
}

const checks = []
function check(label, ok) {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

// 1. A genuine new session gets the default preset (auto).
{
  const h = makeCtx()
  apply(h.ctx, {})
  h.emit({ id: 's1', header: { isSeeded: false } })
  check('new session switches to the default preset', h.sets.join() === 's1:auto')
  check('no warnings on the happy path', h.warns.length === 0)
}

// 2. Seeded / resumed sessions keep their preset.
{
  const h = makeCtx()
  apply(h.ctx, {})
  h.emit({ id: 's2', header: { isSeeded: true } })
  check('seeded session is left alone', h.sets.length === 0)
}

// 3. Delegated child sessions keep their preset.
{
  const h = makeCtx()
  apply(h.ctx, {})
  h.emit({ id: 's3', header: { isSeeded: false, parentSession: 'parent-1' } })
  check('child session is left alone', h.sets.length === 0)
}

// 4. A session already in the preset is not updated twice.
{
  const h = makeCtx({ currentPreset: AUTO })
  apply(h.ctx, {})
  h.emit({ id: 's4', header: { isSeeded: false } })
  check('already-configured session is not re-set', h.sets.length === 0)
}

// 5. Without the target preset the plugin must do nothing (and not throw).
{
  const h = makeCtx({ available: ['workspace-write', 'danger-full-access'] })
  apply(h.ctx, {})
  h.emit({ id: 's5', header: { isSeeded: false } })
  check('unavailable preset: nothing set', h.sets.length === 0)
  check('unavailable preset: no warnings', h.warns.length === 0)
}

// 6. A failing set() is reported, never thrown.
{
  const h = makeCtx({ throwOnSet: true })
  apply(h.ctx, {})
  let threw = false
  try {
    h.emit({ id: 's6', header: { isSeeded: false } })
  } catch {
    threw = true
  }
  check('set() failure does not escape the listener', !threw)
  check('set() failure is logged as a warning', h.warns.some((line) => line.includes('s6')))
}

// 7. Opt-out switches from the row config.
{
  const h = makeCtx()
  apply(h.ctx, { skipSeeded: false })
  h.emit({ id: 's7', header: { isSeeded: true } })
  check('skipSeeded:false also converts seeded sessions', h.sets.join() === 's7:auto')
}

// 8. A preset pinned in cordis.patch.yml wins and cannot be changed from the panel.
{
  const h = makeCtx({ currentPreset: AUTO })
  apply(h.ctx, { preset: 'workspace-write' })
  h.emit({ id: 's8', header: { isSeeded: false } })
  check('pinned preset is applied', h.sets.join() === 's8:workspace-write')

  const state = routeFor(h.routes, '/dsh-default-preset/state')
  const read = makeRes()
  await state.handler(makeReq('GET', '/dsh-default-preset/state'), read.res)
  const snapshot = JSON.parse(read.body)
  check('state reports the pinned key', Array.isArray(snapshot.pinned) && snapshot.pinned.includes('preset'))
  check('state lists the selectable presets', snapshot.presets.length >= 2)
  check('state counts applied sessions', snapshot.appliedCount === 1)

  const write = routeFor(h.routes, '/dsh-default-preset/preset')
  const blocked = makeRes()
  await write.handler(
    makeReq('POST', '/dsh-default-preset/preset', JSON.stringify({ preset: 'danger-full-access' })),
    blocked.res
  )
  check('pinned preset refuses the write', blocked.status === 409)
}

// 9. The panel can change the preset when nothing is pinned.
{
  const h = makeCtx()
  apply(h.ctx, {})
  const write = routeFor(h.routes, '/dsh-default-preset/preset')
  const blocked = makeRes()
  await write.handler(
    makeReq('POST', '/dsh-default-preset/preset', JSON.stringify({ preset: 'danger-full-access' })),
    blocked.res
  )
  check('valid preset write answers 200', blocked.status === 200)
  const payload = JSON.parse(blocked.body)
  check('write returns the new settings', payload.ok === true && payload.state.settings.preset === 'danger-full-access')

  const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check('write persists to the settings file', stored.preset === 'danger-full-access')

  h.emit({ id: 's9', header: { isSeeded: false } })
  check('next session uses the saved preset', h.sets.join() === 's9:danger-full-access')
}

// 10. Unknown presets and malformed bodies are refused.
{
  const h = makeCtx()
  apply(h.ctx, {})
  const write = routeFor(h.routes, '/dsh-default-preset/preset')

  const unknown = makeRes()
  await write.handler(
    makeReq('POST', '/dsh-default-preset/preset', JSON.stringify({ preset: 'not-a-preset' })),
    unknown.res
  )
  check('unknown preset answers 400', unknown.status === 400)

  const malformed = makeRes()
  await write.handler(makeReq('POST', '/dsh-default-preset/preset', '{not json'), malformed.res)
  check('malformed body answers 400', malformed.status === 400)

  const getOnly = makeRes()
  await write.handler(makeReq('GET', '/dsh-default-preset/preset'), getOnly.res)
  check('GET on the write route answers 405', getOnly.status === 405)
}

// 11. Plugin metadata matches the bundle patch id.
check('plugin name is stable', name === 'default-auto-review')
check('plugin injects required services', inject.includes('permissionPresets') && inject.includes('sessions'))

const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
fs.rmSync(tmpDir, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)

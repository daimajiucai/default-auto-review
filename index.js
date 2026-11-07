/**
 * Start every genuinely new DSH session in a chosen permission mode, and let
 * the user pick which mode that is from the Harness UI.
 *
 * Why a plugin: `permission.defaultPreset` only accepts names declared in the
 * `presets` table, and `auto` is deliberately reserved for the Auto review
 * integration, so no built-in setting can express "new sessions start in Auto".
 *
 * How it works: permission-presets pins the configured default preset inside
 * its own `session/created` listener; that listener is registered when the
 * service initializes, which happens before this plugin loads. Listeners run in
 * registration order, so this one runs afterwards and can overwrite the value
 * pinned a moment earlier.
 *
 * Where the choice lives: `~/.dsh/dsh-default-preset.json`, written by the
 * panel through the same-origin route below. A value set in the row's
 * cordis.patch.yml `config` is treated as a fixed override and wins, so a
 * profile patch stays authoritative.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = 'default-auto-review'

/** Services required before the switch can be attempted. */
export const inject = ['permissionPresets', 'sessions']

/** The reserved preset name owned by the Auto review integration. */
const AUTO = 'auto'

const SETTINGS_FILE = process.env.DSH_DEFAULT_PRESET_FILE
  || path.join(os.homedir(), '.dsh', 'dsh-default-preset.json')
const STATE_PATH = '/dsh-default-preset/state'
const SAVE_PATH = '/dsh-default-preset/preset'
/** A request body carries three short scalars; anything larger is a mistake. */
const MAX_BODY_BYTES = 2048

/** @typedef {{ preset: string, skipSeeded: boolean, skipSubagents: boolean }} Settings */

/** @type {Settings} */
const DEFAULTS = { preset: AUTO, skipSeeded: true, skipSubagents: true }

/** @returns {Settings} */
function readSettingsFile() {
  try {
    const text = fs.readFileSync(SETTINGS_FILE, 'utf8')
    const json = JSON.parse(text)
    return {
      preset: typeof json.preset === 'string' && json.preset.trim() !== '' ? json.preset.trim() : DEFAULTS.preset,
      skipSeeded: typeof json.skipSeeded === 'boolean' ? json.skipSeeded : DEFAULTS.skipSeeded,
      skipSubagents: typeof json.skipSubagents === 'boolean' ? json.skipSubagents : DEFAULTS.skipSubagents
    }
  } catch (_error) {
    return { ...DEFAULTS }
  }
}

/** @param {Settings} value */
function writeSettingsFile(value) {
  const dir = path.dirname(SETTINGS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/**
 * Every currently selectable preset, read from the live permission catalog.
 * @param {any} ctx
 */
function listPresets(ctx) {
  try {
    const catalog = ctx.permissionPresets.catalog()
    const options = Array.isArray(catalog?.options) ? catalog.options : []
    return {
      options: options.map((option) => ({
        value: String(option.value),
        name: typeof option.name === 'string' ? option.name : String(option.value),
        description: typeof option.description === 'string' ? option.description : ''
      })),
      defaultPreset: typeof catalog?.defaultPreset === 'string' ? catalog.defaultPreset : ''
    }
  } catch (error) {
    return {
      options: [],
      defaultPreset: '',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * `optionOf` throws for a name that is neither configured nor the live Auto
 * preset, which is exactly the check needed before switching a session.
 * @param {any} ctx
 * @param {string} preset
 */
function isSelectable(ctx, preset) {
  if (!preset || preset === 'custom') return false
  try {
    ctx.permissionPresets.optionOf(preset)
    return true
  } catch (_error) {
    return false
  }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} value */
function sendJson(res, status, value) {
  try {
    if (res.headersSent || res.writableEnded) return
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body)
    })
    res.end(body)
  } catch {
    // A closed panel is not an error worth propagating.
  }
}

/** @param {import('node:http').IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve) => {
    let text = ''
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        req.destroy()
        resolve('')
        return
      }
      text += chunk
    })
    req.on('end', () => resolve(text))
    req.on('error', () => resolve(''))
  })
}

/**
 * @param {any} ctx cordis context
 * @param {{ preset?: string, skipSeeded?: boolean, skipSubagents?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  /** Values the row's patch pins; the panel refuses to override them. */
  /** @type {Partial<Settings>} */
  const pinned = {}
  if (typeof config.preset === 'string' && config.preset.trim() !== '') pinned.preset = config.preset.trim()
  if (typeof config.skipSeeded === 'boolean') pinned.skipSeeded = config.skipSeeded
  if (typeof config.skipSubagents === 'boolean') pinned.skipSubagents = config.skipSubagents

  /** @type {Settings} */
  const settings = { ...DEFAULTS, ...readSettingsFile(), ...pinned }

  /** Sessions this plugin switched since the Host started. */
  let appliedCount = 0
  /** @type {{ id: string, preset: string, at: number }[]} */
  const recent = []

  ctx.effect(() => ctx.on('session/created', (session) => {
    try {
      // The chosen preset only exists while its integration is live. Without
      // it, `optionOf` would throw and abort session creation.
      if (!isSelectable(ctx, settings.preset)) return

      const header = session.header ?? {}
      if (settings.skipSeeded && header.isSeeded === true) return
      if (settings.skipSubagents && header.parentSession !== undefined) return

      if (ctx.permissionPresets.current(session) === settings.preset) return
      ctx.permissionPresets.set(session, settings.preset)

      appliedCount += 1
      recent.unshift({ id: String(session.id), preset: settings.preset, at: Date.now() })
      if (recent.length > 10) recent.length = 10

      ctx.logger?.info?.(`default-auto-review: session ${session.id} opened in ${settings.preset}`)
    } catch (error) {
      // Never fail session creation because of this plugin.
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`default-auto-review: could not switch session ${session.id} to ${settings.preset}: ${message}`)
    }
  }), 'default-auto-review')

  // The panel needs a browser carrier; a Host-only composition simply skips it.
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.webServer
      if (!server || typeof server.register !== 'function') return
      /** @returns {any} */
      const state = () => {
        const catalog = listPresets(ctx)
        return {
          ok: true,
          now: Date.now(),
          settings: { ...settings },
          pinned: Object.keys(pinned),
          presets: catalog.options,
          defaultPreset: catalog.defaultPreset,
          catalogError: catalog.error || '',
          appliedCount,
          recent: recent.slice(0, 10)
        }
      }

      webCtx.effect?.(() => server.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          }
          sendJson(res, 200, state())
        }
      }), 'dsh-default-preset-state')

      webCtx.effect?.(() => server.register({
        kind: 'exact',
        path: SAVE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          }
          let patch
          try {
            patch = JSON.parse((await readBody(req)) || '{}')
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
          }

          const next = { ...settings }
          if (patch.preset !== undefined) {
            if (typeof patch.preset !== 'string' || patch.preset.trim() === '') {
              return sendJson(res, 400, { ok: false, error: 'preset must be a non-empty string' })
            }
            if (!isSelectable(ctx, patch.preset.trim())) {
              return sendJson(res, 400, { ok: false, error: `unknown or unavailable preset: ${patch.preset}` })
            }
            next.preset = patch.preset.trim()
          }
          if (patch.skipSeeded !== undefined) {
            if (typeof patch.skipSeeded !== 'boolean') {
              return sendJson(res, 400, { ok: false, error: 'skipSeeded must be a boolean' })
            }
            next.skipSeeded = patch.skipSeeded
          }
          if (patch.skipSubagents !== undefined) {
            if (typeof patch.skipSubagents !== 'boolean') {
              return sendJson(res, 400, { ok: false, error: 'skipSubagents must be a boolean' })
            }
            next.skipSubagents = patch.skipSubagents
          }

          const blocked = Object.keys(pinned).filter((key) => patch[key] !== undefined)
          if (blocked.length > 0) {
            return sendJson(res, 409, {
              ok: false,
              error: `cordis.patch.yml 固定了 ${blocked.join(', ')}，请在那里的 config 中修改`,
              state: state()
            })
          }

          try {
            writeSettingsFile(next)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return sendJson(res, 500, { ok: false, error: `cannot write ${SETTINGS_FILE}: ${message}` })
          }

          settings.preset = next.preset
          settings.skipSeeded = next.skipSeeded
          settings.skipSubagents = next.skipSubagents
          return sendJson(res, 200, { ok: true, state: state() })
        }
      }), 'dsh-default-preset-save')
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`default-auto-review: panel route unavailable: ${message}`)
  }
}

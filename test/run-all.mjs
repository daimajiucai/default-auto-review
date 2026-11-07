#!/usr/bin/env node
/**
 * Run every test file of this plugin in order.
 *
 * `plugin-unit.mjs` covers the Host half (session switching, the settings file,
 * the two same-origin routes); `client-unit.mjs` renders the browser half with
 * a miniature React and checks the slot it registers into and the bilingual
 * mode labels. Both run as separate processes so a failure in one does not hide
 * the other.
 *
 * Run: node test/run-all.mjs
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILES = ['plugin-unit.mjs', 'client-unit.mjs'].map((name) => path.join(HERE, name))

let failed = false
for (const file of FILES) {
  console.log(`\n--- ${path.basename(file)} ---`)
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  if (result.status !== 0) failed = true
}

console.log(`\n${'-'.repeat(48)}`)
if (failed) {
  console.error('client or host tests failed')
  process.exitCode = 1
} else {
  console.log('all plugin tests passed')
}

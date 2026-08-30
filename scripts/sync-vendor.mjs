// Copies the 8th Wall runtime out of node_modules into public/external/.
//
// These libraries are script-tag globals (window.XR8 / XRExtras / CoachingOverlay /
// LandingPage), not ES modules, so they cannot go through the Vite graph. public/ is
// copied verbatim into dist/, which also satisfies the engine's licence: the XR Engine
// License Agreement forbids modifying, re-minifying or re-bundling the binary, and the
// copyright header carried at the top of xr.js is what makes redistribution compliant.
//
// Nothing here is committed (see .gitignore) - install/CI re-fetches from npm, which
// keeps the binary on its original distribution path.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = path.join(root, 'public', 'external')

// The engine tarball is ~30 MB, but world tracking only ever loads xr.js + xr-slam.js.
// The face-tracking and semantics payloads are dead weight for this project, and the
// deployed artifact is served from our own origin, so they are dropped by default.
// FULL_ENGINE=1 restores the complete dist if a future feature needs face/semantics.
const ENGINE_WORLD_TRACKING_ONLY = [
  'xr.js',
  'xr-slam.js',
  'LICENSE',
  'resources/powered-by.svg',
]

const packages = [
  {
    name: '@8thwall/engine-binary',
    to: 'xr',
    only: process.env.FULL_ENGINE === '1' ? null : ENGINE_WORLD_TRACKING_ONLY,
  },
  {name: '@8thwall/xrextras', to: 'xrextras'},
  {name: '@8thwall/coaching-overlay', to: 'coaching-overlay'},
  {name: '@8thwall/landing-page', to: 'landing-page'},
]

const copyDir = (from, to) => {
  fs.mkdirSync(to, {recursive: true})
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    entry.isDirectory() ? copyDir(src, dst) : fs.copyFileSync(src, dst)
  }
}

const dirSize = (dir) => fs.readdirSync(dir, {withFileTypes: true}).reduce(
  (n, e) => n + (e.isDirectory()
    ? dirSize(path.join(dir, e.name))
    : fs.statSync(path.join(dir, e.name)).size),
  0)

let total = 0
for (const pkg of packages) {
  const dist = path.join(root, 'node_modules', pkg.name, 'dist')
  if (!fs.existsSync(dist)) {
    console.error(`[sync-vendor] missing ${pkg.name}. run: npm install`)
    process.exit(1)
  }
  const out = path.join(outRoot, pkg.to)
  fs.rmSync(out, {recursive: true, force: true})

  if (pkg.only) {
    for (const rel of pkg.only) {
      const src = path.join(dist, rel)
      if (!fs.existsSync(src)) {
        console.error(`[sync-vendor] ${pkg.name} has no ${rel} - engine layout changed?`)
        process.exit(1)
      }
      const dst = path.join(out, rel)
      fs.mkdirSync(path.dirname(dst), {recursive: true})
      fs.copyFileSync(src, dst)
    }
  } else {
    copyDir(dist, out)
  }

  const size = dirSize(out)
  total += size
  console.log(`[sync-vendor] ${pkg.name} -> public/external/${pkg.to} (${(size / 1e6).toFixed(1)} MB)`)
}
console.log(`[sync-vendor] total ${(total / 1e6).toFixed(1)} MB`)

// Measures whether the usual "Draco + KTX2" advice is actually worth it for this
// asset, by building every combination and adding the runtime decoder each one
// forces the page to download.
//
// The point of comparison is total first-load bytes over the wire (Pages serves
// gzip), not the size of the .glb on its own.
import {Document, NodeIO} from '@gltf-transform/core'
import {KHRMaterialsUnlit, KHRTextureBasisu, KHRDracoMeshCompression} from '@gltf-transform/extensions'
import {draco} from '@gltf-transform/functions'
import draco3d from 'draco3d'
import {execFileSync} from 'node:child_process'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

// KTX-Software is not an npm package. Point KTX_HOME at an extracted release
// (https://github.com/KhronosGroup/KTX-Software/releases) to regenerate the KTX2
// variant; without it the comparison still runs, minus the KTX2 rows.
const KTX_HOME = process.env.KTX_HOME || path.join(process.env.HOME || '', 'tools/KTX-Software-4.4.2-Linux-x86_64')
const HAS_KTX = fs.existsSync(path.join(KTX_HOME, 'bin/ktx'))
const ktx = (args) => execFileSync(path.join(KTX_HOME, 'bin/ktx'), args,
  {env: {...process.env, LD_LIBRARY_PATH: path.join(KTX_HOME, 'lib')}, stdio: 'pipe'})

const A = 'src/assets'
const io = new NodeIO()
  .registerExtensions([KHRMaterialsUnlit, KHRTextureBasisu, KHRDracoMeshCompression])
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  })

// ---- KTX2 / ETC1S -----------------------------------------------------------
// ETC1S (not UASTC): UASTC would hold the blade edges better but lands around
// 4x the bytes, and the atlas is only ever seen at a small on-screen size.
fs.mkdirSync('build', {recursive: true})
if (!HAS_KTX) console.log(`(KTX encoder not found at ${KTX_HOME}; reusing the committed grass-atlas.ktx2)\n`)
else ktx(['create', '--format', 'R8G8B8A8_SRGB', '--encode', 'basis-lz',
  '--clevel', '4', '--qlevel', '190', '--generate-mipmap',
  `${A}/grass-atlas.png`, `${A}/grass-atlas.ktx2`])

const variants = {}
const build = async (name, fn) => {
  const doc = await io.read(`${A}/grass.glb`)
  await fn(doc)
  const bytes = await io.writeBinary(doc)
  fs.writeFileSync(`build/${name}.glb`, bytes)
  variants[name] = bytes
}

await build('plain', async () => {})
await build('draco', async (doc) => { await doc.transform(draco({method: 'edgebreaker'})) })
await build('ktx2', async (doc) => {
  doc.createExtension(KHRTextureBasisu).setRequired(true)
  doc.getRoot().listTextures()[0]
    .setImage(fs.readFileSync(`${A}/grass-atlas.ktx2`)).setMimeType('image/ktx2')
})
await build('draco+ktx2', async (doc) => {
  doc.createExtension(KHRTextureBasisu).setRequired(true)
  doc.getRoot().listTextures()[0]
    .setImage(fs.readFileSync(`${A}/grass-atlas.ktx2`)).setMimeType('image/ktx2')
  await doc.transform(draco({method: 'edgebreaker'}))
})

// Geometry with no embedded texture: what the "procedural geometry, no glTF at
// all" path competes against.
await build('geometry-only', async (doc) => {
  doc.getRoot().listMaterials()[0].setBaseColorTexture(null)
  doc.getRoot().listTextures().forEach(t => t.dispose())
})

const gz = (b) => zlib.gzipSync(b, {level: 9}).length
const br = (b) => zlib.brotliCompressSync(b).length
const L = 'node_modules/three/examples/jsm/libs'
const rd = (f) => fs.readFileSync(f)

// Runtime cost each path forces on top of the asset itself.
const DECODERS = {
  'plain':         [],
  'draco':         [`${L}/draco/gltf/draco_decoder.wasm`, `${L}/draco/gltf/draco_wasm_wrapper.js`],
  'ktx2':          [`${L}/basis/basis_transcoder.wasm`, `${L}/basis/basis_transcoder.js`],
  'draco+ktx2':    [`${L}/draco/gltf/draco_decoder.wasm`, `${L}/draco/gltf/draco_wasm_wrapper.js`,
                    `${L}/basis/basis_transcoder.wasm`, `${L}/basis/basis_transcoder.js`],
  'geometry-only': [],
}

const rows = []
for (const [name, bytes] of Object.entries(variants)) {
  const dec = DECODERS[name].map(rd)
  const decGz = dec.reduce((a, b) => a + gz(b), 0)
  rows.push({
    path: name,
    glb: bytes.length,
    glbGz: gz(bytes),
    decoderGz: decGz,
    totalGz: gz(bytes) + decGz,
  })
}

// The lean alternative: no glTF, no loaders. Geometry is generated in JS from the
// same trimmed-card data (a few hundred bytes of numbers), texture stays a PNG.
const pngGz = gz(rd(`${A}/grass-atlas.png`))   // PNG is already deflate; gzip is a no-op
rows.push({path: 'procedural + PNG', glb: 0, glbGz: 0, decoderGz: 0, totalGz: pngGz + 900})

const fmt = (n) => (n / 1024).toFixed(1) + ' KB'
console.log('\npath              |    .glb |  .glb gz | decoder gz |  total gz')
console.log('-'.repeat(66))
for (const r of rows) {
  console.log(`${r.path.padEnd(17)} | ${fmt(r.glb).padStart(7)} | ${fmt(r.glbGz).padStart(8)} | ` +
    `${fmt(r.decoderGz).padStart(10)} | ${fmt(r.totalGz).padStart(9)}`)
}

console.log('\nsource textures')
for (const f of ['grass-atlas.png', 'grass-atlas.ktx2', 'shadow.png']) {
  const b = rd(`${A}/${f}`)
  console.log(`  ${f.padEnd(18)} ${fmt(b.length).padStart(8)} raw   ${fmt(gz(b)).padStart(8)} gz`)
}

// GPU-side memory, which is where KTX2 actually pays off.
const px = 512 * 512 * 4 / 3   // 4/3 for the mip chain
console.log('\nGPU memory for the atlas (512x512 + mips)')
console.log(`  PNG  -> RGBA8      ${fmt(px * 4 / (4 / 3) * (4 / 3)).padStart(8)}`)
console.log(`  KTX2 -> ASTC 4x4   ${fmt(512 * 512 * 1 * (4 / 3)).padStart(8)}  (transcoded on device)`)

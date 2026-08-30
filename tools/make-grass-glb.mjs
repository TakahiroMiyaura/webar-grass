// Builds src/assets/grass.glb: one tuft, made of three trimmed cards crossed
// around Y so the tuft never disappears when you walk around it.
//
// There is deliberately ONE mesh, not four. The four visual variants live in the
// atlas and are picked per instance in the vertex shader, which keeps the whole
// grass field on a single InstancedMesh and therefore a single draw call.
import {Document, NodeIO} from '@gltf-transform/core'
import {KHRMaterialsUnlit} from '@gltf-transform/extensions'
import fs from 'node:fs'
import path from 'node:path'
import {readAlpha, columnExtents, unionExtents, pad, coverage, CELLS, CELL, INSET} from './fit-card.mjs'

const COLS = 8            // 53% of the quad rasterised, vs 100% for a full card
const CARDS = 3           // 0deg / 60deg / 120deg
const ATLAS = CELL * 2    // 512
const USABLE = CELL - INSET * 2

const alpha = await readAlpha('src/assets/grass-atlas.png')
const ext = pad(unionExtents(CELLS.map(c => columnExtents(alpha, c, COLS))), COLS, 1.5 / USABLE)
const cov = coverage(ext, COLS)

const pos = [], uv = [], nrm = [], idx = []
for (let card = 0; card < CARDS; card++) {
  const a = (card / CARDS) * Math.PI
  const ca = Math.cos(a), sa = Math.sin(a)
  for (let c = 0; c < COLS; c++) {
    const e = ext[c]
    if (!e) continue
    const u0 = c / COLS, u1 = (c + 1) / COLS
    const corners = [
      [u0, e.yBot], [u1, e.yBot], [u1, e.yTop], [u0, e.yTop],
    ]
    const base = pos.length / 3
    for (const [u, y] of corners) {
      const x = u - 0.5
      pos.push(x * ca, y, x * sa)
      // Normals point straight up on every vertex. Grass cards shaded with their
      // real facing normals flicker between light and dark as the user orbits
      // them; an up normal makes a tuft read like a small piece of canopy. The
      // runtime material is unlit anyway, so this only matters if someone swaps
      // in a lit material later.
      nrm.push(0, 1, 0)
      // glTF UV origin is top-left. The geometry is authored against the inset
      // region of atlas cell (0,0); the vertex shader adds (col,row)*0.5 to reach
      // the other three cells. Staying inside the gutter is what stops mip
      // filtering from pulling in a neighbouring tuft.
      uv.push((INSET + u * USABLE) / ATLAS, (INSET + (1 - y) * USABLE) / ATLAS)
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
}

const doc = new Document()
const unlit = doc.createExtension(KHRMaterialsUnlit)
const buf = doc.createBuffer()

const acc = (name, arr, type, Ctor) =>
  doc.createAccessor(name).setType(type).setArray(new Ctor(arr)).setBuffer(buf)

const tex = doc.createTexture('grassAtlas')
  .setImage(fs.readFileSync('src/assets/grass-atlas.png'))
  .setMimeType('image/png')

const mat = doc.createMaterial('grass')
  .setBaseColorTexture(tex)
  .setAlphaMode('MASK')
  // Below the nominal 0.5: mip levels thin an alpha-tested silhouette out, and a
  // lower cutoff keeps the blade tips from dissolving at distance.
  .setAlphaCutoff(0.35)
  .setDoubleSided(true)
  .setRoughnessFactor(1)
  .setMetallicFactor(0)
  .setExtension('KHR_materials_unlit', unlit.createUnlit())

const prim = doc.createPrimitive()
  .setAttribute('POSITION', acc('POSITION', pos, 'VEC3', Float32Array))
  .setAttribute('NORMAL', acc('NORMAL', nrm, 'VEC3', Float32Array))
  .setAttribute('TEXCOORD_0', acc('TEXCOORD_0', uv, 'VEC2', Float32Array))
  .setIndices(acc('indices', idx, 'SCALAR', Uint16Array))
  .setMaterial(mat)

const mesh = doc.createMesh('tuft').addPrimitive(prim)
doc.createScene('grass').addChild(doc.createNode('tuft').setMesh(mesh))

const out = path.resolve('src/assets/grass.glb')
await new NodeIO().registerExtensions([KHRMaterialsUnlit]).write(out, doc)

console.log(`grass.glb          ${fs.statSync(out).size} B`)
console.log(`  cards            ${CARDS}`)
console.log(`  vertices         ${pos.length / 3}`)
console.log(`  triangles        ${idx.length / 3}`)
console.log(`  rasterised area  ${(cov * 100).toFixed(1)}% of a full card (${(100 - cov * 100).toFixed(1)}% of fill saved)`)

// Emitted for the runtime's no-glTF fallback path, which rebuilds the same
// geometry from these numbers without pulling in GLTFLoader.
fs.writeFileSync('src/assets/tuft-card.json', JSON.stringify({
  cols: COLS, cards: CARDS, inset: INSET, cell: CELL,
  ext: ext.map(e => e && [+e.yBot.toFixed(5), +e.yTop.toFixed(5)]),
}))

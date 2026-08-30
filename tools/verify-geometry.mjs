// Confirms the two load paths really do produce the same tuft, so that choosing
// createProcedural() over create() is purely a bytes decision and never a visual one.
import {NodeIO} from '@gltf-transform/core'
import {KHRMaterialsUnlit} from '@gltf-transform/extensions'
import fs from 'node:fs'
// Node 22 strips the types; tuft-geometry.ts deliberately depends on nothing but
// three so this import resolves outside the Vite graph.
import {buildTuftGeometry} from '../src/xr/tuft-geometry.ts'

const doc = await new NodeIO().registerExtensions([KHRMaterialsUnlit]).read('src/assets/grass.glb')
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0]
const glb = {
  position: prim.getAttribute('POSITION').getArray(),
  uv: prim.getAttribute('TEXCOORD_0').getArray(),
  index: prim.getIndices().getArray(),
}

const geo = buildTuftGeometry(JSON.parse(fs.readFileSync('src/assets/tuft-card.json', 'utf8')))
const proc = {
  position: geo.getAttribute('position').array,
  uv: geo.getAttribute('uv').array,
  index: geo.getIndex().array,
}

let worst = 0, bad = []
for (const k of ['position', 'uv', 'index']) {
  if (glb[k].length !== proc[k].length) { bad.push(`${k}: length ${glb[k].length} vs ${proc[k].length}`); continue }
  for (let i = 0; i < glb[k].length; i++) worst = Math.max(worst, Math.abs(glb[k][i] - proc[k][i]))
}
console.log(`vertices ${glb.position.length / 3}, triangles ${glb.index.length / 3}`)
console.log(bad.length ? 'MISMATCH: ' + bad.join('; ')
  : `GLB and procedural geometry agree (max component difference ${worst.toExponential(1)})`)
process.exit(bad.length || worst > 1e-5 ? 1 : 0)

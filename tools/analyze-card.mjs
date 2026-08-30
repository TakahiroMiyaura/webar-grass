import {readAlpha, columnExtents, unionExtents, pad, coverage, CELLS} from './fit-card.mjs'

const alpha = await readAlpha('src/assets/grass-atlas.png')
const opaque = alpha.data.reduce((a, v) => a + (v > 8 ? 1 : 0), 0) / alpha.data.length

console.log(`atlas opaque texels: ${(opaque * 100).toFixed(1)}%\n`)
console.log('cols | union card | per-cell avg | tris/card (union)')
for (const cols of [1, 2, 4, 6, 8, 12, 16]) {
  const per = CELLS.map(c => pad(columnExtents(alpha, c, cols), cols, 1.5 / 256))
  const uni = pad(unionExtents(CELLS.map(c => columnExtents(alpha, c, cols))), cols, 1.5 / 256)
  const perAvg = per.reduce((a, e) => a + coverage(e, cols), 0) / per.length
  const tris = uni.filter(Boolean).length * 2
  console.log(`${String(cols).padStart(4)} | ${(coverage(uni, cols) * 100).toFixed(1).padStart(9)}% | ` +
    `${(perAvg * 100).toFixed(1).padStart(11)}% | ${String(tris).padStart(4)}`)
}

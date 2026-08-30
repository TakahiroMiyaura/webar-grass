// The tuft card geometry, kept apart from grass.ts so it has no dependency beyond three.
//
// That matters for one reason: tools/verify-geometry.mjs imports this file directly in
// Node to check it against the committed grass.glb. grass.ts pulls in image and ?url
// asset imports that only Vite can resolve, so the check could not reach the builder if
// it lived there.
import * as THREE from 'three'

export interface TuftCard {
  cols: number
  cards: number
  inset: number
  cell: number
  /** Per-column [yBottom, yTop] in 0..1 card space; null where the column is empty. */
  ext: ([number, number] | null)[]
}

/**
 * Rebuilds the trimmed card from the column extents tools/make-grass-glb.mjs derived
 * from the atlas alpha. Mirrors that script exactly; tools/verify-geometry.mjs asserts
 * the two agree.
 *
 * The card is trimmed to the blade silhouette rather than left as a quad because
 * alpha-tested foliage cannot use early-Z on a tile-based mobile GPU: discarded texels
 * still cost a fragment shader run, and the atlas is only ~16% opaque. Trading 2
 * triangles per card for 12 removes ~47% of the rasterised area, which is the right side
 * of that deal when fill is the budget.
 */
export const buildTuftGeometry = ({cols, cards, inset, cell, ext}: TuftCard): THREE.BufferGeometry => {
  const atlas = cell * 2
  const usable = cell - inset * 2
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [], idx: number[] = []

  for (let c = 0; c < cards; c++) {
    const a = (c / cards) * Math.PI
    const ca = Math.cos(a), sa = Math.sin(a)
    for (let i = 0; i < cols; i++) {
      const column = ext[i]
      if (!column) continue
      const [yBot, yTop] = column
      const u0 = i / cols, u1 = (i + 1) / cols
      const base = pos.length / 3
      const corners: [number, number][] = [[u0, yBot], [u1, yBot], [u1, yTop], [u0, yTop]]
      for (const [u, y] of corners) {
        const x = u - 0.5
        pos.push(x * ca, y, x * sa)
        // Normals point straight up on every vertex. Cards shaded with their real facing
        // normals flicker between light and dark as the user orbits them; an up normal
        // makes a tuft read like a small piece of canopy. The material is unlit anyway,
        // so this only matters if someone swaps in a lit one later.
        nrm.push(0, 1, 0)
        // glTF UV convention: v = 0 at the top of the image. Staying inside the atlas
        // gutter is what stops mip filtering from pulling in a neighbouring tuft.
        uv.push((inset + u * usable) / atlas, (inset + (1 - y) * usable) / atlas)
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

// Turns the atlas alpha channel into a "trimmed card": instead of one full quad
// per grass card, the blades are covered by a handful of vertical strips that
// skip the empty corners.
//
// Why bother: on a tile-based mobile GPU an alpha-tested draw cannot use early-Z
// rejection, so every texel of the card costs a fragment shader run even where
// it is discarded. The atlas is only ~15% opaque, so a full quad spends most of
// its fill budget on discards. Trading a few extra triangles (vertices are cheap,
// fill is not) for a much smaller rasterised area is the right side of that deal.
import sharp from 'sharp'

export const readAlpha = async (file) => {
  const img = sharp(file)
  const {width, height} = await img.metadata()
  const data = await img.ensureAlpha().extractChannel('alpha').raw().toBuffer()
  return {data, width, height}
}

// Per-column [top, bottom] extent of any texel above `thr`, in 0..1 cell space
// with y=0 at the bottom of the cell (i.e. the base of the grass).
export const columnExtents = (alpha, cell, cols, thr = 8) => {
  const {data, width} = alpha
  const {x0, y0, size} = cell
  const out = []
  for (let c = 0; c < cols; c++) {
    const px0 = x0 + Math.floor((c / cols) * size)
    const px1 = x0 + Math.ceil(((c + 1) / cols) * size)
    let top = -1, bot = -1
    for (let py = y0; py < y0 + size; py++) {
      let hit = false
      for (let px = px0; px < px1; px++) {
        if (data[py * width + px] > thr) { hit = true; break }
      }
      if (hit) { if (top < 0) top = py; bot = py }
    }
    if (top < 0) { out.push(null); continue }
    // y measured from the bottom of the cell, upward.
    out.push({
      yTop: (y0 + size - top) / size,
      yBot: (y0 + size - bot - 1) / size,
    })
  }
  return out
}

// Union of several cells' extents, so one geometry can serve every atlas cell.
export const unionExtents = (list) => list[0].map((_, i) => {
  const present = list.map(e => e[i]).filter(Boolean)
  if (!present.length) return null
  return {
    yTop: Math.max(...present.map(e => e.yTop)),
    yBot: Math.min(...present.map(e => e.yBot)),
  }
})

export const pad = (ext, cols, padding) => ext.map(e => e && ({
  yTop: Math.min(1, e.yTop + padding),
  yBot: Math.max(0, e.yBot - padding),
}))

// Fraction of the full quad that the strips actually rasterise.
export const coverage = (ext, cols) =>
  ext.reduce((a, e) => a + (e ? (e.yTop - e.yBot) / cols : 0), 0)

export const INSET = 8
export const CELL = 256
// Cells are the inset region only: the gutter exists so mip filtering has
// somewhere empty to bleed into, and must not be covered by geometry.
export const CELLS = [
  {x0: 8, y0: 8, size: 240},
  {x0: 264, y0: 8, size: 240},
  {x0: 8, y0: 264, size: 240},
  {x0: 264, y0: 264, size: 240},
]

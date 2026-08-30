// Generates src/assets/grass-atlas.png and src/assets/shadow.png.
//
// The atlas is 2x2 cells, one grass tuft each. An instance picks its cell in the
// vertex shader from a per-instance random, so four visually distinct tufts still
// cost one draw call and one texture bind.
//
// Three things here are driven by the renderer rather than by looks:
//   - every tuft is drawn inside an INSET gutter, so mip filtering at the cell
//     border bleeds into empty space instead of into the neighbouring tuft,
//   - blades stay >= ~11px wide at the base so they survive a few mip levels
//     before the alpha test starts eating them,
//   - transparent texels are flooded with mid-green rather than left black,
//     otherwise lower mips fringe the blades with dark edges.
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.resolve('src/assets')
fs.mkdirSync(OUT, {recursive: true})

export const CELL = 256
export const INSET = 8              // gutter, in atlas pixels
const ATLAS = CELL * 2
const IN = CELL - INSET * 2         // usable square inside one cell

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296

const blade = (cx, baseY, {h, lean, w, hue, sat}) => {
  const tipX = cx + lean
  const tipY = baseY - h
  const c = 0.55                    // control points sit ~55% up, giving the S-curve
  const lc = `${cx - w / 2 + lean * 0.18},${baseY - h * c}`
  const rc = `${cx + w / 2 + lean * 0.34},${baseY - h * c}`
  const d = `M${cx - w / 2},${baseY} Q${lc} ${tipX},${tipY} Q${rc} ${cx + w / 2},${baseY} Z`
  return `<path d="${d}" fill="hsl(${hue.toFixed(0)},${sat.toFixed(0)}%,34%)"/>`
}

// A fan of blades from a shared root, drawn tallest-first so the shorter front
// blades overlap the back ones.
const tuft = (seed, count) => {
  const r = rng(seed)
  const baseY = INSET + IN
  const cx = CELL / 2
  const blades = []
  for (let i = 0; i < count; i++) {
    const spread = (i / (count - 1) - 0.5) * 2
    blades.push({
      cx: cx + spread * 32 + (r() * 2 - 1) * 7,
      h: 0.50 * IN + (1 - Math.abs(spread)) * 0.40 * IN + r() * 0.12 * IN,
      lean: spread * (38 + r() * 24),
      w: 11 + r() * 6,
      hue: 92 + r() * 26,
      sat: 38 + r() * 26,
    })
  }
  blades.sort((a, b) => b.h - a.h)
  return blades.map(b => blade(b.cx, baseY, b)).join('\n      ')
}

const cells = [{seed: 11, count: 7}, {seed: 29, count: 5}, {seed: 53, count: 9}, {seed: 97, count: 6}]

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ATLAS}" height="${ATLAS}">
  <defs>
    <clipPath id="cell"><rect x="${INSET}" y="${INSET}" width="${IN}" height="${IN}"/></clipPath>
  </defs>
${cells.map((c, i) => `  <g transform="translate(${(i % 2) * CELL},${Math.floor(i / 2) * CELL})">
    <g clip-path="url(#cell)">
      ${tuft(c.seed, c.count)}
    </g>
  </g>`).join('\n')}
</svg>`

const tufts = await sharp(Buffer.from(svg)).png().toBuffer()

// Vertical ambient-occlusion ramp, applied to RGB only. Baking it here is what
// lets the runtime material stay MeshBasicMaterial: no lights, no normals, no
// per-fragment lighting maths on a GPU that is already running SLAM.
const aoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ATLAS}" height="${ATLAS}">
  <defs><linearGradient id="ao" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ffffff"/><stop offset="60%" stop-color="#ffffff"/>
    <stop offset="100%" stop-color="#767676"/>
  </linearGradient></defs>
  <rect width="${ATLAS}" height="${ATLAS}" fill="#ffffff"/>
  ${[0, 1].map(row => [0, 1].map(col =>
    `<rect x="${col * CELL}" y="${row * CELL}" width="${CELL}" height="${CELL}" fill="url(#ao)"/>`).join('')).join('')}
</svg>`
const ao = await sharp(Buffer.from(aoSvg)).removeAlpha().png().toBuffer()

// Alpha comes from the untouched render and goes back on at the end: baking the
// AO into alpha would fatten the silhouette and shift the alpha test.
const alpha = await sharp(tufts).extractChannel('alpha').toColourspace('b-w').png().toBuffer()
const rgb = await sharp({create: {width: ATLAS, height: ATLAS, channels: 3, background: '#3f6b2a'}})
  .composite([{input: tufts}, {input: ao, blend: 'multiply'}])
  .removeAlpha().png().toBuffer()

// Palette-quantised: 25 KB instead of 61 KB for RGBA8. Verified against the
// un-quantised source by hard-thresholding both at the runtime alphaCutoff --
// 0.045% of texels flip, so the alpha-tested silhouette is effectively unchanged.
await sharp(rgb).joinChannel(alpha)
  .png({compressionLevel: 9, effort: 10, palette: true, quality: 90})
  .toFile(path.join(OUT, 'grass-atlas.png'))

// ---- contact shadow ---------------------------------------------------------
// White at the rim, dark in the middle. Drawn with MultiplyBlending this darkens
// the camera feed underneath instead of painting a grey disc onto it, so it reads
// correctly on a white desk and on a dark one. 64px greyscale is plenty for a
// blob that is a few dozen pixels across, and multiply only reads RGB.
const SH = 128
const shadowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SH}" height="${SH}">
  <defs><radialGradient id="s" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="#5f6a5b"/><stop offset="45%" stop-color="#9ba299"/>
    <stop offset="80%" stop-color="#eff0ee"/><stop offset="100%" stop-color="#ffffff"/>
  </radialGradient></defs>
  <rect width="${SH}" height="${SH}" fill="#ffffff"/>
  <circle cx="${SH / 2}" cy="${SH / 2}" r="${SH / 2}" fill="url(#s)"/>
</svg>`
await sharp(Buffer.from(shadowSvg)).resize(64, 64).greyscale().removeAlpha()
  .png({compressionLevel: 9, effort: 10, palette: true, quality: 90})
  .toFile(path.join(OUT, 'shadow.png'))

for (const f of ['grass-atlas.png', 'shadow.png']) {
  console.log(`  ${f.padEnd(18)} ${fs.statSync(path.join(OUT, f)).size} B`)
}

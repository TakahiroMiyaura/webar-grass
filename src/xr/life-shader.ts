// The instance life-cycle shader chunks, shared by every field in the scene.
//
// Grass (grass.ts) and flowers (flowers.ts) are separate InstancedMeshes with separate
// materials, but they are the same object as far as timing goes: both grow in, both
// shrink out, both disappear past the same distance. Keeping one copy of that curve is
// what stops a flower from popping in on a different beat to the tuft it sits on.
//
// Nothing here animates on the CPU. Everything is a function of (uTime - plantTime), so
// instanceMatrix is written once when the instance is planted and never touched again.

/** Attributes and uniforms every field declares, plus the growth curve. */
export const LIFE_COMMON = /* glsl */`
  attribute vec2 aLife;   // x = plant time, y = retire time (NOT_RETIRING while alive)
  attribute vec3 aRand;   // x = wind phase, y = atlas cell index, z = spare
  uniform float uTime;
  uniform float uGrow;
  uniform float uRetire;
  uniform float uWind;
  uniform float uWindSpeed;
  uniform vec2  uCull;    // x = fade start, y = fully gone
  uniform vec3  uEye;

  // easeOutBack: a small overshoot so an instance visibly pops rather than fading in.
  float growCurve(float t) {
    t = clamp(t, 0.0, 1.0);
    float c = 1.70158, c3 = c + 1.0;
    float p = t - 1.0;
    return 1.0 + c3 * p * p * p + c * p * p;
  }
`

/**
 * Declares `scale` (grow x retire x distance-cull) and `iPos` (the instance origin in
 * world space). Insert after <begin_vertex>; multiply `transformed` by `scale` last, so
 * a culled instance collapses to a degenerate triangle rather than a sliver.
 */
export const LIFE_SCALE_BODY = /* glsl */`
  vec3 iPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  float grow   = growCurve((uTime - aLife.x) / uGrow);
  float retire = 1.0 - smoothstep(0.0, uRetire, uTime - aLife.y);
  // Distance cull. Collapsing the instance to zero produces degenerate triangles, which
  // the rasteriser drops before any fragment work -- the whole point, since fill is what
  // this scene is short of. Vertex cost stays, but that is the cheap side.
  float dist   = distance(iPos, uEye);
  float near   = 1.0 - smoothstep(uCull.x, uCull.y, dist);

  float scale = max(grow, 0.0) * retire * near;
`

/**
 * Offset into one of the four atlas cells, for a 2x2 atlas indexed by aRand.y. The
 * geometry is authored inside the inset region of cell (0,0); the gutter is what keeps
 * mip filtering from sampling the neighbouring cell.
 */
export const ATLAS_CELL_UV = /* glsl */`
  #ifdef USE_MAP
    float cell = floor(aRand.y + 0.5);
    vMapUv += vec2(mod(cell, 2.0), floor(cell * 0.5)) * 0.5;
  #endif
`

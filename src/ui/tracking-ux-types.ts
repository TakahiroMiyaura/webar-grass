// src/ui/tracking-ux.js (MYAA-15) is kept as plain JS on purpose: it is covered as-is by
// scripts/verify-tracking-ux.mjs, and rewriting it in TypeScript would put that
// verification out of step with the code it tests.
//
// Its type is derived from the implementation rather than hand-written, so the two
// cannot drift. This import is type-only and disappears at build time.
import type * as TrackingUxModule from './tracking-ux.js'

export type TrackingUx = ReturnType<typeof TrackingUxModule.createTrackingUx>

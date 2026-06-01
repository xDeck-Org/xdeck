export * from './capability';
export * from './runtime';
export * from './errors';
export * from './manifest';
export * from './ports';
export * from './guard';
export * from './method-mapping';
// §9.50 Phase B Slice 7 — static analyzer.
//
// Also reachable via the `./static-analyzer` subpath (preferred for
// downstream consumers that want to signal the heavier `typescript`
// peer-dep at import time). The bare re-export below is the convenience
// path for the backend wrapper, whose tsconfig moduleResolution is
// classic-`node` and so cannot read the `exports` subpath map. The
// runtime cost is identical regardless — `static-analyzer.js` eagerly
// requires `typescript` at module load, and the backend has needed
// that since the analyzer first shipped.
export * from './static-analyzer';

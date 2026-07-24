// Minimal browser shim for the tiny slice of `process` that the bundled
// `yaml` dependency reads at module-init time (env.LOG_STREAM, emitWarning).
// actwhy runs 100% client-side; there is no real Node process.
export const env = {};
export function emitWarning() {}
export function nextTick(fn) { Promise.resolve().then(fn); }
const process = { env, emitWarning, nextTick };
export default process;

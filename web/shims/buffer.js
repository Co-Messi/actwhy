// Minimal browser shim for `require('buffer')`.
//
// The bundled `yaml` dependency imports `buffer` at module-init time inside its
// yaml-1.1 binary-tag codec, then guards actual use behind
// `typeof node_buffer.Buffer === 'function'` and falls back to atob/btoa.
// Workflow YAML never contains `!!binary` tags, so that codec never runs — we
// only need the top-level import to resolve without throwing. Exporting an
// undefined `Buffer` makes the guard fall through to the browser path.
export const Buffer = undefined;
export default { Buffer: undefined };

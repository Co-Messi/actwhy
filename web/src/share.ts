/**
 * Share links: serialize the full playground state into a base64url payload
 * stored in location.hash, and restore it defensively on load. UTF-8 safe
 * (handles emoji / non-ASCII branch and commit text), and any malformed hash
 * is ignored rather than white-screening the page.
 */
import type { AppState, EventKind, WorkflowTab } from "./engine.js";

const EVENTS: EventKind[] = ["push", "pull_request", "tag"];

/** Compact wire shape — short keys keep shared URLs short. */
interface Wire {
  f: { n: string; c: string }[];
  a: number;
  e: EventKind;
  b: string;
  t: string;
  ch: string;
  m: string;
  pb: string;
  ph: string;
  pa: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode state to a base64url string suitable for location.hash. */
export function encodeState(state: AppState): string {
  const wire: Wire = {
    f: state.files.map((f) => ({ n: f.name, c: f.content })),
    a: state.active,
    e: state.event,
    b: state.branch,
    t: state.tag,
    ch: state.changed,
    m: state.commitMessage,
    pb: state.prBase,
    ph: state.prHead,
    pa: state.prActivity,
  };
  const json = JSON.stringify(wire);
  return toBase64Url(new TextEncoder().encode(json));
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Decode a hash payload back to state, or null if it is missing/malformed. */
export function decodeState(hash: string): AppState | null {
  const raw = hash.replace(/^#/, "").trim();
  if (!raw) return null;
  try {
    const json = new TextDecoder().decode(fromBase64Url(raw));
    const w = JSON.parse(json) as Partial<Wire>;
    if (!w || !Array.isArray(w.f)) return null;

    const files: WorkflowTab[] = [];
    for (const item of w.f) {
      if (!item || typeof item !== "object") return null;
      const rec = item as Record<string, unknown>;
      if (typeof rec.n !== "string" || typeof rec.c !== "string") return null;
      files.push({ name: rec.n, content: rec.c });
    }
    if (files.length === 0) return null;

    const event: EventKind = EVENTS.includes(w.e as EventKind) ? (w.e as EventKind) : "push";
    let active = typeof w.a === "number" && Number.isInteger(w.a) ? w.a : 0;
    if (active < 0 || active >= files.length) active = 0;

    return {
      files,
      active,
      event,
      branch: str(w.b, "main"),
      tag: str(w.t, "v1.0.0"),
      changed: str(w.ch),
      commitMessage: str(w.m),
      prBase: str(w.pb, "main"),
      prHead: str(w.ph),
      prActivity: str(w.pa, "opened"),
    };
  } catch {
    return null;
  }
}

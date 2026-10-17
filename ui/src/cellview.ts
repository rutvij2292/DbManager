/** Pure helpers for the cell inspector: what a value is and how to show it. No DOM here. */
import type { Val } from "./api";

export type CellView =
  | { kind: "null" }
  | { kind: "json"; text: string; pretty: string }
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; bytes: number[] }
  | { kind: "bytes"; bytes: number[]; text: string | null };

/** Pretty-printed JSON when the text is a JSON object or array (bare numbers / strings are left as plain text). */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return null; }
}

export function minifyJson(text: string): string | null {
  try { return JSON.stringify(JSON.parse(text)); } catch { return null; }
}

/** Image type from the first bytes, or null. */
export function imageMime(b: ArrayLike<number>): string | null {
  const at = (i: number) => b[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  if (at(0) === 0x42 && at(1) === 0x4d) return "image/bmp";
  return null;
}

/** UTF-8 text of the bytes, or null when they aren't valid UTF-8 (or contain control bytes other than whitespace). */
export function bytesToText(b: ArrayLike<number>): string | null {
  for (let i = 0; i < Math.min(b.length, 512); i++) { const x = b[i]; if (x === 0 || (x < 32 && x !== 9 && x !== 10 && x !== 13)) return null; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(b as ArrayLike<number> as number[])); } catch { return null; }
}

/** Classic offset / hex / ASCII dump of up to `max` bytes. */
export function hexDump(b: ArrayLike<number>, max = 4096): string {
  const n = Math.min(b.length, max), lines: string[] = [];
  for (let o = 0; o < n; o += 16) {
    let hex = "", asc = "";
    for (let i = 0; i < 16; i++) {
      if (o + i < n) { const x = b[o + i]; hex += x.toString(16).padStart(2, "0") + " "; asc += x >= 32 && x < 127 ? String.fromCharCode(x) : "."; }
      else hex += "   ";
      if (i === 7) hex += " ";
    }
    lines.push(o.toString(16).padStart(8, "0") + "  " + hex + " " + asc);
  }
  if (b.length > n) lines.push(`… ${(b.length - n).toLocaleString()} more bytes`);
  return lines.join("\n");
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} byte${n === 1 ? "" : "s"}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** Decide how to present a value. `show` renders non-binary values as text (booleans, numbers, ...). */
export function viewOf(v: Val, show: (v: Val) => string): CellView {
  if (v.t === "Null") return { kind: "null" };
  if (v.t === "Bytes") {
    const mime = imageMime(v.v);
    if (mime) return { kind: "image", mime, bytes: v.v };
    return { kind: "bytes", bytes: v.v, text: bytesToText(v.v) };
  }
  const text = show(v);
  const pretty = v.t === "Text" ? prettyJson(text) : null;
  return pretty ? { kind: "json", text, pretty } : { kind: "text", text };
}

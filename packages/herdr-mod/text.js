// Text helpers: search, clipping, dates. Nothing here draws or asks the server.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const norm = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
export const words = (q) => norm(q).split(/\s+/).filter(Boolean);
// What a search looks through in a note (kept on the note until the next read).
export const hay = (n) => (n._hay ??= norm(`${n.title}\n${n.when ?? ""}\n${n.body}\n${n.id}`));

// A note's Markdown with `<name>`-style placeholders kept as text: outside code
// spans the renderer would take them for HTML tags and drop them.
export function md(text) {
  return String(text ?? "")
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/</g, "\\<")))
    .join("");
}

// Where a search found a note whose title doesn't say it: the line around the
// first word the title lacks.
export function snippet(n, terms) {
  const title = norm(n.title);
  const miss = terms.find((w) => !title.includes(w));
  if (!miss) return null;
  const src = `${n.when ?? ""}\n${n.body}`;
  const at = norm(src).indexOf(miss);
  if (at < 0) return null;
  const line = src.lastIndexOf("\n", at) + 1;
  const start = Math.max(line, at - 24);
  const text = src.slice(start).split("\n")[0].replace(/[`*_]/g, "");
  return `${start > line ? "…" : ""}${text}`;
}

// The first two lines of `text` as the row wraps it (about: `cpl` letters a
// line, words kept whole unless longer than a line), with … when there's more.
// The row clips at two lines too; this keeps the … on the second.
export function twoLines(text, cpl) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ");
  const end = (out, used) => (used + 1 <= cpl ? `${out}…` : `${out.slice(0, -1)}…`);
  let line = 0;
  let used = 0;
  let out = "";
  for (const w of words) {
    const gap = used ? 1 : 0;
    if (used + gap + w.length <= cpl) {
      out += (gap ? " " : "") + w;
      used += gap + w.length;
    } else if (w.length <= cpl) {
      if (line === 1) return end(out, used);
      line = 1;
      out += ` ${w}`;
      used = w.length;
    } else {
      // Longer than a line: broken at the edge, from the next line on.
      const from = used ? line + 1 : line;
      const room = (2 - from) * cpl;
      if (room <= 0) return end(out, used);
      if (w.length > room) return `${out}${used ? " " : ""}${w.slice(0, room - 1)}…`;
      out += (used ? " " : "") + w;
      line = from + Math.floor((w.length - 1) / cpl);
      used = ((w.length - 1) % cpl) + 1;
    }
  }
  return out;
}

// At most `max` characters, cut at a word.
export function clip(text, max) {
  text = String(text ?? "");
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(1, max - 1));
  return `${cut.replace(/\s+\S*$/, "") || cut}…`;
}

// "2026-11-08" → "8 Nov" (this year) or "8 Nov 2025".
export function day(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  return `${+m[3]} ${MONTHS[+m[2] - 1]}${+m[1] !== new Date().getFullYear() ? ` ${m[1]}` : ""}`;
}

export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// A moment as the person's clock has it: "8 Nov 14:05".
export function stamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  const local = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return `${day(local)} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// How long something has been going: "", " · 12m", " · 1h 5m".
export function running(sinceIso) {
  const mins = Math.round((Date.now() - Date.parse(sinceIso)) / 60_000);
  if (!(mins >= 1)) return "";
  return mins < 60 ? ` · ${mins}m` : ` · ${Math.floor(mins / 60)}h ${mins % 60}m`;
}

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

// About how wide a letter of 13 px text is (px at zoom 1), by its kind: measured
// on the panel's own titles, within a few percent. The list places rows by
// their heights, so a title's lines are worked out from these. By char code and
// kept per letter: this runs for every title, and a regex per letter made it
// most of what a frame of scrolling cost.
const NARROW = new Set("iljtfr.,:;'\"|!`()[]/\\-·");
const WIDE = new Set("mwшщжюыМШЩЖЮЫMWмд");
const LETTERS = new Map();
function letter(ch) {
  let w = LETTERS.get(ch);
  if (w !== undefined) return w;
  const c = ch.codePointAt(0);
  w = ch === " " ? 3.6
    : NARROW.has(ch) ? 4.2
    : WIDE.has(ch) ? 9.6
    : (c >= 65 && c <= 90) || (c >= 0x410 && c <= 0x42f) || c === 0x401 ? 8.5
    : c >= 48 && c <= 57 ? 7.2
    : c >= 97 && c <= 122 ? 6.8
    : (c >= 0x430 && c <= 0x44f) || c === 0x451 ? 7.0
    : 7.4;
  LETTERS.set(ch, w);
  return w;
}
function widthOf(s) {
  let w = 0;
  for (const ch of s) w += letter(ch);
  return w;
}

// About how wide `s` is at `size` px (px at zoom 1): what a menu needs to be as
// wide as its longest item.
export const textWidth = (s, size = 13) => (widthOf(String(s ?? "")) * size) / 13;

// What fit() answered, by width and text: a title is worked out once, not on
// every frame of scrolling (the list is drawn again for each step of the wheel).
const FITTED = new Map();

// `text` as a row `width` px wide wraps it, in at most two lines: words whole
// unless wider than a line, … where it's cut. A little room is kept: a title
// counted on one line that wraps on screen would lose its second line.
// -> { text, lines }
export function fit(text, width) {
  const key = `${width}\u0000${text ?? ""}`;
  let out = FITTED.get(key);
  if (!out) {
    // Widths change with the panel's: what was kept for the old one goes.
    if (FITTED.size > 3000) FITTED.clear();
    out = wrap(String(text ?? ""), width);
    FITTED.set(key, out);
  }
  return out;
}

function wrap(text, width) {
  const room = width * 0.96;
  const flat = text.replace(/\s+/g, " ").trim();
  if (widthOf(flat) <= room) return { text: flat, lines: 1 };
  let out = "";
  let used = 0;
  let line = 0;
  const cut = () => {
    const chars = [...out];
    while (chars.length && used + letter("…") > room) used -= letter(chars.pop());
    return { text: `${chars.join("").replace(/\s+$/, "")}…`, lines: 2 };
  };
  for (const word of flat.split(" ")) {
    const w = widthOf(word);
    const gap = used > 0 ? letter(" ") : 0;
    if (used + gap + w <= room) {
      out += (gap ? " " : "") + word;
      used += gap + w;
    } else if (line === 0 && w <= room) {
      out += ` ${word}`;
      line = 1;
      used = w;
    } else if (line === 1) {
      // The second line is full: … after its last whole word.
      return cut();
    } else {
      // Wider than a whole line: broken at the edge, letter by letter.
      if (gap) {
        out += " ";
        used += gap;
      }
      for (const ch of word) {
        if (used + letter(ch) > room) {
          if (line === 1) return cut();
          line = 1;
          used = 0;
        }
        out += ch;
        used += letter(ch);
      }
    }
  }
  return { text: out, lines: 2 };
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "1.2k": a token count.
export const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n ?? 0));

// The first line of a commit message.
export const firstLine = (s) => String(s ?? "").split("\n")[0];

// A project key's scope id, as the server names it (core/layout.ts projectScope):
// `github.com/o/r` → `projects/github.com__o__r`. Null for a key too long for
// that (the server hashes those).
export function projectScope(key) {
  const raw = key.startsWith("local:") ? `local/${key.slice(6)}` : key;
  const dir = raw.split("/").filter(Boolean).join("__").replace(/[^A-Za-z0-9._-]/g, "_");
  return dir && dir.length <= 120 ? `projects/${dir}` : null;
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

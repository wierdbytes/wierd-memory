// Small pieces every part of the panel draws with: marks, chips, buttons, and
// the cards of the list. They keep no state: the theme and what to show come in
// as arguments.
//
// The list looks like the sidebar's (the wierd-agents mod): each group is a
// card on the chrome, drawn in pieces that meet edge to edge (the list places
// rows one under another by their heights, scroll.js): a header with a lead
// mark, the name and its buttons in fixed slots, then rows with an 18 px icon
// column, a title and a mono line under it.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { settings, shared, spaces, panes } from "herdr";

export const icon = (name) => `mods/wierd-memory/${name}.svg`;
export const mono = () => settings().font_family ?? "JetBrains Mono";
// A color with an alpha, where it's a plain #rrggbb.
export const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? `${c}${a}` : c);

// How a note reaches pi, as its mark's tooltip says it.
export const REACH = {
  always: "Always in context: every pi session here starts with it",
  pointer: "When relevant: pi sees when it applies and reads it then",
  none: "Search only: pi finds it with memory_search",
  over: "Not in the index (over the token budget): search only",
  off: "Turned off: pi no longer gets it",
  archived: "Archived: replaced or deprecated, pi no longer uses it",
};
export const REACH_LABEL = { always: "Always in context", pointer: "When relevant", none: "Search only", over: "Not in index", off: "Turned off", archived: "Archived" };
// A note's own setting (what an edit chooses), in the legend's words.
export const INDEX = [
  ["always", "always"],
  ["pointer", "when relevant"],
  ["none", "search only"],
];
export const TYPES = ["preference", "procedure", "pitfall", "fact", "decision", "reference"];

// ── geometry (px at zoom 1), as the sidebar's ───────────────────────────────

// A card's corners, the room inside it around its rows, the room between cards;
// a row's corners and the room between rows.
export const CARD_R = 10, CARD_PAD = 4, CARD_GAP = 6, ROW_R = 8, ROW_GAP = 2;
// A card's header, a line inside a card (a fold, a group's name), and a row's
// parts: its padding, a title line, the mono line under it.
export const H_HEAD = 34, H_SUB = 26, PAD_Y = 6, LINE = 20, SUBLINE = 18;
// A group's name inside a card (a project's proposals, the confirmations).
export const H_GROUP = 32;
// A row's height: `lines` of title, and the line under it when there is one.
export const rowHeight = (lines, sub = false) => PAD_Y * 2 + lines * LINE + (sub ? 2 + SUBLINE : 0);
// How much narrower than the list a row's title is: the list's padding, the
// card's sides, the row's padding, the icon column and its gap.
export const ROW_INSET = 16 + 2 * (1 + CARD_PAD) + 16 + 18 + 9;
// What the right end of a row takes from its title (its width and the gap): a
// reach mark, a pin, the word "off", a warning beside the mark.
export const RIGHT = { mark: 12 + 9, icon: 11 + 9, word: 18 + 9, warn: 12 + 5 };

// ── marks ───────────────────────────────────────────────────────────────────

// How a note reaches pi: filled — always; ring — when relevant; dot — search
// only (red: over the budget); grey ring — turned off; dash — archived.
export function mark(t, how, id) {
  const shape =
    how === "always" ? div().size(7).rounded(4).bg(t.accent)
    : how === "pointer" ? div().size(7).rounded(4).border(1.5).border_color(t.accent)
    : how === "off" ? div().size(7).rounded(4).border(1.5).border_color(t.dim)
    : how === "archived" ? div().w(7).h(1.5).rounded(1).bg(t.dim)
    : div().size(4).rounded(2).bg(how === "over" ? t.blocked : t.dim);
  return div().id(id).w(12).h(18).flex_none().flex().items_center().justify_center().tooltip(REACH[how] ?? String(how)).child(shape);
}

// What a stored color name looks like on an avatar: the sidebar's, so a
// project's card here wears its space's color.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

// Scope id → the color of the space that works in its project (see spaceColors).
let colorOf = new Map();

// Which space works in which scope's project: a space is where its first
// terminal is now (as the sidebar says), in the scope whose folder holds that
// most closely. Once per render, before the avatars.
export function spaceColors(scopes) {
  const colors = shared("space.colors") ?? {};
  const roots = scopes.filter((s) => s.root).sort((a, b) => b.root.length - a.root.length);
  const ps = panes();
  colorOf = new Map();
  for (const s of spaces()) {
    if (s.machine || !colors[s.id]) continue;
    const tabs = new Set((s.tabs ?? []).map((c) => c.id));
    const at = ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
    const scope = at && roots.find((r) => at === r.root || at.startsWith(`${r.root}/`));
    if (scope && !colorOf.has(scope.id)) colorOf.set(scope.id, colors[s.id]);
  }
}

// A scope's colored letter: its space's color where a space here works in the
// project's folder, else one picked by its id. Global: a globe on grey.
export const scopeAvatar = (t, scope, size = 18) => avatarBox(t, scopeLook(t, scope), size);

// What a scope's avatar is, as plain data (a menu's copy of this mod draws it
// from its props): { globe: true } or { letter, fill }.
export function scopeLook(t, scope) {
  if (!scope || scope.id === "global") return { globe: true };
  let name = colorOf.get(scope.id);
  if (!name) {
    let h = 0;
    for (const ch of scope.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    name = PALETTE[h % PALETTE.length];
  }
  return { letter: [...(scope.name || "?")][0].toUpperCase(), fill: name.startsWith("#") ? name : (MARK[name] ?? t[name] ?? t.accent) };
}

export function avatarBox(t, look, size = 18) {
  if (look.globe) return h_flex().size(size).flex_none().rounded(5).bg(t.raised).items_center().justify_center().child(svg(icon("globe")).size(size * 0.66).text_color(t.muted));
  return h_flex().size(size).flex_none().rounded(5).bg(look.fill).items_center().justify_center()
    .text_size(10.5 * size / 18).font_bold().text_color("#ffffff").child(look.letter);
}

// A note type's icon (Lucide): on its chip, in the list to choose one.
export const TYPE_ICON = { preference: "type-preference", procedure: "type-procedure", pitfall: "type-pitfall", fact: "type-fact", decision: "type-decision", reference: "type-reference" };
export const typeIcon = (t, type, size = 12, color) => svg(icon(TYPE_ICON[type] ?? "type-fact")).size(size).flex_none().text_color(color ?? t.muted);

// An icon in the avatar's place (a card that isn't a scope: Review, Inbox).
export const leadIcon = (t, name, color) => h_flex().size(18).flex_none().items_center().justify_center().child(svg(icon(name)).size(14).text_color(color ?? t.muted));

export function chip(t, id, content, tip, color) {
  return h_flex()
    .id(id)
    .h(20)
    .flex_none()
    .px(7)
    .gap(5)
    .items_center()
    .rounded(5)
    .bg(t.raised)
    .text_size(11)
    .text_color(color ?? t.muted)
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .children(Array.isArray(content) ? content : [div().child(String(content))]);
}

// A chip that opens a choice (how a note reaches pi, its type, its scope): its
// value and ⌄, framed so it reads as something to press. `changed`: chosen here
// and not saved yet (a proposal's, until it is accepted).
export function dropChip(t, id, content, tip, onClick, { changed = false, off = false } = {}) {
  return h_flex()
    .id(id)
    .h(22)
    .flex_none()
    .pl(7)
    .pr(5)
    .gap(5)
    .items_center()
    .rounded(5)
    .bg(t.raised)
    .border_1()
    .border_color(changed ? t.accent : t.border)
    .text_size(11.5)
    .text_color(changed ? t.foreground : t.muted)
    .when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      if (!off) onClick(e, cx);
    })
    .children(Array.isArray(content) ? content : [div().child(String(content))])
    .child(svg(icon("chevron-down")).size(10).flex_none().text_color(t.dim));
}

// A section's heading ("Why", "Where it came from · 4"): plain case, a little
// smaller and bolder than the text under it.
export function caption(t, text, color) {
  return div().text_size(12).font_semibold().text_color(color ?? t.muted).child(text);
}

// A quiet block on the card's tone (when it applies, a cited session, a before/after).
export function box(t) {
  return v_flex().px(10).py(8).rounded(8).bg(t.surface).border_1().border_color(t.border);
}

export function hint(t, text, left = 10) {
  return div().pl(left).pr(10).py(6).text_size(12).text_color(t.dim).child(text);
}

export function link(t, id, label, onClick) {
  return div()
    .id(id)
    .text_color(t.accent)
    .cursor_pointer()
    .hover((s) => s.underline())
    .on_click(onClick)
    .child(label);
}

// ── buttons ─────────────────────────────────────────────────────────────────

// A button with a label, for a card's actions. `primary`: the card's main
// action, in the app's solid tone (as Herdr's own dialogs); `danger`: turns red
// under the pointer; `off`: drawn faded and does nothing (a request is running).
export function button(t, id, { icon: name, label, tip, onClick, primary = false, danger = false, off = false }) {
  return h_flex()
    .id(id)
    .h(28)
    .flex_none()
    .px(10)
    .gap(6)
    .items_center()
    .rounded(8)
    .border_1()
    .border_color(primary ? t.solid : t.border)
    .text_size(12)
    .text_color(primary ? t.solid_foreground : t.muted)
    .when(primary, (el) => el.bg(t.solid).font_medium())
    .when(!primary, (el) => el.bg(t.surface))
    .when(off, (el) => el.opacity(0.45).cursor_default())
    .when(!off, (el) => el.cursor_pointer())
    .when(!off && primary, (el) => el.hover((s) => s.opacity(0.88)))
    .when(!off && !primary, (el) => el.hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      if (!off) onClick(e, cx);
    })
    .when(Boolean(name), (el) => el.child(svg(icon(name)).size(13).flex_none()))
    .when(Boolean(label), (el) => el.child(div().child(label)));
}

export function iconButton(t, id, name, tip, onClick, size = 26) {
  return div()
    .id(id)
    .size(size)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .rounded(6)
    .cursor_pointer()
    .text_color(t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(e, cx);
    })
    .child(svg(icon(name)).size(size > 22 ? 15 : 13));
}

// A small icon button in a fixed 20 px slot (a card header's, a row's quick
// action), as the sidebar's space rows have: empty when `on` is false, so the
// next card's buttons still line up. Its press is its own (no fold, no open).
// `hover`: its color under the pointer (✓ green, ✕ red).
export function slot(t, id, { on = true, tip, glyph, size = 13, hover, onClick }) {
  const el = h_flex().id(id).size(20).flex_none().items_center().justify_center().rounded(5);
  if (!on) return el;
  return el
    .text_color(t.dim)
    .cursor_pointer()
    .hover((s) => s.bg(t.raised).text_color(hover ?? t.foreground))
    .tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(e, cx);
    })
    .child(svg(icon(glyph)).size(size).flex_none());
}

// A text button inside a line of the list ("Accept 4", "Apply now").
export function textButton(t, id, label, tip, onClick, color) {
  return div()
    .id(id)
    .flex_none()
    .h(20)
    .px(6)
    .flex()
    .items_center()
    .rounded(5)
    .text_size(11)
    .text_color(color ?? t.muted)
    .cursor_pointer()
    .hover((s) => s.bg(t.raised).text_color(color ?? t.foreground))
    .tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(e, cx);
    })
    .child(label);
}

// One of a row of choices (an edit's index mode, its type, its scope).
export function choice(t, id, { label, on, tip, lead, onClick }) {
  return h_flex()
    .id(id)
    .h(24)
    .flex_none()
    .px(8)
    .gap(5)
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(on ? t.accent : t.border)
    .text_size(11.5)
    .text_color(on ? t.foreground : t.muted)
    .cursor_pointer()
    .when(on, (el) => el.bg(t.selected))
    .when(!on, (el) => el.bg(t.surface).hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_click(onClick)
    .when(Boolean(lead), (el) => el.child(lead))
    .child(div().child(label));
}

// "‹ Back", as the sidebar's sessions list has it.
export function backButton(t, tip, onClick) {
  return h_flex()
    .id("mem-back")
    .h(24)
    .pl(4)
    .pr(8)
    .gap(4)
    .flex_none()
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .text_size(11.5)
    .text_color(t.dim)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => onClick(e, cx))
    .child(svg(icon("chevron-left")).size(13).flex_none())
    .child("Back");
}

// ── the list's cards ─────────────────────────────────────────────────────────

// The room after a card.
export const spacer = () => ({ h: CARD_GAP, make: () => div().h(CARD_GAP).flex_none() });

// A piece of a card's height: its content, the room under the last row, and the
// card's top and bottom edges.
const pieceHeight = (kind, h) => h
  + (kind === "last" ? CARD_PAD : 0)
  + (kind === "head" || kind === "only" ? 1 : 0)
  + (kind === "end" || kind === "only" || kind === "last" ? 1 : 0);

// A piece of a card: its header ("head": the top edge; "only": the whole card,
// when nothing shows under it), a row ("side"), the last row with the room under
// it and the bottom edge ("last"). -> { el, h }
export function piece(t, kind, h, child = null) {
  const top = kind === "head" || kind === "only";
  const low = kind === "end" || kind === "only" || kind === "last";
  const total = pieceHeight(kind, h);
  const el = div()
    .h(total)
    .flex_none()
    .bg(t.surface)
    .border_color(t.border)
    .border_l(1)
    .border_r(1)
    .when(top, (el) => el.border_t(1).rounded_t(CARD_R))
    .when(low, (el) => el.border_b(1).rounded_b(CARD_R))
    .when(kind === "side" || kind === "last", (el) => el.px(CARD_PAD))
    .when(kind === "last", (el) => el.pb(CARD_PAD))
    .when(Boolean(child), (el) => el.child(child));
  return { el, h: total };
}

// A piece as the list keeps it: its height now, its element when it shows.
const lazy = (t, kind, h, make = null) => ({ h: pieceHeight(kind, h), make: () => piece(t, kind, h, make?.()).el });

// A card as the list's items: its header (`head()` makes it), then its rows
// ({ h, make, at? }: `at`, the row's place among what the cursor walks),
// ROW_GAP apart, the last one closing it; then the room after it.
export function cardItems(t, head, rows) {
  if (!rows.length) return [lazy(t, "only", H_HEAD, head), spacer()];
  const out = [lazy(t, "head", H_HEAD, head), lazy(t, "side", CARD_PAD)];
  rows.forEach((r, i) => {
    if (i > 0) out.push(lazy(t, "side", ROW_GAP));
    out.push({ ...lazy(t, i === rows.length - 1 ? "last" : "side", r.h, r.make), at: r.at });
  });
  out.push(spacer());
  return out;
}

// A card's header: the lead (an avatar, an icon), the name, a hint after it, a
// tail on the right (counts), then its buttons. `only`: nothing shows under it,
// so it's the whole card. `tint`: its tone (the Review's, in the accent); the
// pointer lights it a step. A click folds the card; a right click opens its menu.
export function cardHead(t, { id, lead, name, color, hint: note, tail, slots = [], only, tint, tip, onClick, onRight }) {
  return v_flex()
    .id(id)
    .h(H_HEAD)
    .pl(CARD_PAD + 8)
    .pr(8)
    .flex_none()
    .justify_center()
    .rounded_t(CARD_R - 1)
    .when(Boolean(only), (el) => el.rounded_b(CARD_R - 1))
    .when(!only, (el) => el.border_b(1).border_color(t.border))
    .bg(tint ?? t.hover)
    .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(tint ? alpha(t.accent, "34") : t.selected)).on_click((_e, cx) => onClick(cx)))
    .when(Boolean(onRight), (el) => el.on_mouse_down("right", (_e, cx) => onRight(cx)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .child(h_flex()
      .gap(9)
      .items_center()
      .child(lead)
      .child(div().min_w(0).max_w(170).truncate().font_semibold().text_color(color ?? t.foreground).child(name))
      .when(Boolean(note), (el) => el.child(div().min_w(0).flex_shrink(1).truncate().text_size(11.5).text_color(t.dim).child(note)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().gap(6).justify_end().items_center().children(tail ?? []))
      .child(h_flex().flex_none().mr(-2).gap(1).items_center().children(slots)));
}

// A line inside a card: a group's name ("herdr-app · 12"), a fold ("Archived 3"),
// a note ("2 comments wait for a dream"). `lead`: an icon in the rows' icon
// column; `open`: a fold's chevron on the right (undefined: no chevron).
export function subRow(t, { id, lead, label, count, color, extra = [], open, on, tip, onClick, onRight }) {
  return h_flex()
    .id(id)
    .relative()
    .h(H_SUB)
    .flex_none()
    .px(8)
    .gap(9)
    .items_center()
    .rounded(ROW_R)
    .text_size(11.5)
    .text_color(color ?? t.dim)
    .when(Boolean(on), (el) => el.bg(t.selected))
    .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(on ? t.selected : t.hover)).on_click((_e, cx) => onClick(cx)))
    .when(Boolean(onRight), (el) => el.on_mouse_down("right", (_e, cx) => onRight(cx)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .child(h_flex().w(18).flex_none().items_center().justify_center().when(Boolean(lead), (el) => el.child(lead)))
    .child(div().min_w(0).truncate().font_medium().child(label))
    .when(count != null, (el) => el.child(div().flex_none().font_family(mono()).text_size(10.5).child(String(count))))
    .child(div().flex_1())
    .children(extra)
    .when(open !== undefined, (el) => el.child(svg(icon(open ? "chevron-down" : "chevron-right")).size(11).flex_none()))
    .when(Boolean(on), (el) => el.child(focusRing(t)));
}

// A group's name inside a card: the name, then a line to whatever acts on the
// group ("Accept 4") or counts it. `open`: a fold's chevron (undefined: none).
export function groupRow(t, { id, lead, label, extra = [], open, on, tip, onClick, onRight }) {
  return h_flex()
    .id(id)
    .relative()
    .h(H_GROUP)
    .flex_none()
    .px(8)
    .gap(9)
    .items_center()
    .rounded(ROW_R)
    .when(Boolean(on), (el) => el.bg(t.selected))
    .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(on ? t.selected : t.hover)).on_click((_e, cx) => onClick(cx)))
    .when(Boolean(onRight), (el) => el.on_mouse_down("right", (_e, cx) => onRight(cx)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .child(h_flex().w(18).flex_none().items_center().justify_center().when(Boolean(lead), (el) => el.child(lead)))
    .child(div().flex_shrink(1).min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(label))
    .child(div().flex_1().min_w(12).h(1).bg(t.border))
    .children(extra)
    .when(open !== undefined, (el) => el.child(svg(icon(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim)))
    .when(Boolean(on), (el) => el.child(focusRing(t)));
}

// The cursor's row: an accent ring over it (the row must be relative), so
// nothing in it moves; the sidebar's focused row wears the same.
export const focusRing = (t, radius = ROW_R) => div().absolute().top(0).left(0).right(0).bottom(0).rounded(radius).border(1).border_color(t.accent);

// A row of a card: a lead mark in the icon column, the title (`lines` of it),
// the mono line under it (`sub`), something on the right. Under the pointer,
// `quick` (slots) cover the right end: the row's frequent actions. `on`: the
// cursor's row.
export function listRow(t, { id, h, lines, on, hovered, lead, title, color, strike, sub, right, quick, onClick, onRight, onHover }) {
  const bg = on ? t.selected : t.hover;
  return h_flex()
    .id(id)
    .relative()
    .h(h)
    .flex_none()
    .px(8)
    .py(PAD_Y)
    .gap(9)
    .items_start()
    .rounded(ROW_R)
    .cursor_pointer()
    .when(Boolean(on), (el) => el.bg(t.selected))
    .hover((s) => s.bg(bg))
    .on_hover((over, cx) => onHover?.(over, cx))
    .on_click((_e, cx) => onClick(cx))
    .when(Boolean(onRight), (el) => el.on_mouse_down("right", (_e, cx) => onRight(cx)))
    .child(h_flex().w(18).h(LINE).flex_none().items_center().justify_center().child(lead))
    .child(v_flex()
      .flex_1()
      .min_w(0)
      .gap(2)
      .child(div()
        .h(lines * LINE)
        .overflow_hidden()
        .line_height(`${LINE}px`)
        .text_color(color ?? t.foreground)
        .when(Boolean(strike), (el) => el.line_through())
        .child(title))
      .when(Boolean(sub), (el) => el.child(h_flex()
        .h(SUBLINE)
        .min_w(0)
        .gap(5)
        .items_center()
        .font_family(mono())
        .text_size(10.5)
        .text_color(t.dim)
        .children(Array.isArray(sub) ? sub : [div().min_w(0).truncate().child(sub)]))))
    .when(Boolean(right), (el) => el.child(h_flex().h(LINE).flex_none().items_center().child(right)))
    .when(Boolean(quick?.length) && hovered, (el) => el.child(h_flex()
      .absolute()
      .top(PAD_Y)
      .right(6)
      .rounded(6)
      .bg(t.surface)
      .child(h_flex().h(LINE).px(2).gap(2).items_center().rounded(6).bg(bg).children(quick))))
    .when(Boolean(on), (el) => el.child(focusRing(t)));
}

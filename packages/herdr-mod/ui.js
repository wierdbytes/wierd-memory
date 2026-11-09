// Small pieces every part of the panel draws with: marks, chips, buttons.
// They keep no state: the theme and what to show come in as arguments.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { settings } from "herdr";

export const icon = (name) => `mods/wierd-mem/${name}.svg`;
export const mono = () => settings().font_family ?? "JetBrains Mono";

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

// A section's small caps heading.
export function caption(t, text, color) {
  return div().text_size(10.5).font_semibold().text_color(color ?? t.dim).child(text);
}

// A quiet bordered block (when it applies, a cited session, a before/after).
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

// A button with a label. `primary`: the card's main action; `danger`: turns red
// under the pointer; `off`: drawn faded and does nothing (a request is running).
export function button(t, id, { icon: name, label, tip, onClick, primary = false, danger = false, off = false }) {
  return h_flex()
    .id(id)
    .h(26)
    .flex_none()
    .px(9)
    .gap(6)
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(primary ? t.accent : t.border)
    .text_size(12)
    .text_color(primary ? t.accent_foreground : t.muted)
    .when(primary, (el) => el.bg(t.accent).font_semibold())
    .when(off, (el) => el.opacity(0.45).cursor_default())
    .when(!off, (el) => el.cursor_pointer())
    .when(!off && !primary, (el) => el.hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
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
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(e, cx);
    })
    .child(svg(icon(name)).size(size > 22 ? 15 : 13));
}

// One of a row of choices (an edit's index mode, its type).
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
    .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_click(onClick)
    .when(Boolean(lead), (el) => el.child(lead))
    .child(div().child(label));
}

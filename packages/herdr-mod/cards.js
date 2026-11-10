// Cards: a note, an inbox item, the edit form, and "where it came from".
// Each card function answers { body: [...], actions: [...] | null }: the body
// scrolls, the actions stay at the card's bottom edge. `m` is the panel (main.js).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Textarea, TextView } from "gpui-base";
import { REACH, REACH_LABEL, INDEX, TYPES, icon, mono, mark, chip, caption, box, link, button, iconButton, choice } from "./ui.js";
import { md, clip, day, stamp } from "./text.js";

// Digest roles, as the cited lines say who spoke.
const ROLE = { USER: "You", AI: "Pi", CALL: "Tool", RESULT: "Result", ERROR: "Error", SHELL: "Shell", CUSTOM: "Note" };
// Evidence kinds, as the session's date says on hover.
const KIND = {
  user: "Your own words in that session",
  observed: "Seen in that session",
  inbox: "Kept with memory_inbox or /remember",
  reviewer: "A comment you left on what dreams propose",
};

export const whenBox = (t, text) => box(t)
  .gap(3)
  .py(7)
  .child(caption(t, "WHEN IT APPLIES"))
  .child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(text));

export const markdown = (id, text) => div().text_size(13).line_height("20px").child(TextView.markdown(id, md(text) || "_(empty)_").selectable(true));

// ── a note ────────────────────────────────────────────────────────────────

export function noteCard(m, t, { note: n, scope }) {
  if (m.form) return { body: form(m, t), actions: formActions(m, t, "Save", "Save the note: applied at once, one commit in memory") };
  const how = n.reach;
  const dates = [`created ${day(n.created)}`, n.updated && n.updated !== n.created ? `updated ${day(n.updated)}` : "", n.confirmed ? `confirmed ${day(n.confirmed)}` : "", n.validUntil ? `valid until ${day(n.validUntil)}` : ""]
    .filter(Boolean)
    .join(" · ");
  const by = n.supersededBy ? m.noteById(n.supersededBy) : null;
  const replaces = (n.supersedes ?? []).map((id) => m.noteById(id)).filter(Boolean);
  const off = n.enabled === false;
  const busy = Boolean(m.busy);
  const body = [
    div().text_size(15).font_semibold().line_height("21px").when(off, (el) => el.text_color(t.muted)).child(n.title || n.id),
    h_flex()
      .flex_wrap()
      .gap(6)
      .child(chip(t, "c-reach", [mark(t, how, "c-reach-mark"), div().child(REACH_LABEL[how] ?? how)], REACH[how]))
      .child(chip(t, "c-type", n.type))
      .child(chip(t, "c-scope", scope?.name ?? n.scopeName ?? n.scope, !scope || scope.key === "global" ? "Global: every project on this computer" : scope.key))
      .child(chip(t, "c-date", day(n.updated || n.created), dates))
      .when(Boolean(n.pinned), (el) => el.child(chip(t, "c-pin", "pinned", "Pinned: first in the index, and a dream never closes it")))
      .when(off && how !== "off", (el) => el.child(chip(t, "c-off", "off", REACH.off)))
      .when(n.status !== "active", (el) => el.child(chip(t, "c-status", n.status))),
  ];
  if (off) body.push(div().text_size(12).line_height("17px").text_color(t.dim).child("Turned off: pi doesn't get this note and dreams leave it alone. Turn it on to use it again."));
  if (by) body.push(h_flex().gap(5).text_size(12).text_color(t.dim).child(div().flex_none().child("Replaced by")).child(link(t, "c-by", clip(by.note.title, 80), (_e, cx) => m.show(by, cx))));
  if (replaces.length) body.push(v_flex().gap(2).text_size(12).text_color(t.dim).child(div().child("Replaces")).children(replaces.map((r, k) => link(t, `c-rep-${k}`, clip(r.note.title, 80), (_e, cx) => m.show(r, cx)))));
  if (n.when) body.push(whenBox(t, n.when));
  body.push(markdown(`md-${n.id}`, n.body));
  body.push(evidence(m, t, n.evidence ?? []));
  const actions = [
    off
      ? button(t, "a-on", { icon: "power", label: "Turn on", tip: "pi gets this note again", off: busy, onClick: (_e, cx) => m.patchNote(n, { enabled: true }, cx) })
      : button(t, "a-off", { icon: "power", label: "Turn off", tip: "pi stops getting this note and dreams leave it alone; it stays here, dimmed", off: busy, onClick: (_e, cx) => m.patchNote(n, { enabled: false }, cx) }),
    button(t, "a-edit", { icon: "edit", label: "Edit", tip: "Change the text by hand: applied at once, no review", off: busy, onClick: (_e, cx) => m.edit("note", n, cx) }),
    n.pinned
      ? button(t, "a-unpin", { icon: "pin", label: "Unpin", tip: "No longer first in the index; dreams may close it", off: busy, onClick: (_e, cx) => m.patchNote(n, { pinned: false }, cx) })
      : button(t, "a-pin", { icon: "pin", label: "Pin", tip: "First in the index, and a dream never closes it", off: busy, onClick: (_e, cx) => m.patchNote(n, { pinned: true }, cx) }),
    div().flex_1(),
    ...(n.file ? [iconButton(t, "a-file", "open", `Open the note's file in $EDITOR beside the focused pane: save it and the server commits the edit\n${m.tilde(n.file)}`, (_e, cx) => m.openFile(n.file, cx))] : []),
    iconButton(t, "a-copy", m.copied === n.id ? "check" : "copy", m.copied === n.id ? "Copied" : `Copy ${n.id}: pi opens it with memory_read`, (_e, cx) => m.copy(n.id, cx)),
    iconButton(t, "a-web", "external", "Open in the browser (history, restore, move)", (_e, cx) => cx.open_url(`${m.server}/#/note/${n.id}`)),
  ];
  return { body, actions };
}

// ── the edit form (a note by hand, a proposal before accepting) ──────────────

function field(m, t, name, state) {
  return h_flex()
    .id(`f-${name}`)
    .h(30)
    .flex_none()
    .px(8)
    .items_center()
    .rounded(7)
    .border_1()
    .border_color(m.fields.has(name) ? t.accent : t.border)
    .bg(t.background)
    .cursor_text()
    .on_mouse_down("left", (_e, cx) => {
      cx.stop_propagation();
      state.focus();
    })
    .child(div().flex_1().min_w(0).child(Input.new(state).h_full().text_size(12.5).text_color(t.foreground)));
}

export function form(m, t) {
  const f = m.form;
  return [
    v_flex().gap(5).child(caption(t, "TITLE")).child(field(m, t, "title", m.fTitle)),
    v_flex().gap(5).child(caption(t, "WHEN IT APPLIES")).child(field(m, t, "when", m.fWhen)),
    v_flex()
      .gap(5)
      .child(caption(t, "BODY · MARKDOWN"))
      .child(Textarea.new(m.fBody)
        .w_full()
        .p(8)
        .rounded(7)
        .border_1()
        .border_color(m.fields.has("body") ? t.accent : t.border)
        .bg(t.background)
        .text_color(t.foreground)
        .text_size(12.5)),
    v_flex()
      .gap(5)
      .child(caption(t, "HOW IT REACHES PI"))
      .child(h_flex().flex_wrap().gap(6).children(INDEX.map(([mode, label]) => choice(t, `f-index-${mode}`, {
        label,
        on: f.index === mode,
        tip: REACH[mode],
        lead: mark(t, mode, `f-index-mark-${mode}`),
        onClick: (_e, cx) => {
          f.index = mode;
          cx.notify();
        },
      })))),
    v_flex()
      .gap(5)
      .child(caption(t, "TYPE"))
      .child(h_flex().flex_wrap().gap(6).children(TYPES.map((type) => choice(t, `f-type-${type}`, {
        label: type,
        on: f.type === type,
        onClick: (_e, cx) => {
          f.type = type;
          cx.notify();
        },
      })))),
  ];
}

export function formActions(m, t, label, tip) {
  const busy = Boolean(m.busy);
  return [
    button(t, "f-save", { icon: "check", label: busy ? "Saving…" : label, tip: `${tip} (${"⌘"}Enter)`, primary: true, off: busy, onClick: (_e, cx) => m.save(cx) }),
    button(t, "f-cancel", { label: "Cancel", tip: "Leave it as it was (Esc)", off: busy, onClick: (_e, cx) => m.closeForm(cx) }),
  ];
}

// ── an inbox item ───────────────────────────────────────────────────────────

export function inboxCard(m, t, item) {
  const target = item.scope === "global" ? "Global" : item.projectName ?? "this project";
  const busy = Boolean(m.busy);
  const body = [
    div().text_size(12).line_height("17px").text_color(t.dim).child("Waiting for the next dream: it becomes memory once you accept what that dream proposes."),
    div().text_size(13.5).line_height("20px").child(TextView.markdown(`inbox-${item.id}`, md(item.text)).selectable(true)),
    h_flex()
      .flex_wrap()
      .gap(6)
      .child(chip(t, "i-from", item.source === "user" ? "from you" : "from an agent"))
      .when(Boolean(item.kind), (el) => el.child(chip(t, "i-kind", item.kind)))
      .child(chip(t, "i-scope", target, item.projectKey))
      .child(chip(t, "i-when", stamp(item.ts))),
  ];
  const actions = [
    button(t, "i-dismiss", { icon: "x", label: "Dismiss", tip: "Drop it: the next dream will not see it", danger: true, off: busy, onClick: (_e, cx) => m.dismiss(item, cx) }),
  ];
  if (item.sessionFile || item.sessionId) {
    actions.push(button(t, "i-open", { icon: "open", label: "Open session", tip: "Open the session it was kept in", onClick: (_e, cx) => m.openSession({ id: item.sessionId, file: item.sessionFile, cwd: item.cwd, name: "" }, cx) }));
  }
  return { body, actions };
}

// ── where it came from ──────────────────────────────────────────────────────

// The sessions a note (or a proposal) cites, newest first, with the cited lines.
// `names`: session id → title, shown until the server has told the session's own.
export function evidence(m, t, list, { title = "WHERE IT CAME FROM", names = {}, empty = "No evidence recorded.", key = "ev" } = {}) {
  const sorted = [...list].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const head = div().pt(4).child(caption(t, sorted.length ? `${title} · ${sorted.length}` : title));
  if (!sorted.length) return v_flex().gap(6).child(head).child(div().text_size(12).text_color(t.dim).child(empty));
  return v_flex()
    .gap(6)
    .child(head)
    .children(sorted.map((ev, k) => evidenceItem(m, t, ev, `${key}-${k}`, names)))
    .when(Boolean(m.evError), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(`Can't read the sessions: ${m.evError}`)));
}

function evidenceItem(m, t, ev, k, names) {
  const lines = [];
  let name = "";
  let open = null;
  if (ev.s === "review") {
    name = "Edited by you before accepting";
  } else if (ev.s.startsWith("comment:")) {
    // The evidence lookup brings the comment; GET /api/review's list has it too while it is recent.
    const c = m.ev[ev.s] ?? (m.data?.review?.comments ?? []).find((x) => x.id === ev.s.slice(8));
    name = c ? `Comment by ${c.author || "you"}${c.at ? `, ${stamp(c.at)}` : ""}` : "A review comment";
    if (c?.body) lines.push({ role: "", text: c.body });
    else if (!c && m.evBusy) lines.push({ role: "", text: "Reading…" });
    else if (!c && ev.s in m.ev) lines.push({ role: "", text: "The comment is no longer kept." });
  } else if (ev.s === "manual") {
    name = "Edited by hand";
  } else if (ev.s.startsWith("inbox:")) {
    const item = m.ev[ev.s];
    name = "Inbox";
    if (item?.text) lines.push({ role: item.source === "user" ? "You" : "Pi", text: item.text });
    if (item?.sessionFile) open = { tip: "Open the session it was kept in", go: (cx) => m.openSession({ id: item.sessionId, file: item.sessionFile, cwd: item.cwd, name: "" }, cx) };
  } else {
    const info = m.ev[ev.s];
    name = info?.name || info?.first || names[ev.s] || `Session ${ev.s.slice(0, 8)}`;
    for (const id of ev.e ?? []) {
      const entry = info?.entries?.[id];
      if (!entry) continue;
      const tool = entry.role === "CALL" || entry.role === "RESULT";
      // What people and pi said reads as text: no Markdown marks (tool lines keep theirs).
      lines.push({ role: ROLE[entry.role] ?? entry.role, text: tool ? entry.text : entry.text.replace(/\*\*|__|`/g, ""), tool });
    }
    if (info && !info.missing && ev.e?.length && !lines.length) lines.push({ role: "", text: "The cited lines aren't in this session's digest." });
    if (info?.missing) lines.push({ role: "", text: "This session has no digest (deleted, or not read yet)." });
    if (!info && m.evBusy) lines.push({ role: "", text: "Reading…" });
    if (!info?.missing) open = { tip: "Open this session in pi", go: (cx) => m.openSession({ id: ev.s, file: info?.file, cwd: info?.cwd, name: info?.name }, cx) };
  }
  return box(t)
    .gap(5)
    .child(h_flex()
      .gap(7)
      .items_center()
      .text_size(12)
      .min_w(0)
      .when(Boolean(ev.date), (el) => el.child(div().id(`${k}-date`).flex_none().text_color(t.dim).when(Boolean(KIND[ev.kind]), (d) => d.tooltip(KIND[ev.kind])).child(day(ev.date))))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(name))
      .when(Boolean(open), (el) => el.child(div()
        .id(`${k}-open`)
        .flex_none()
        .size(20)
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .cursor_pointer()
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(open.tip)
        .on_click((_e, cx) => open.go(cx))
        .child(svg(icon("open")).size(13)))))
    .children(lines.map((l, j) => h_flex()
      .id(`${k}-${j}`)
      .gap(6)
      .items_start()
      .text_size(12)
      .line_height("17px")
      // Your own words stand out: they're what a note leans on most.
      .when(Boolean(l.role), (el) => el.child(div().w(38).flex_none().text_color(l.role === "You" ? t.accent : t.dim).child(l.role)))
      .child(div()
        .flex_1()
        .min_w(0)
        .max_h(17 * 4)
        .overflow_hidden()
        .text_color(l.tool ? t.dim : t.muted)
        .when(Boolean(l.tool), (el) => el.font_family(mono()).text_size(11))
        .child(clip(l.text, 360)))));
}

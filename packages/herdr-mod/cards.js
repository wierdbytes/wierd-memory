// Cards: a note, an inbox item, a skill, a scope; the forms (a note's text, a
// comment, a reason, what to remember, a scope's purpose), a note's history and
// "where it came from". Each card function answers { body: [...], actions:
// [...] | null, menu? }: the body scrolls, the actions stay at the card's bottom
// edge, `menu` is what its ⋯ opens. `m` is the panel (main.js).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Textarea, TextView } from "gpui-base";
import { settings } from "herdr";
import { REACH, REACH_LABEL, INDEX, TYPES, icon, mono, mark, chip, dropChip, caption, box, link, button, choice, scopeAvatar, typeIcon } from "./ui.js";
import { md, clip, day, stamp, ago, plural, tokens, firstLine } from "./text.js";

// Digest roles, as the cited lines say who spoke.
const ROLE = { USER: "You", AI: "Pi", CALL: "Tool", RESULT: "Result", ERROR: "Error", SHELL: "Shell", CUSTOM: "Note" };
// Evidence kinds, as the session's date says on hover.
const KIND = {
  user: "Your own words in that session",
  observed: "Seen in that session",
  inbox: "Kept with memory_inbox or /remember",
  reviewer: "A comment you left on what dreams propose",
};
// A history entry's kind, as it reads.
const CHANGE = { added: ["created", "ansi2"], modified: ["changed", "accent"], removed: ["deleted", "ansi1"] };
// Columns a history entry names (evidence and dates change with nearly every commit).
const QUIET = new Set(["evidence", "updated", "confirmed", "extra", "stats"]);

export const whenBox = (t, text) => box(t)
  .gap(3)
  .py(7)
  .child(caption(t, "When it applies"))
  .child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(text));

// A note's own text reads at the terminal's size (settings().font_size), a step
// up from the panel's 13: it is what the card is for.
export const bodySize = () => Number(settings().font_size) || 14;
export const markdown = (id, text) => {
  const size = bodySize();
  return div().text_size(size).line_height(`${Math.round(size * 1.55)}px`).child(TextView.markdown(id, md(text) || "_(empty)_").selectable(true));
};

const note = (t, text) => div().text_size(12).line_height("17px").text_color(t.dim).child(text);

// A fold inside a card: a caption with a chevron; its content when open.
function section(m, t, key, title, open, onToggle) {
  return h_flex()
    .id(`sec-${key}`)
    .pt(4)
    .gap(6)
    .items_center()
    .cursor_pointer()
    .text_color(t.dim)
    .hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => onToggle(cx))
    .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(11).flex_none())
    .child(caption(t, title));
}

// The budget a scope's index uses: a thin bar, red when notes didn't fit.
export function meter(t, used, budget, over) {
  const share = budget > 0 ? Math.min(1, used / budget) : 0;
  return div().h(4).w_full().rounded(2).bg(t.raised).child(div().h_full().w(`${Math.round(share * 100)}%`).rounded(2).bg(over ? t.blocked : t.accent));
}

// ── a note ────────────────────────────────────────────────────────────────

export function noteCard(m, t, { note: n, scope }) {
  const how = n.reach;
  const dates = [`created ${day(n.created)}`, n.updated && n.updated !== n.created ? `updated ${day(n.updated)}` : "", n.confirmed ? `confirmed ${day(n.confirmed)}` : "", n.validUntil ? `valid until ${day(n.validUntil)}` : ""]
    .filter(Boolean)
    .join(" · ");
  const by = n.supersededBy ? m.noteById(n.supersededBy) : null;
  const replaces = (n.supersedes ?? []).map((id) => m.noteById(id)).filter(Boolean);
  const off = n.enabled === false;
  const busy = Boolean(m.busy);
  const votes = n.stats && (n.stats.helpful || n.stats.harmful) ? n.stats : null;
  // How it reaches pi, its type and its scope are chosen from a list right here:
  // each choice is saved at once, as Edit would.
  const pick = (field) => (_e, cx) => m.menu({ kind: "choose", field, subject: { kind: "note", note: n } }, cx);
  const body = [
    div().text_size(16).font_semibold().line_height("22px").when(off || n.status !== "active", (el) => el.text_color(t.muted)).child(n.title || n.id),
    h_flex()
      .flex_wrap()
      .gap(6)
      .child(dropChip(t, "c-reach", [mark(t, how, "c-reach-mark"), div().child(REACH_LABEL[how] ?? how)], `${REACH[how] ?? ""}\nClick to choose how it reaches pi`, pick("index"), { off: busy }))
      .child(dropChip(t, "c-type", [typeIcon(t, n.type), div().child(n.type)], "Click to choose the type", pick("type"), { off: busy }))
      .child(dropChip(t, "c-scope", [scopeAvatar(t, scope, 12), div().child(scope?.name ?? n.scopeName ?? n.scope)], `${!scope || scope.key === "global" ? "Global: every project on this computer" : scope.key}\nClick to move it to another scope`, pick("scope"), { off: busy }))
      .child(chip(t, "c-date", day(n.updated || n.created), dates))
      .when(Boolean(n.pinned), (el) => el.child(chip(t, "c-pin", [svg(icon("pin")).size(11), div().child("pinned")], "Pinned: first in the index, and a dream never closes it")))
      .when(off && how !== "off", (el) => el.child(chip(t, "c-off", "off", REACH.off)))
      .when(n.status !== "active", (el) => el.child(chip(t, "c-status", n.status === "deprecated" ? "closed" : n.status)))
      .when(Boolean(votes), (el) => el.child(chip(t, "c-votes", `▲${votes.helpful} ▼${votes.harmful}`, "Usefulness votes from session cards: how often the note helped or misled an agent", votes.harmful > votes.helpful ? t.blocked : undefined))),
  ];
  if (off) body.push(note(t, "Turned off: pi doesn't get this note and dreams leave it alone. Turn it on to use it again."));
  if (n.status === "deprecated") body.push(note(t, "Closed: it no longer holds, pi doesn't get it. Reopen it from ⋯ if it does."));
  if (by) body.push(h_flex().gap(5).text_size(12).text_color(t.dim).child(div().flex_none().child("Replaced by")).child(link(t, "c-by", clip(by.note.title, 80), (_e, cx) => m.show(by, cx))));
  if (replaces.length) body.push(v_flex().gap(2).text_size(12).text_color(t.dim).child(div().child("Replaces")).children(replaces.map((r, k) => link(t, `c-rep-${k}`, clip(r.note.title, 80), (_e, cx) => m.show(r, cx)))));
  if (n.when) body.push(whenBox(t, n.when));
  body.push(markdown(`md-${n.id}`, n.body));
  body.push(evidence(m, t, n.evidence ?? []));
  body.push(history(m, t, n));
  const actions = [
    off
      ? button(t, "a-on", { icon: "power", label: "Turn on", tip: "pi gets this note again (O)", off: busy, onClick: (_e, cx) => m.patchNote(n, { enabled: true }, cx) })
      : button(t, "a-off", { icon: "power", label: "Turn off", tip: "pi stops getting this note and dreams leave it alone; it stays here, dimmed (O)", off: busy, onClick: (_e, cx) => m.patchNote(n, { enabled: false }, cx) }),
    button(t, "a-edit", { icon: "edit", label: "Edit", tip: "Change the text by hand: applied at once, no review (E)", off: busy, onClick: (_e, cx) => m.editNote(n, cx) }),
    button(t, n.pinned ? "a-unpin" : "a-pin", { icon: n.pinned ? "pin-off" : "pin", label: n.pinned ? "Unpin" : "Pin", tip: n.pinned ? "No longer first in the index; dreams may close it (P)" : "First in the index, and a dream never closes it (P)", off: busy, onClick: (_e, cx) => m.patchNote(n, { pinned: !n.pinned }, cx) }),
  ];
  return { body, actions, menu: { kind: "note", note: n } };
}

// Every commit of the approved branch that changed the note, newest first; any
// older version can be put back (a new commit: the current one stays in history).
function history(m, t, n) {
  const open = Boolean(m.fold.history);
  const h = m.history[n.id];
  const count = h?.entries ? ` · ${h.entries.length}` : "";
  const out = v_flex().gap(6).child(section(m, t, "history", `History${count}`, open, (cx) => m.toggleHistory(n, cx)));
  if (!open) return out;
  if (!h || h.loading) return out.child(note(t, "Reading…"));
  if (h.error) return out.child(note(t, `Can't read the history: ${h.error}`));
  if (!h.entries.length) return out.child(note(t, "No commits touched this note."));
  return out.children(h.entries.map((e, i) => {
    const [label, color] = CHANGE[e.type] ?? [e.type, "muted"];
    const cols = Object.keys(e.changes ?? {}).filter((c) => !QUIET.has(c));
    const canRestore = i > 0 && e.type !== "removed";
    return box(t)
      .id(`hi-${i}`)
      .gap(3)
      .child(h_flex()
        .gap(7)
        .items_center()
        .font_family(mono())
        .text_size(10.5)
        .text_color(t.dim)
        .child(div().flex_none().text_color(t[color] ?? t.muted).child(label))
        .child(div().flex_none().tooltip(stamp(e.date)).child(ago(Date.parse(e.date))))
        .child(div().min_w(0).truncate().child(e.author))
        .child(div().flex_1())
        .when(i === 0 && e.type !== "removed", (el) => el.child(div().flex_none().child("current")))
        .when(canRestore, (el) => el.child(link(t, `hi-restore-${i}`, m.busy === `restore:${e.commit}` ? "Restoring…" : "Restore", (_e, cx) => m.restore(n, e, cx)))))
      .child(div().text_size(12).line_height("17px").text_color(t.muted).child(clip(firstLine(e.message), 160)))
      .when(cols.length > 0 && e.type === "modified", (el) => el.child(div().font_family(mono()).text_size(10.5).text_color(t.dim).child(cols.join(", "))));
  }));
}

// ── the forms (a note by hand, a proposal before accepting, a new note) ──────

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

function area(m, t, name, state) {
  return Textarea.new(state)
    .w_full()
    .p(8)
    .rounded(7)
    .border_1()
    .border_color(m.fields.has(name) ? t.accent : t.border)
    .bg(t.background)
    .text_color(t.foreground)
    .text_size(12.5);
}

const labelled = (t, label, el) => v_flex().gap(5).child(caption(t, label)).child(el);

// The choices of a row: [value, label, { tip, lead }].
const choices = (t, key, list, value, set) => h_flex().flex_wrap().gap(6).children(list.map(([v, label, extra = {}]) => choice(t, `f-${key}-${v}`, {
  label,
  on: value === v,
  tip: extra.tip,
  lead: extra.lead,
  onClick: (_e, cx) => {
    set(v);
    cx.notify();
  },
})));

export function noteForm(m, t) {
  const f = m.form;
  const scopes = m.scopeChoices();
  const body = [];
  if (f.kind === "review") body.push(note(t, "Your text is accepted in place of the dream's, and the note is marked as yours: later dreams weigh it against older evidence."));
  if (f.kind === "edit") body.push(note(t, "Applied at once, as one commit in memory: a hand edit needs no review."));
  if (f.kind === "new") body.push(note(t, "Written by hand: it becomes memory at once, as one commit."));
  body.push(
    labelled(t, "Title · what pi sees", field(m, t, "title", m.fTitle)),
    labelled(t, "When it applies", field(m, t, "when", m.fWhen)),
    labelled(t, "Body · Markdown", area(m, t, "body", m.fBody)),
  );
  // How it reaches pi, its type and its scope are chosen on the card (its chips);
  // a new note has no card yet, so its form asks.
  if (f.kind === "new") {
    body.push(
      labelled(t, "How it reaches pi", choices(t, "index", INDEX.map(([mode]) => [mode, REACH_LABEL[mode], { tip: REACH[mode], lead: mark(t, mode, `f-index-mark-${mode}`) }]), f.index, (v) => (f.index = v))),
      labelled(t, "Type", choices(t, "type", TYPES.map((type) => [type, type, { lead: typeIcon(t, type, 12) }]), f.type, (v) => (f.type = v))),
    );
    if (scopes.length > 1) body.push(labelled(t, "Scope", choices(t, "scope", scopes.map((s) => [s.id, s.name, { tip: s.key, lead: scopeAvatar(t, s, 12) }]), f.scope, (v) => (f.scope = v))));
  }
  const label = f.kind === "review" ? "Save & accept" : f.kind === "new" ? "Create" : "Save";
  const tip = f.kind === "review" ? "Accept the proposal with this text" : f.kind === "new" ? "Add the note to memory" : "Save the note: applied at once, one commit in memory";
  return { body, actions: formActions(m, t, label, tip) };
}

// A form of one text: what to remember for the next dream, a comment for the
// dream, a reason to reject, a scope's purpose.
export function textForm(m, t) {
  const f = m.form;
  const body = [];
  if (f.kind === "remember") {
    body.push(note(t, "Kept in the inbox for the next dream: it becomes memory once you accept what that dream proposes."));
    body.push(labelled(t, "What to remember", area(m, t, "remember", m.fRemember)));
    const where = [["project", f.projectName ? f.projectName : "this project", { tip: "Memory of the focused pane's project" }], ["global", "Global", { tip: "Every project on this computer" }]].filter(([v]) => v === "global" || f.projectName);
    if (where.length > 1) body.push(labelled(t, "For", choices(t, "where", where, f.where, (v) => (f.where = v))));
    return { body, actions: formActions(m, t, "Remember", "Keep it for the next dream") };
  }
  if (f.kind === "comment") {
    body.push(note(t, f.title ? "What should the dream do with this note? The next dream applies it, or apply it now from the comments." : "A comment about what is proposed as a whole: the next dream applies it."));
    if (f.title) body.push(box(t).child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(f.title)));
    body.push(labelled(t, "Comment", area(m, t, "comment", m.fComment)));
    return { body, actions: formActions(m, t, "Comment", "Save it for the dream") };
  }
  if (f.kind === "reason") {
    body.push(note(t, f.items.length > 1 ? `The ${f.items.length} proposals shown are dropped. Rejected new notes aren't proposed again without new evidence; the reason goes to the next dream.` : "It is dropped and isn't proposed again without new evidence; the reason goes to the next dream."));
    if (f.items.length === 1) body.push(box(t).child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(f.items[0].note?.title || f.items[0].skill?.name || f.items[0].key)));
    body.push(labelled(t, "Why not · optional", field(m, t, "reason", m.fReason)));
    return { body, actions: formActions(m, t, f.items.length > 1 ? `Reject ${f.items.length}` : "Reject", "Reject with this reason", true) };
  }
  // charter
  body.push(note(t, "What belongs in this scope and what doesn't: it steers dreams, not pi."));
  body.push(labelled(t, "What this memory is for", area(m, t, "charter", m.fCharter)));
  return { body, actions: formActions(m, t, "Save", "Save the purpose") };
}

export function formActions(m, t, label, tip, danger = false) {
  const busy = Boolean(m.busy);
  return [
    button(t, "f-save", { icon: danger ? "x" : "check", label: busy ? "Saving…" : label, tip: `${tip} (⌘Enter)`, primary: true, off: busy, onClick: (_e, cx) => m.save(cx) }),
    button(t, "f-cancel", { label: "Cancel", tip: "Leave it as it was (Esc)", off: busy, onClick: (_e, cx) => m.closeForm(cx) }),
  ];
}

// ── an inbox item ───────────────────────────────────────────────────────────

export function inboxCard(m, t, item) {
  const target = item.scope === "global" ? "Global" : item.projectName ?? "this project";
  const busy = Boolean(m.busy);
  const body = [
    note(t, "Waiting for the next dream: it becomes memory once you accept what that dream proposes."),
    markdown(`inbox-${item.id}`, item.text),
    h_flex()
      .flex_wrap()
      .gap(6)
      .child(chip(t, "i-from", item.source === "user" ? "from you" : "from an agent"))
      .when(Boolean(item.kind), (el) => el.child(chip(t, "i-kind", item.kind)))
      .child(chip(t, "i-scope", target, item.projectKey))
      .child(chip(t, "i-when", stamp(item.ts))),
  ];
  const actions = [
    button(t, "i-dismiss", { icon: "x", label: m.busy === "dismiss" ? "Dismissing…" : "Dismiss", tip: "Drop it: the next dream will not see it (X)", danger: true, off: busy, onClick: (_e, cx) => m.dismiss(item, cx) }),
  ];
  if (item.sessionFile || item.sessionId) {
    actions.push(button(t, "i-open", { icon: "open", label: "Open session", tip: "Open the session it was kept in", onClick: (_e, cx) => m.openSession({ id: item.sessionId, file: item.sessionFile, cwd: item.cwd, name: "" }, cx) }));
  }
  return { body, actions, menu: { kind: "inbox", item } };
}

// ── a skill ─────────────────────────────────────────────────────────────────

export function skillCard(m, t, skill) {
  const scope = m.data?.scopes.find((s) => s.id === skill.scope) ?? null;
  const body = [
    div().text_size(16).font_semibold().line_height("22px").font_family(mono()).child(skill.name),
    h_flex()
      .flex_wrap()
      .gap(6)
      .child(chip(t, "s-kind", "skill", "A procedure pi loads as a folder with SKILL.md, in sessions of this scope"))
      .child(chip(t, "s-scope", [scopeAvatar(t, scope, 12), div().child(scope?.name ?? skill.scope)], scope?.key)),
    div().text_size(13).line_height("19px").text_color(t.muted).child(skill.description),
    markdown(`skill-${skill.scope}-${skill.name}`, skill.body),
  ];
  const actions = [button(t, "s-delete", { icon: "trash", label: "Delete", tip: "pi stops loading it in this scope's sessions; history keeps it", danger: true, off: Boolean(m.busy), onClick: (_e, cx) => m.deleteSkill(skill, cx) })];
  return { body, actions, menu: { kind: "skill", skill } };
}

// ── a scope ─────────────────────────────────────────────────────────────────

// What a scope is for (its charter), what its index puts into every session
// (the budget, the exact text), its skills.
export function scopeCard(m, t, scope) {
  const notes = m.data?.byScope.get(scope.id) ?? [];
  const byId = new Map(notes.map((n) => [n.id, n]));
  const indexed = (scope.index?.ids ?? []).map((id) => byId.get(id)).filter(Boolean);
  const always = indexed.filter((n) => n.reach === "always").length;
  const pointer = indexed.filter((n) => n.reach === "pointer").length;
  const over = notes.filter((n) => n.reach === "over").length;
  const global = scope.id === "global";
  const fallback = m.prompts ? (global ? m.prompts.charters?.global : (m.prompts.charters?.projectOverride ?? m.prompts.charters?.project)) : null;
  const charter = scope.charter ?? fallback;
  const skills = (m.data?.skills ?? []).filter((s) => s.scope === scope.id);
  const text = m.sessionText[scope.id];
  const showText = Boolean(m.fold.session);
  const body = [
    h_flex().gap(9).items_center().child(scopeAvatar(t, scope, 22)).child(div().text_size(15).font_semibold().child(scope.name)),
    h_flex()
      .flex_wrap()
      .gap(6)
      .child(chip(t, "sc-active", plural(scope.counts.active, "active note")))
      .when(scope.counts.off > 0, (el) => el.child(chip(t, "sc-off", `${scope.counts.off} off`)))
      .when(scope.counts.archived > 0, (el) => el.child(chip(t, "sc-arch", `${scope.counts.archived} archived`)))
      .child(chip(t, "sc-key", [div().font_family(mono()).child(global ? "every project" : clip(scope.key, 48))], scope.key)),
  ];
  if (scope.root) body.push(div().font_family(mono()).text_size(11).text_color(t.dim).child(m.tilde(scope.root)));

  body.push(v_flex()
    .gap(6)
    .child(h_flex().pt(4).gap(6).items_center().child(caption(t, "What this memory is for")).child(div().text_size(12).text_color(t.dim).child(scope.charter == null ? "· default" : "· yours")))
    .child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(charter || (m.prompts ? "…" : "Reading…")))
    .child(h_flex().gap(10).text_size(12)
      .child(link(t, "sc-charter-edit", "Edit", (_e, cx) => m.charterForm(scope, charter ?? "", cx)))
      .when(scope.charter != null, (el) => el.child(link(t, "sc-charter-default", "Use the default", (_e, cx) => m.setCharter(scope, null, cx))))));

  body.push(v_flex()
    .gap(6)
    .child(div().pt(4).child(caption(t, global ? "In every session" : `In every session of ${scope.name}`)))
    .child(meter(t, scope.index?.tokens ?? 0, scope.budget, (scope.index?.over ?? 0) > 0))
    .child(div().text_size(12).line_height("17px").text_color(t.muted).child(`~${tokens(scope.index?.tokens ?? 0)} of ${tokens(scope.budget)} tokens: ${plural(always, "note")} always in context, ${plural(pointer, "pointer")} for when they apply${over ? `; ${over} over the budget (search only until there is room)` : ""}.`)));

  body.push(v_flex()
    .gap(6)
    .child(section(m, t, "session", "What a session here gets", showText, (cx) => m.toggleSessionText(scope, cx)))
    .when(showText, (el) => el.child(!text || text.loading ? note(t, "Reading…")
      : text.error ? note(t, `Can't read it: ${text.error}`)
      : box(t).gap(6)
        .child(note(t, `${global ? "A session outside any project with memory" : `A session started in ${m.tilde(scope.root ?? "")}`}: ${tokens(text.tokens)} tokens.`))
        .child(v_flex().font_family(mono()).text_size(11).text_color(t.muted).children(String(text.text ?? "(nothing is injected)").split("\n").map((line) => div().line_height("16px").min_h(16).child(line || " ")))))));

  if (skills.length) {
    body.push(v_flex()
      .gap(4)
      .child(div().pt(4).child(caption(t, `Skills · ${skills.length}`)))
      .children(skills.map((s) => h_flex()
        .id(`sc-skill-${s.name}`)
        .gap(8)
        .px(8)
        .py(5)
        .rounded(7)
        .items_start()
        .cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => m.show({ kind: "skill", skill: s }, cx))
        .child(div().flex_none().text_color(t.ansi6).font_semibold().child("§"))
        .child(v_flex().flex_1().min_w(0).child(div().font_family(mono()).text_size(12).child(s.name)).child(div().text_size(11.5).text_color(t.dim).truncate().child(s.description))))));
  }
  const actions = [
    button(t, "sc-new", { icon: "plus", label: "New note", tip: `Write a note for ${scope.name} by hand`, primary: true, off: Boolean(m.busy), onClick: (_e, cx) => m.newNote(scope.id, cx) }),
  ];
  return { body, actions, menu: { kind: "scope", scope } };
}

// ── where it came from ──────────────────────────────────────────────────────

// The sessions a note (or a proposal) cites, newest first, with the cited lines.
// `names`: session id → title, shown until the server has told the session's own.
export function evidence(m, t, list, { title = "Where it came from", names = {}, empty = "No evidence recorded.", key = "ev" } = {}) {
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
      .when(Boolean(ev.date), (el) => el.child(div().id(`${k}-date`).flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).when(Boolean(KIND[ev.kind]), (d) => d.tooltip(KIND[ev.kind])).child(day(ev.date))))
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

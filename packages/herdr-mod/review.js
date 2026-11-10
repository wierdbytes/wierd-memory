// What dreams propose (everything still to decide): rows of the list, the card
// to decide on one (accept, edit and accept, reject), AGENTS.md proposals, and
// the review's own pages: comments for the dream, what was decided lately, the
// dreams behind the proposals. `m` is the panel (main.js).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { REACH, REACH_LABEL, icon, mono, mark, chip, dropChip, caption, box, button, slot, link, listRow, rowHeight, scopeAvatar, typeIcon, LINE, RIGHT } from "./ui.js";
import { evidence, markdown } from "./cards.js";
import { fit, day, stamp, ago, clip, plural } from "./text.js";

// What a proposal does to memory: its glyph, colour, name, and what its row says.
export const KINDS = {
  added: { glyph: "+", label: "New note", color: (t) => t.ansi2, about: () => "a dream proposes a new note" },
  updated: { glyph: "~", label: "Edit", color: (t) => t.ansi3, about: (item) => `changes ${changes(item)}` },
  moved: { glyph: "→", label: "Move", color: (t) => t.ansi4, about: (item) => `from ${item.fromName ?? item.from ?? "another scope"} to ${item.scopeName}` },
  superseded: { glyph: "⇄", label: "Replacement", color: (t) => t.ansi5, about: () => "a new note replaces an older one" },
  deprecated: { glyph: "−", label: "Close", color: (t) => t.ansi1, about: () => "pi stops using this note (it is kept, archived)" },
  removed: { glyph: "−", label: "Remove", color: (t) => t.ansi1, about: () => "deletes this note" },
  confirmed: { glyph: "✓", label: "Confirm", color: (t) => t.muted, about: () => "seen again: only new evidence is added" },
  skill: { glyph: "§", label: "Skill", color: (t) => t.ansi6, about: () => "a procedure pi loads on demand" },
  agents: { glyph: "¶", label: "AGENTS.md", color: (t) => t.accent, about: () => "an edit of the project's own instructions" },
};
export const kindOf = (kind) => KINDS[kind] ?? { glyph: "•", label: String(kind), color: (t) => t.muted, about: () => "" };

// Risky content the server flags in a proposal's text.
const RISKY = {
  "pipe-to-shell": "The text pipes a download into a shell (curl … | sh): check the source before accepting.",
};
const TEXT_FIELDS = ["title", "body", "when", "index", "type", "scope", "status", "pinned"];
const FIELD_NAME = { when: "when it applies", index: "how it reaches pi", scope: "its project" };

// "the title and body": the text columns an edit touches.
function changes(item) {
  const list = (item.fields ?? []).filter((f) => TEXT_FIELDS.includes(f)).map((f) => FIELD_NAME[f] ?? f);
  if (!list.length) return "its evidence";
  return list.length === 1 ? `the ${list[0]}` : `the ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export function glyph(t, kind, id, size = 13) {
  const k = kindOf(kind);
  return div().id(id).w(12).h(18).flex_none().flex().items_center().justify_center().text_size(size).font_semibold().text_color(k.color(t)).tooltip(k.label).child(k.glyph);
}

// "+3 ~1 §1 ¶1": what waits for a decision, by kind.
export function countsLine(review) {
  const counts = review?.counts ?? {};
  const parts = Object.keys(KINDS).filter((k) => k !== "agents" && counts[k] > 0).map((k) => `${KINDS[k].glyph}${counts[k]}`);
  for (const k of Object.keys(counts)) if (!(k in KINDS) && counts[k] > 0) parts.push(`${k} ${counts[k]}`);
  if (review?.agentsPending > 0) parts.push(`${KINDS.agents.glyph}${review.agentsPending}`);
  return parts.join(" ");
}

// "3 new notes, 1 edit": a bulk decision's summary.
export function summary(items) {
  const by = new Map();
  for (const i of items) by.set(i.kind, (by.get(i.kind) ?? 0) + 1);
  return [...by.entries()].map(([k, n]) => plural(n, kindOf(k).label.toLowerCase())).join(", ");
}

// What a search looks through in a proposal.
export const reviewHay = (item) => `${item.note?.title ?? ""}\n${item.note?.when ?? ""}\n${item.note?.body ?? ""}\n${item.skill?.name ?? ""}\n${item.skill?.description ?? ""}\n${item.key}\n${(item.why ?? []).join("\n")}\n${item.scopeName ?? ""}`;
export const agentsHay = (p) => `${p.rel}\n${p.summary ?? ""}\n${p.projectName}\n${(p.rationale ?? []).join("\n")}\n${p.edits.map((e) => `${e.old}\n${e.new}`).join("\n")}`;

// ── rows ────────────────────────────────────────────────────────────────

// A proposal in the list: its kind's glyph and the title, nothing under it (what
// changes, why, where: its card says); a warning and its reach on the right.
// Under the pointer ✓ and ✕ decide it there.
export function reviewRow(m, t, item, at, tw) {
  const id = `r-${item.key}`;
  const closing = item.kind === "deprecated" || item.kind === "removed";
  const warn = (item.risky?.length ?? 0) > 0 || (item.newerEvidence?.length ?? 0) > 0;
  const skill = item.kind === "skill";
  // A skill's name is one line of code; a title wraps beside the reach mark.
  // A warning sits by the mark: a line of its own would only hold the icon.
  const f = skill ? { text: item.skill?.name ?? item.key, lines: 1 } : fit(item.note?.title || item.key, tw - RIGHT.mark - (warn ? RIGHT.warn : 0));
  const mine = Object.keys(m.draftOf(item)).length > 0;
  const h = rowHeight(f.lines);
  return {
    at,
    h,
    make: () => listRow(t, {
      id,
      h,
      lines: f.lines,
      on: m.cursor === at,
      hovered: m.hovered === id,
      lead: glyph(t, item.kind, `rg-${item.key}`),
      title: skill ? div().truncate().font_family(mono()).text_size(12.5).child(f.text) : f.text,
      color: closing ? t.muted : undefined,
      // A skill isn't in the index: nothing to mark.
      right: !skill || warn ? h_flex().gap(5).items_center()
        .when(warn, (el) => el.child(div().id(`rw-${item.key}`).flex_none().tooltip("Read its warning before accepting").child(svg(icon("alert")).size(12).text_color(t.blocked))))
        .when(!skill, (el) => el.child(mark(t, item.reach, `rm-${item.key}`))) : null,
      quick: [
        slot(t, `rq-a-${item.key}`, { glyph: "check", tip: mine ? "Accept with your changes (A)" : "Accept (A)", hover: t.ansi2, onClick: (_e, cx) => m.decide("accept", item, {}, cx) }),
        slot(t, `rq-x-${item.key}`, { glyph: "x", tip: "Reject (X)", hover: t.blocked, onClick: (_e, cx) => m.decide("reject", item, {}, cx) }),
      ],
      onClick: (cx) => m.openAt(at, cx),
      onRight: (cx) => m.menu({ kind: "review", item }, cx),
      onHover: (over, cx) => m.hover(id, over, cx),
    }),
  };
}

export function agentsRow(m, t, p, at, tw) {
  const id = `ra-${p.id}`;
  const f = fit(p.summary || `Edit ${p.rel}`, tw);
  const failed = p.status === "failed";
  return {
    at,
    h: rowHeight(f.lines),
    make: () => listRow(t, {
      id,
      h: rowHeight(f.lines),
      lines: f.lines,
      on: m.cursor === at,
      hovered: m.hovered === id,
      lead: glyph(t, "agents", `rag-${p.id}`),
      title: f.text,
      // Failed to apply: a mark on the right says so (its card says why).
      right: failed ? div().id(`raw-${p.id}`).flex_none().tooltip("Applying it failed: open it to see why").child(svg(icon("alert")).size(12).text_color(t.blocked)) : null,
      quick: [
        slot(t, `raq-a-${p.id}`, { glyph: "check", tip: `Apply to ${p.rel} (A)`, hover: t.ansi2, onClick: (_e, cx) => m.agents("apply", p, cx) }),
        slot(t, `raq-x-${p.id}`, { glyph: "x", tip: "Reject (X)", hover: t.blocked, onClick: (_e, cx) => m.agents("reject", p, cx) }),
      ],
      onClick: (cx) => m.openAt(at, cx),
      onRight: (cx) => m.menu({ kind: "agents", proposal: p }, cx),
      onHover: (over, cx) => m.hover(id, over, cx),
    }),
  };
}

// ── a proposal's card ───────────────────────────────────────────────────────

const kindLine = (t, kind, about) => h_flex()
  .flex_wrap()
  .gap_x(7)
  .items_center()
  .text_size(12)
  .line_height("18px")
  .child(glyph(t, kind, "v-kind"))
  .child(div().flex_none().font_semibold().text_color(kindOf(kind).color(t)).child(kindOf(kind).label))
  .child(div().min_w(0).text_color(t.dim).child(about));

const bullets = (t, list) => v_flex().gap(3).children(list.map((text) => h_flex()
  .gap(7)
  .items_start()
  .text_size(12.5)
  .line_height("18px")
  .text_color(t.muted)
  .child(div().flex_none().text_color(t.dim).child("•"))
  .child(div().flex_1().min_w(0).child(text))));

export const warning = (t, text, color) => h_flex()
  .gap(8)
  .items_start()
  .px(10)
  .py(7)
  .rounded(8)
  .border_1()
  .border_color(color ?? t.blocked)
  .text_size(12)
  .line_height("17px")
  .text_color(t.foreground)
  .child(div().h(17).flex_none().flex().items_center().child(svg(icon("alert")).size(13).text_color(color ?? t.blocked)))
  .child(div().flex_1().min_w(0).child(text));

// Two labelled blocks: what approved memory says now, what it would say.
const beforeAfter = (t, id, before, after) => v_flex()
  .gap(6)
  .child(box(t).gap(4).child(caption(t, "Before")).child(div().opacity(0.7).child(markdown(`${id}-before`, before))))
  .child(box(t).gap(4).child(caption(t, "After", t.accent)).child(markdown(`${id}-after`, after)));

// The comments left on these notes, still waiting for a dream.
function itemComments(m, t, review, ids) {
  const list = (review.comments ?? []).filter((c) => !c.processedRun && c.noteId && ids.includes(c.noteId));
  if (!list.length) return null;
  return v_flex()
    .gap(6)
    .child(div().pt(4).child(caption(t, "Your comments · for the next dream")))
    .children(list.map((c) => commentBox(m, t, c)));
}

export function reviewCard(m, t, { item, review }) {
  const n = item.note ?? {};
  const b = item.before;
  const replacing = item.kind === "superseded";
  const fields = new Set(item.fields ?? []);
  // A replacement's `before` is another note (the one replaced), not an older version.
  const changed = (column) => Boolean(b) && !replacing && fields.has(column);
  const body = [kindLine(t, item.kind, kindOf(item.kind).about(item))];

  if (item.kind === "skill" && item.skill) {
    const s = item.skill;
    body.push(div().text_size(16).font_semibold().line_height("22px").font_family(mono()).child(s.name));
    if (s.before && s.before.description !== s.description) body.push(div().text_size(12.5).line_height("18px").text_color(t.dim).line_through().child(s.before.description));
    body.push(div().text_size(13).line_height("19px").text_color(t.muted).child(s.description));
  } else {
    if (changed("title")) body.push(div().text_size(13).line_height("19px").text_color(t.dim).line_through().child(b.title));
    body.push(div().text_size(16).font_semibold().line_height("22px").child(n.title || item.key));
  }

  // How it reaches pi, its type and its scope: chosen here from a list (a draft:
  // it goes in with Accept), where the proposal has text to edit.
  const draft = m.draftOf(item);
  const mine = Object.keys(draft).length > 0;
  const editable = item.editable && item.kind !== "skill";
  const subject = { kind: "review", item };
  const pick = (field) => (_e, cx) => m.menu({ kind: "choose", field, subject }, cx);
  const how = draft.index ?? item.reach;
  const was = changed("index") ? `\nNow: ${REACH_LABEL[b.index] ?? b.index}` : "";
  const reach = [mark(t, how, "v-reach-mark"), div().child(REACH_LABEL[how] ?? how)];
  const reachTip = draft.index ? "Your choice: it goes in when you accept" : `Once accepted. ${REACH[how] ?? ""}${was}`;
  const type = [typeIcon(t, draft.type ?? n.type), div().child(draft.type ?? (changed("type") ? `${b.type} → ${n.type}` : n.type))];
  const scopeId = draft.scope ?? item.scope;
  const scope = m.scopeChoices().find((s) => s.id === scopeId) ?? { id: scopeId, name: item.scopeName, root: null };
  const where = draft.scope ? [scopeAvatar(t, scope, 12), div().child(scope.name)] : [scopeAvatar(t, scope, 12), div().child(item.kind === "moved" ? `${item.fromName ?? "?"} → ${item.scopeName}` : item.scopeName)];
  const whereTip = draft.scope ? "Your choice: it goes in when you accept" : item.scope === "global" ? "Global: every project on this computer" : item.scope;
  const off = Boolean(m.busy);
  body.push(h_flex()
    .flex_wrap()
    .gap(6)
    .when(item.kind !== "skill", (el) => el
      .child(editable ? dropChip(t, "v-reach", reach, `${reachTip}\nClick to choose how it reaches pi`, pick("index"), { changed: Boolean(draft.index), off }) : chip(t, "v-reach", reach, reachTip))
      .child(editable ? dropChip(t, "v-type", type, draft.type ? "Your choice: it goes in when you accept" : "Click to choose the type", pick("type"), { changed: Boolean(draft.type), off }) : chip(t, "v-type", type)))
    .child(editable ? dropChip(t, "v-scope", where, `${whereTip}\nClick to choose the scope`, pick("scope"), { changed: Boolean(draft.scope), off }) : chip(t, "v-scope", where, whereTip))
    .when(Boolean(n.pinned), (el) => el.child(chip(t, "v-pin", "pinned")))
    .when(Boolean(item.reviewer), (el) => el.child(chip(t, "v-reviewer", "from your comment", "A dream made this on a comment you left"))));
  if (mine) {
    body.push(h_flex()
      .gap(8)
      .items_center()
      .text_size(12)
      .text_color(t.muted)
      .child(div().flex_1().min_w(0).child("Your changes go into memory with Accept."))
      .child(link(t, "v-draft-undo", "Undo", (_e, cx) => m.clearDraft(item, cx))));
  }

  for (const code of item.risky ?? []) body.push(warning(t, RISKY[code] ?? `Risky content in the text: ${code}`));
  if (item.newerEvidence?.length) {
    const last = item.newerEvidence.map((e) => e.date ?? "").sort().pop();
    body.push(warning(t, `The note this closes was seen in a newer session${last ? ` (${day(last)})` : ""} than the change relies on: check that it no longer holds.`, t.ansi3));
  }

  if (item.kind === "skill" && item.skill) {
    const s = item.skill;
    body.push(s.before && s.before.body !== s.body ? beforeAfter(t, "v-skill", s.before.body, s.body) : markdown("v-skill-body", s.body));
  } else {
    if (changed("when")) {
      body.push(box(t)
        .gap(3)
        .py(7)
        .child(caption(t, "When it applies"))
        .when(Boolean(b.when), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.dim).line_through().child(b.when)))
        .child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(n.when || "(always)")));
    } else if (n.when) {
      body.push(box(t).gap(3).py(7).child(caption(t, "When it applies")).child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(n.when)));
    }
    body.push(changed("body") ? beforeAfter(t, `v-body-${n.id}`, b.body, n.body) : markdown(`v-body-${n.id}`, n.body));
    if (replacing && b) {
      const open = Boolean(m.fold.replaces);
      body.push(v_flex()
        .gap(6)
        .child(h_flex()
          .id("v-replaces")
          .gap(6)
          .items_center()
          .cursor_pointer()
          .text_color(t.dim)
          .hover((s) => s.text_color(t.foreground))
          .tooltip("The approved note this one takes the place of: it is archived once you accept")
          .on_click((_e, cx) => {
            m.fold.replaces = !open;
            cx.notify();
          })
          .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(11).flex_none())
          .child(caption(t, "Replaces"))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(open ? b.id : b.title)))
        .when(open, (el) => el.child(box(t)
          .gap(6)
          .child(div().text_size(12.5).font_semibold().line_height("18px").text_color(t.muted).child(b.title))
          .when(Boolean(b.when), (bx) => bx.child(div().text_size(12).line_height("17px").text_color(t.dim).child(`When: ${b.when}`)))
          .child(div().opacity(0.75).child(markdown(`v-old-${b.id}`, b.body))))));
    }
  }

  const why = [...(item.why ?? []), ...(item.remark ? [item.remark] : [])];
  if (why.length) body.push(v_flex().gap(6).child(div().pt(4).child(caption(t, "Why"))).child(bullets(t, why)));

  if (item.check) {
    const c = item.check;
    const ok = c.verdict === "supported";
    const text = ok ? "Supported by the cited sessions" : c.verdict === "partial" ? `Partly supported${c.corrected ? ": the text was corrected" : ""}` : `${c.verdict}${c.corrected ? " (corrected)" : ""}`;
    body.push(v_flex()
      .gap(6)
      .child(div().pt(4).child(caption(t, "Fact check")))
      .child(h_flex()
        .gap(7)
        .items_start()
        .text_size(12.5)
        .line_height("18px")
        .child(div().h(18).flex_none().flex().items_center().child(svg(icon(ok ? "check" : "alert")).size(13).text_color(ok ? t.ansi2 : t.ansi3)))
        .child(v_flex().flex_1().min_w(0).child(div().text_color(t.muted).child(text)).when(Boolean(c.reason), (el) => el.child(div().text_color(t.dim).child(c.reason))))));
  }

  const comments = itemComments(m, t, review, item.ids ?? []);
  if (comments) body.push(comments);

  body.push(evidence(m, t, item.evidence ?? [], { title: "Evidence it adds", names: review.sessionTitles ?? {}, empty: "It adds no evidence." }));

  const busy = Boolean(m.busy);
  const closing = item.kind === "deprecated" || item.kind === "removed";
  const actions = [
    button(t, "v-accept", { icon: "check", label: m.busy === "accept" ? "Accepting…" : closing ? (item.kind === "removed" ? "Accept: delete" : "Accept: close") : mine ? "Accept with changes" : "Accept", tip: mine ? "Accept it with your changes: it becomes memory at once (A)" : "Accept: it becomes memory at once (A)", primary: true, off: busy, onClick: (_e, cx) => m.decide("accept", item, {}, cx) }),
    ...(item.editable ? [button(t, "v-edit", { icon: "edit", label: "Edit", tip: "Change the text, then accept (E)", off: busy, onClick: (_e, cx) => m.editProposal(item, cx) })] : []),
    button(t, "v-reject", { icon: "x", label: m.busy === "reject" ? "Rejecting…" : "Reject", tip: "Reject: it is dropped and isn't proposed again without new evidence (X; with a reason: ⇧X)", danger: true, off: busy, onClick: (_e, cx) => m.decide("reject", item, {}, cx) }),
  ];
  return { body, actions, menu: { kind: "review", item } };
}

// ── an AGENTS.md proposal ───────────────────────────────────────────────────

// Text as written: its own lines, a code font.
const pre = (t, text, color) => v_flex()
  .font_family(mono())
  .text_size(11.5)
  .text_color(color)
  .children(String(text).split("\n").map((line) => div().line_height("17px").min_h(17).child(line || " ")));

export function agentsCard(m, t, { proposal: p }) {
  const busy = Boolean(m.busy);
  const body = [
    kindLine(t, "agents", KINDS.agents.about()),
    div().text_size(16).font_semibold().line_height("22px").child(p.summary || `Edit ${p.rel}`),
    h_flex()
      .flex_wrap()
      .gap(6)
      .child(chip(t, "g-project", p.projectName, p.projectKey))
      .child(chip(t, "g-file", [div().font_family(mono()).child(p.rel)], `${p.repoRoot}/${p.rel}`))
      .child(chip(t, "g-edits", plural(p.edits.length, "edit")))
      .child(chip(t, "g-date", stamp(p.createdAt))),
  ];
  if (p.status === "failed") body.push(warning(t, `Applying it failed: ${p.error ?? "the file no longer matches what the dream read."}`));
  if (p.rationale?.length) body.push(v_flex().gap(6).child(div().pt(4).child(caption(t, "Why"))).child(bullets(t, p.rationale)));
  p.edits.forEach((e, k) => {
    const adds = !e.old;
    const removes = !e.new;
    body.push(v_flex()
      .gap(6)
      .child(div().pt(4).child(caption(t, p.edits.length > 1 ? `Edit ${k + 1} of ${p.edits.length}` : "The edit")))
      .when(!adds, (el) => el.child(box(t).gap(4).child(caption(t, removes ? "Remove" : "Before")).child(pre(t, e.old, t.dim))))
      .when(!removes, (el) => el.child(box(t).gap(4).child(caption(t, adds ? "Add at the end" : "After", t.accent)).child(pre(t, e.new, t.foreground)))));
  });
  body.push(div().text_size(12).line_height("17px").text_color(t.dim).child(`Apply edits ${p.rel} in the project's working copy. Nothing is committed: look at the diff there and commit it yourself.`));
  const actions = [
    button(t, "g-apply", { icon: "check", label: m.busy === "apply" ? "Applying…" : p.status === "failed" ? "Try again" : "Apply", tip: `Edit ${p.repoRoot}/${p.rel} (the working copy; commits nothing) (A)`, primary: true, off: busy, onClick: (_e, cx) => m.agents("apply", p, cx) }),
    button(t, "g-reject", { icon: "x", label: m.busy === "reject" ? "Rejecting…" : "Reject", tip: "Drop the proposal: the file stays as it is (X)", danger: true, off: busy, onClick: (_e, cx) => m.agents("reject", p, cx) }),
  ];
  return { body, actions, menu: { kind: "agents", proposal: p } };
}

// ── comments for the dream ──────────────────────────────────────────────────

// A comment: what it says, who and when, what became of it. A waiting one can be
// deleted; one on a note links to it.
function commentBox(m, t, c, { withNote = false } = {}) {
  const note = withNote && c.noteId ? m.noteById(c.noteId) ?? m.proposalOf(c.noteId) : null;
  const state = c.processedRun ? (c.unhandled ? "read by a dream" : "applied by a dream") : "waits for a dream";
  return box(t)
    .gap(4)
    .child(div().text_size(12.5).line_height("18px").text_color(c.processedRun ? t.dim : t.muted).child(c.body))
    .child(h_flex()
      .flex_wrap()
      .gap_x(6)
      .items_center()
      .text_size(11)
      .text_color(t.dim)
      .child(div().child(`${c.author || "you"} · ${ago(Date.parse(c.at))}`))
      .when(Boolean(withNote && c.noteId), (el) => el.child(div().child("· on")).child(note
        ? link(t, `cm-note-${c.id}`, clip(note.kind === "note" ? note.note.title : note.item.note?.title ?? c.noteId, 40), (_e, cx) => m.show(note, cx))
        : div().font_family(mono()).child(c.noteId)))
      .child(div().child(`· ${state}`))
      .when(!c.processedRun, (el) => el.child(div().flex_1()).child(link(t, `cm-del-${c.id}`, m.busy === `uncomment:${c.id}` ? "Deleting…" : "Delete", (_e, cx) => m.removeComment(c, cx)))))
    .when(Boolean(c.unhandled), (el) => el.child(h_flex().gap(6).items_start().text_size(11.5).text_color(t.ansi3)
      .child(svg(icon("alert")).size(12).flex_none())
      .child(div().flex_1().min_w(0).child(`The dream could not apply it: ${c.unhandled}`))));
}

export function commentsView(m, t, review) {
  const list = review?.comments ?? [];
  const waiting = list.filter((c) => !c.processedRun);
  const done = list.filter((c) => c.processedRun);
  const body = [
    div().text_size(12).line_height("17px").text_color(t.dim).child("Instructions for the dream (“merge the two notes about releases”, “write shorter titles”). The next dream applies them, or apply them now: a short dream reads only the comments."),
  ];
  if (!list.length) body.push(div().text_size(12.5).text_color(t.dim).child("No comments."));
  if (waiting.length) body.push(v_flex().gap(6).child(caption(t, `Waiting · ${waiting.length}`)).children(waiting.map((c) => commentBox(m, t, c, { withNote: true }))));
  if (done.length) body.push(v_flex().gap(6).child(div().pt(4).child(caption(t, `Applied lately · ${done.length}`))).children(done.map((c) => commentBox(m, t, c, { withNote: true }))));
  const busy = Boolean(m.busy);
  const running = Boolean(m.status?.dream?.running);
  const actions = [
    button(t, "cm-add", { icon: "comment", label: "Comment", tip: "A comment about what is proposed as a whole", primary: true, off: busy, onClick: (_e, cx) => m.commentForm(null, cx) }),
    ...(waiting.length ? [button(t, "cm-apply", { icon: "play", label: m.busy === "dream" ? "Starting…" : "Apply now", tip: running ? "A dream is running: it applies them when it ends, or the next one does" : "Start a short dream that applies these comments now", off: busy || running, onClick: (_e, cx) => m.startDream("review", cx) })] : []),
  ];
  return { body, actions };
}

// ── what was decided lately ─────────────────────────────────────────────────

const DECISION = { accepted: "ansi2", edited: "accent", rejected: "ansi1" };

export function decidedView(m, t, review) {
  const list = m.decisions && m.decisions.length > (review?.recent?.length ?? 0) ? m.decisions : review?.recent ?? [];
  const agents = (review?.agents ?? []).filter((a) => a.status === "applied" || a.status === "rejected");
  const body = [];
  if (!list.length && !agents.length) body.push(div().text_size(12.5).text_color(t.dim).child("Nothing was decided yet."));
  body.push(v_flex().gap(2).children(list.map((d, i) => {
    const k = kindOf(d.kind);
    const note = d.noteId && d.decision !== "rejected" ? m.noteById(d.noteId) : null;
    return h_flex()
      .id(`dc-${i}`)
      .gap(9)
      .px(8)
      .py(6)
      .items_start()
      .rounded(8)
      .when(Boolean(note), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => m.show(note, cx)))
      .child(h_flex().w(12).h(LINE).flex_none().items_center().justify_center().text_size(13).font_semibold().text_color(k.color(t)).child(k.glyph))
      .child(v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(div().text_size(12.5).line_height("18px").text_color(d.decision === "rejected" ? t.muted : t.foreground).child(clip(d.title, 140)))
        .child(h_flex().gap(5).items_center().font_family(mono()).text_size(10.5).text_color(t.dim)
          .child(div().flex_none().text_color(t[DECISION[d.decision]] ?? t.muted).child(d.decision))
          .child(div().min_w(0).truncate().child([d.scope ? review?.scopeNames?.[d.scope] ?? d.scope : "", d.by ? `by ${d.by}` : "", d.reason ? `“${d.reason}”` : ""].filter(Boolean).join(" · ")))))
      .child(div().h(LINE).flex_none().flex().items_center().font_family(mono()).text_size(10.5).text_color(t.dim).tooltip(stamp(d.at)).child(ago(Date.parse(d.at))));
  })));
  if (agents.length) {
    body.push(v_flex().gap(4).child(div().pt(6).child(caption(t, "AGENTS.md"))).children(agents.map((a) => h_flex()
      .gap(7)
      .px(8)
      .text_size(12)
      .text_color(t.muted)
      .child(div().flex_none().text_color(a.status === "applied" ? t.ansi2 : t.ansi1).font_family(mono()).text_size(10.5).child(a.status))
      .child(div().flex_1().min_w(0).truncate().child(`${a.projectName} ${a.rel}${a.summary ? ` — ${a.summary}` : ""}`))
      .child(div().flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).child(a.decidedAt ? ago(Date.parse(a.decidedAt)) : "")))));
  }
  const more = !m.decisions && (review?.recent?.length ?? 0) >= 30;
  const actions = more ? [button(t, "dc-more", { icon: "history", label: m.busy === "more" ? "Reading…" : "Older decisions", tip: "The decisions log, further back", off: Boolean(m.busy), onClick: (_e, cx) => m.loadDecisions(cx) })] : null;
  return { body, actions };
}

// ── the dreams behind the proposals ─────────────────────────────────────────

export function aboutView(m, t, review) {
  const body = [];
  if (review?.warnings?.length) {
    body.push(v_flex().gap(6).child(caption(t, "Look at these before accepting in bulk", t.ansi3)).children(review.warnings.map((w) => warning(t, w, t.ansi3))));
  }
  const runs = review?.runInfos ?? [];
  body.push(v_flex().gap(6).child(div().pt(4).child(caption(t, runs.length ? `The dreams they came from · ${runs.length}` : "The dreams they came from"))).children(runs.length ? runs.map((r) => box(t)
    .id(`ab-run-${r.id}`)
    .gap(3)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip("Open the dream's report in the browser")
    .on_click((_e, cx) => cx.open_url(`${m.server}/#/dreams/${r.id}`))
    .child(h_flex().gap(7).items_center().text_size(12.5)
      .child(svg(icon("moon")).size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.title || (r.kind === "review" ? "review comments" : "dream")))
      .child(svg(icon("external")).size(12).flex_none().text_color(t.dim)))
    .child(div().font_family(mono()).text_size(10.5).text_color(t.dim).child([stamp(r.startedAt), r.sessions != null ? plural(r.sessions, "session") : "", r.cost ? `$${r.cost.toFixed(2)}` : "", r.status !== "ok" ? r.status : ""].filter(Boolean).join(" · "))))
    : [div().text_size(12.5).text_color(t.dim).child("Nothing is pending.")]));
  const rejected = review?.rejectedByCheck ?? [];
  if (rejected.length) {
    body.push(v_flex()
      .gap(6)
      .child(div().pt(4).child(caption(t, `Thrown out by the dream's own fact check · ${rejected.length}`)))
      .child(div().text_size(12).text_color(t.dim).child("Proposed by a dream and dropped before reaching you: nothing to decide here."))
      .children(rejected.map((r, i) => box(t)
        .id(`ab-rej-${i}`)
        .gap(3)
        .child(h_flex().gap(7).items_start().text_size(12.5)
          .child(div().flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).pt(1).child(r.op))
          .child(div().flex_1().min_w(0).text_color(t.muted).child(r.title)))
        .when(Boolean(r.reason), (el) => el.child(div().text_size(12).text_color(t.dim).child(r.reason))))));
  }
  body.push(v_flex()
    .gap(4)
    .child(div().pt(4).child(caption(t, "Where they wait")))
    .child(div().text_size(12).line_height("17px").text_color(t.dim).child(`On the git branch ${review?.branch ?? "dreams"}: approved memory plus everything still proposed. Nothing there is memory until you accept it.`))
    .when(Boolean(review?.compareUrl), (el) => el.child(link(t, "ab-compare", "The same difference on GitHub ↗", (_e, cx) => cx.open_url(review.compareUrl)))));
  return { body, actions: null };
}

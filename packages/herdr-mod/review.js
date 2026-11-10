// What dreams propose (everything still to decide), as rows of the list and as cards to
// decide on (accept, edit and accept, reject), and AGENTS.md proposals.
// `m` is the panel (main.js).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { REACH, REACH_LABEL, icon, mono, mark, chip, caption, box, button, iconButton } from "./ui.js";
import { form, formActions, evidence, markdown } from "./cards.js";
import { twoLines, day, stamp } from "./text.js";

// What a proposal does to memory: its glyph, colour and name.
const KINDS = {
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
const kindOf = (kind) => KINDS[kind] ?? { glyph: "•", label: String(kind), color: (t) => t.muted, about: () => "" };

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

function glyph(t, kind, id, size = 13) {
  const k = kindOf(kind);
  return div().id(id).w(12).h(18).flex_none().flex().items_center().justify_center().text_size(size).font_semibold().text_color(k.color(t)).tooltip(k.label).child(k.glyph);
}

// "+3 ~1 §1 ¶1": what waits for a decision, by kind (the summary's counts).
export function countsLine(review) {
  const counts = review?.counts ?? {};
  const parts = Object.keys(KINDS).filter((k) => k !== "agents" && counts[k] > 0).map((k) => `${KINDS[k].glyph}${counts[k]}`);
  for (const k of Object.keys(counts)) if (!(k in KINDS) && counts[k] > 0) parts.push(`${k} ${counts[k]}`);
  if (review?.agentsPending > 0) parts.push(`${KINDS.agents.glyph}${review.agentsPending}`);
  return parts.join(" ");
}

// What a search looks through in a proposal.
export const reviewHay = (item) => `${item.note?.title ?? ""}\n${item.note?.when ?? ""}\n${item.note?.body ?? ""}\n${item.key}\n${(item.why ?? []).join("\n")}\n${item.scopeName ?? ""}`;
export const agentsHay = (p) => `${p.rel}\n${p.summary ?? ""}\n${p.projectName}\n${(p.rationale ?? []).join("\n")}\n${p.edits.map((e) => `${e.old}\n${e.new}`).join("\n")}`;

// ── rows ────────────────────────────────────────────────────────────────

const subline = (t, parts) => h_flex()
  .gap(5)
  .min_w(0)
  .text_size(11)
  .line_height("16px")
  .text_color(t.dim)
  .children(parts);

export function reviewRow(m, t, item, i, cpl) {
  const where = item.kind === "moved" ? `${item.fromName ?? "?"} → ${item.scopeName}` : item.scopeName;
  const warn = (item.risky?.length ?? 0) > 0 || (item.newerEvidence?.length ?? 0) > 0;
  const closing = item.kind === "deprecated" || item.kind === "removed";
  return m.row(t, `r-${item.key}`, i, [
    glyph(t, item.kind, `rg-${item.key}`),
    v_flex()
      .flex_1()
      .min_w(0)
      .child(div().max_h(36).overflow_hidden().line_height("18px").when(closing, (el) => el.text_color(t.muted)).child(twoLines(item.note?.title || item.key, cpl)))
      .child(subline(t, [
        div().min_w(0).truncate().child(where),
        ...(warn ? [svg(icon("alert")).size(11).flex_none().text_color(t.blocked)] : []),
      ])),
    // A skill isn't in the index: nothing to mark.
    ...(item.kind === "skill" ? [] : [mark(t, item.reach, `rm-${item.key}`)]),
  ]);
}

export function agentsRow(m, t, p, i, cpl) {
  return m.row(t, `ra-${p.id}`, i, [
    glyph(t, "agents", `rag-${p.id}`),
    v_flex()
      .flex_1()
      .min_w(0)
      .child(div().max_h(36).overflow_hidden().line_height("18px").child(twoLines(p.summary || `Edit ${p.rel}`, cpl)))
      .child(subline(t, [div().min_w(0).truncate().child(`${p.projectName} · ${p.rel}`)])),
  ]);
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

const warning = (t, text) => h_flex()
  .gap(8)
  .items_start()
  .px(10)
  .py(7)
  .rounded(8)
  .border_1()
  .border_color(t.blocked)
  .text_size(12)
  .line_height("17px")
  .text_color(t.foreground)
  .child(div().h(17).flex_none().flex().items_center().child(svg(icon("alert")).size(13).text_color(t.blocked)))
  .child(div().flex_1().min_w(0).child(text));

// Two labelled blocks: what approved memory says now, what it would say.
const beforeAfter = (t, id, before, after) => v_flex()
  .gap(6)
  .child(box(t).gap(4).child(caption(t, "BEFORE")).child(div().opacity(0.7).child(markdown(`${id}-before`, before))))
  .child(box(t).gap(4).child(caption(t, "AFTER", t.accent)).child(markdown(`${id}-after`, after)));

export function reviewCard(m, t, { item, review }) {
  if (m.form) return { body: form(m, t), actions: formActions(m, t, "Save & accept", "Accept the proposal with this text") };
  const n = item.note ?? {};
  const b = item.before;
  const replacing = item.kind === "superseded";
  const fields = new Set(item.fields ?? []);
  // A replacement's `before` is another note (the one replaced), not an older version.
  const changed = (column) => Boolean(b) && !replacing && fields.has(column);
  const body = [kindLine(t, item.kind, kindOf(item.kind).about(item))];

  if (item.kind === "skill" && item.skill) {
    const s = item.skill;
    body.push(div().text_size(15).font_semibold().line_height("21px").font_family(mono()).child(s.name));
    if (s.before && s.before.description !== s.description) body.push(div().text_size(12.5).line_height("18px").text_color(t.dim).line_through().child(s.before.description));
    body.push(div().text_size(13).line_height("19px").text_color(t.muted).child(s.description));
  } else {
    if (changed("title")) body.push(div().text_size(13).line_height("19px").text_color(t.dim).line_through().child(b.title));
    body.push(div().text_size(15).font_semibold().line_height("21px").child(n.title || item.key));
  }

  const how = item.reach;
  const was = changed("index") ? `\nNow: ${REACH_LABEL[b.index] ?? b.index}` : "";
  body.push(h_flex()
    .flex_wrap()
    .gap(6)
    .when(item.kind !== "skill", (el) => el
      .child(chip(t, "v-reach", [mark(t, how, "v-reach-mark"), div().child(REACH_LABEL[how] ?? how)], `Once accepted. ${REACH[how] ?? ""}${was}`))
      .child(chip(t, "v-type", changed("type") ? `${b.type} → ${n.type}` : n.type)))
    .child(chip(t, "v-scope", item.kind === "moved" ? `${item.fromName ?? "?"} → ${item.scopeName}` : item.scopeName, item.scope === "global" ? "Global: every project on this computer" : item.scope))
    .when(Boolean(n.pinned), (el) => el.child(chip(t, "v-pin", "pinned")))
    .when(Boolean(item.reviewer), (el) => el.child(chip(t, "v-reviewer", "from your comment", "A dream made this on a comment you left"))));

  for (const code of item.risky ?? []) body.push(warning(t, RISKY[code] ?? `Risky content in the text: ${code}`));
  if (item.newerEvidence?.length) {
    const last = item.newerEvidence.map((e) => e.date ?? "").sort().pop();
    body.push(warning(t, `The note this closes was seen in a newer session${last ? ` (${day(last)})` : ""} than the change relies on: check that it no longer holds.`));
  }

  if (item.kind === "skill" && item.skill) {
    const s = item.skill;
    body.push(s.before && s.before.body !== s.body ? beforeAfter(t, "v-skill", s.before.body, s.body) : markdown("v-skill-body", s.body));
  } else {
    if (changed("when")) {
      body.push(box(t)
        .gap(3)
        .py(7)
        .child(caption(t, "WHEN IT APPLIES"))
        .when(Boolean(b.when), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(t.dim).line_through().child(b.when)))
        .child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(n.when || "(always)")));
    } else if (n.when) {
      body.push(box(t).gap(3).py(7).child(caption(t, "WHEN IT APPLIES")).child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(n.when)));
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
          .child(caption(t, "REPLACES"))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(open ? b.id : b.title)))
        .when(open, (el) => el.child(box(t)
          .gap(6)
          .child(div().text_size(12.5).font_semibold().line_height("18px").text_color(t.muted).child(b.title))
          .when(Boolean(b.when), (bx) => bx.child(div().text_size(12).line_height("17px").text_color(t.dim).child(`When: ${b.when}`)))
          .child(div().opacity(0.75).child(markdown(`v-old-${b.id}`, b.body))))));
    }
  }

  const why = [...(item.why ?? []), ...(item.remark ? [item.remark] : [])];
  if (why.length) body.push(v_flex().gap(6).child(div().pt(4).child(caption(t, "WHY"))).child(bullets(t, why)));

  if (item.check) {
    const c = item.check;
    const ok = c.verdict === "supported";
    const text = ok ? "Supported by the cited sessions" : c.verdict === "partial" ? `Partly supported${c.corrected ? ": the text was corrected" : ""}` : `${c.verdict}${c.corrected ? " (corrected)" : ""}`;
    body.push(v_flex()
      .gap(6)
      .child(div().pt(4).child(caption(t, "FACT CHECK")))
      .child(h_flex()
        .gap(7)
        .items_start()
        .text_size(12.5)
        .line_height("18px")
        .child(div().h(18).flex_none().flex().items_center().child(svg(icon(ok ? "check" : "alert")).size(13).text_color(ok ? t.ansi2 : t.ansi3)))
        .child(v_flex().flex_1().min_w(0).child(div().text_color(t.muted).child(text)).when(Boolean(c.reason), (el) => el.child(div().text_color(t.dim).child(c.reason))))));
  }

  const comments = (review.comments ?? []).filter((c) => !c.processedRun && c.noteId && (item.ids ?? []).includes(c.noteId));
  if (comments.length) {
    body.push(v_flex()
      .gap(6)
      .child(div().pt(4).child(caption(t, "YOUR COMMENTS · FOR THE NEXT DREAM")))
      .children(comments.map((c) => box(t).gap(3).child(div().text_size(12.5).line_height("18px").text_color(t.muted).child(c.body)).child(div().text_size(11).text_color(t.dim).child(stamp(c.at))))));
  }

  body.push(evidence(m, t, item.evidence ?? [], { title: "EVIDENCE IT ADDS", names: review.sessionTitles ?? {}, empty: "It adds no evidence." }));

  const busy = Boolean(m.busy);
  const actions = [
    button(t, "v-accept", { icon: "check", label: m.busy === "accept" ? "Accepting…" : "Accept", tip: "Accept: it becomes memory at once (A)", primary: true, off: busy, onClick: (_e, cx) => m.decide("accept", item, null, cx) }),
    ...(item.editable ? [button(t, "v-edit", { icon: "edit", label: "Edit", tip: "Change the text, then accept (E)", off: busy, onClick: (_e, cx) => m.edit("review", item.note, cx) })] : []),
    button(t, "v-reject", { icon: "x", label: m.busy === "reject" ? "Rejecting…" : "Reject", tip: "Reject: it is dropped and isn't proposed again without new evidence (X)", danger: true, off: busy, onClick: (_e, cx) => m.decide("reject", item, null, cx) }),
    div().flex_1(),
    iconButton(t, "v-web", "external", "Open what dreams propose in the browser (comments, the dreams' reports)", (_e, cx) => cx.open_url(`${m.server}/#/review`)),
  ];
  return { body, actions };
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
    div().text_size(15).font_semibold().line_height("21px").child(p.summary || `Edit ${p.rel}`),
    h_flex()
      .flex_wrap()
      .gap(6)
      .child(chip(t, "g-project", p.projectName, p.projectKey))
      .child(chip(t, "g-file", [div().font_family(mono()).child(p.rel)], `${p.repoRoot}/${p.rel}`))
      .child(chip(t, "g-edits", p.edits.length === 1 ? "1 edit" : `${p.edits.length} edits`))
      .child(chip(t, "g-date", stamp(p.createdAt))),
  ];
  if (p.error) body.push(warning(t, p.error));
  if (p.rationale?.length) body.push(v_flex().gap(6).child(div().pt(4).child(caption(t, "WHY"))).child(bullets(t, p.rationale)));
  p.edits.forEach((e, k) => {
    const adds = !e.old;
    const removes = !e.new;
    body.push(v_flex()
      .gap(6)
      .child(div().pt(4).child(caption(t, p.edits.length > 1 ? `EDIT ${k + 1} OF ${p.edits.length}` : "THE EDIT")))
      .when(!adds, (el) => el.child(box(t).gap(4).child(caption(t, removes ? "REMOVE" : "BEFORE")).child(pre(t, e.old, t.dim))))
      .when(!removes, (el) => el.child(box(t).gap(4).child(caption(t, adds ? "ADD AT THE END" : "AFTER", t.accent)).child(pre(t, e.new, t.foreground)))));
  });
  body.push(div().text_size(12).line_height("17px").text_color(t.dim).child(`Apply edits ${p.rel} in the project's working copy. Nothing is committed: look at the diff there and commit it yourself.`));
  const actions = [
    button(t, "g-apply", { icon: "check", label: m.busy === "apply" ? "Applying…" : "Apply", tip: `Edit ${p.repoRoot}/${p.rel} (the working copy; commits nothing) (A)`, primary: true, off: busy, onClick: (_e, cx) => m.agents("apply", p, cx) }),
    button(t, "g-reject", { icon: "x", label: m.busy === "reject" ? "Rejecting…" : "Reject", tip: "Drop the proposal: the file stays as it is (X)", danger: true, off: busy, onClick: (_e, cx) => m.agents("reject", p, cx) }),
    div().flex_1(),
    iconButton(t, "g-web", "external", "Open what dreams propose in the browser", (_e, cx) => cx.open_url(`${m.server}/#/review`)),
  ];
  return { body, actions };
}

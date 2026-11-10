// The list, as cards like the sidebar's spaces: what dreams propose (Review),
// what waits for the next dream (Inbox), then the focused pane's project, Global
// and every other project (folded). Each card has a header (its lead mark, name,
// counts and buttons: + adds, ⋯ opens its menu, the chevron folds it) and rows
// under it; a row's frequent actions show under the pointer, the rest are in its
// menu (right click). Every piece has a fixed height: the list scrolls itself
// (scroll.js). `m` is the panel (main.js).

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { icon, mono, mark, alpha, slot, textButton, cardItems, cardHead, subRow, groupRow, listRow, leadIcon, scopeAvatar, rowHeight, ROW_INSET, RIGHT, H_SUB, H_GROUP } from "./ui.js";
import { norm, words, hay, snippet, fit, tokens, plural } from "./text.js";
import { reviewRow, agentsRow, reviewHay, agentsHay, countsLine } from "./review.js";

// -> { items: [{ h, make, at? }], flat: what the cursor walks, in order }. An
// item's element is made only when it shows (scroll.js): what a row is and how
// tall is known without drawing it.
export function buildList(m, t, ctx) {
  const items = [{ h: 8, make: () => div().h(8).flex_none() }];
  const flat = [];
  const d = m.data;
  const W = m.viewW > 0 ? m.viewW : m.width - 2;
  // How wide a row's title is (px at zoom 1), with nothing on its right.
  const tw = Math.max(120, W - ROW_INSET);
  const terms = words(m.query);
  const searching = terms.length > 0;
  const hit = (text) => terms.every((w) => text.includes(w));
  // A row the cursor can be on: `make(at)` draws it knowing its place.
  const add = (target, make) => {
    flat.push(target);
    return make(flat.length - 1);
  };
  // A fold's line; while searching every fold is open, and the line only names its group.
  const fold = (key, label, count, open, fallback, extra = {}) => searching
    ? { h: H_SUB, make: () => subRow(t, { id: `fold-${key}`, label, count, ...extra, extra: [] }) }
    : add({ kind: "fold", key, fallback }, (at) => ({
      at,
      h: H_SUB,
      make: () => subRow(t, { id: `fold-${key}`, label, count, open, on: m.cursor === at, onClick: (cx) => m.toggle(key, fallback, cx), ...extra }),
    }));

  // ── Review ──
  const r = d.review;
  const all = m.proposals();
  if (r) {
    const shown = searching ? all.filter((p) => hit(norm(p.kind === "review" ? reviewHay(p.item) : agentsHay(p.proposal)))) : all;
    // "Accept all" takes the notes and skills shown; AGENTS.md proposals are applied one by one.
    const notes = all.filter((p) => p.kind === "review").map((p) => p.item);
    const waiting = (r.comments ?? []).filter((c) => !c.processedRun).length;
    const nothing = all.length === 0;
    if (!(searching && !shown.length)) {
      const open = searching || (!nothing && m.isOpen("review", true));
      const rows = [];
      if (open && !nothing) {
        if (!searching && r.warnings?.length) {
          rows.push(add({ kind: "view", view: { kind: "about" } }, (at) => ({
            at,
            h: H_SUB,
            make: () => subRow(t, { id: "rv-warn", lead: svg(icon("alert")).size(12).text_color(t.ansi3), label: `${plural(r.warnings.length, "warning")}: read before accepting in bulk`, color: t.ansi3, on: m.cursor === at, onClick: (cx) => m.go({ kind: "about" }, cx) }),
          })));
        }
        // Notes and skills by scope (the focused project's first, then Global),
        // confirmations folded after them, then AGENTS.md.
        const items = shown.filter((p) => p.kind === "review").map((p) => p.item);
        const main = items.filter((i) => i.kind !== "confirmed");
        const confirmed = items.filter((i) => i.kind === "confirmed");
        const groups = [];
        for (const it of main) {
          let g = groups.find((x) => x.scope === it.scope);
          if (!g) groups.push((g = { scope: it.scope, name: it.scopeName, items: [] }));
          g.items.push(it);
        }
        const rank = (g) => (g.scope === ctx?.scope ? 0 : g.scope === "global" ? 1 : 2);
        groups.sort((a, b) => rank(a) - rank(b));
        // Every group under its project's name: the rows don't say it.
        for (const g of groups) {
          const scope = d.scopes.find((s) => s.id === g.scope) ?? { id: g.scope, name: g.name, root: null };
          // The count is on the button: the name needs none.
          rows.push({
            h: H_GROUP,
            make: () => groupRow(t, {
              id: `rv-g-${g.scope}`,
              lead: scopeAvatar(t, scope, 16),
              label: g.name,
              extra: [searching
                ? div().flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).child(String(g.items.length))
                : textButton(t, `rv-g-all-${g.scope}`, `Accept ${g.items.length}`, `Accept the ${plural(g.items.length, "proposal")} of ${g.name}: asks once more`, (_e, cx) => m.acceptMany(g.items, `The ${plural(g.items.length, "proposal")} of ${g.name}`, cx))],
              onRight: (cx) => m.menu({ kind: "review-scope", name: g.name, items: g.items }, cx),
            }),
          });
          for (const it of g.items) rows.push(add({ kind: "review", item: it }, (at) => reviewRow(m, t, it, at, tw)));
        }
        if (confirmed.length) {
          const openC = searching || m.isOpen("confirmations", false);
          const conf = {
            id: "fold-confirmations",
            lead: div().text_size(12.5).font_semibold().text_color(t.muted).child("✓"),
            label: "Confirmations",
            tip: "Notes newer sessions confirmed: only their evidence and “confirmed” date change",
          };
          rows.push(searching
            ? { h: H_GROUP, make: () => groupRow(t, { ...conf, extra: [div().flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).child(String(confirmed.length))] }) }
            : add({ kind: "fold", key: "confirmations", fallback: false }, (at) => ({
              at,
              h: H_GROUP,
              make: () => groupRow(t, {
                ...conf,
                open: openC,
                on: m.cursor === at,
                onClick: (cx) => m.toggle("confirmations", false, cx),
                extra: [textButton(t, "rv-conf-all", `Accept ${confirmed.length}`, "Accept every confirmation: asks once more", (_e, cx) => m.acceptMany(confirmed, "These confirmations", cx))],
              }),
            })));
          if (openC) for (const it of confirmed) rows.push(add({ kind: "review", item: it }, (at) => reviewRow(m, t, it, at, tw)));
        }
        const agents = shown.filter((p) => p.kind === "agents").map((p) => p.proposal);
        if (agents.length) {
          if (rows.length) rows.push({ h: H_GROUP, make: () => groupRow(t, { id: "rv-agents", lead: div().text_size(12.5).font_semibold().text_color(t.accent).child("¶"), label: "AGENTS.md", tip: "Edits of the projects' own instructions: applied to the working copy, nothing is committed", extra: [div().flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).child(String(agents.length))] }) });
          for (const p of agents) rows.push(add({ kind: "agents", proposal: p }, (at) => agentsRow(m, t, p, at, tw)));
        }
      }
      // Comments left for the dream: they wait even when nothing else does.
      if (!searching && waiting && (open || nothing)) {
        rows.push(add({ kind: "view", view: { kind: "comments" } }, (at) => ({
          at,
          h: H_SUB,
          make: () => subRow(t, {
            id: "rv-comments",
            lead: svg(icon("comment")).size(12),
            label: `${plural(waiting, "comment")} ${waiting === 1 ? "waits" : "wait"} for a dream`,
            on: m.cursor === at,
            onClick: (cx) => m.go({ kind: "comments" }, cx),
            extra: [textButton(t, "rv-comments-apply", "Apply now", "Start a short dream that applies the comments now", (_e, cx) => m.startDream("review", cx))],
          }),
        })));
      }
      const many = notes.length;
      const head = () => cardHead(t, {
        id: "card-review",
        lead: leadIcon(t, "review", nothing ? t.dim : t.accent),
        name: "Review",
        color: nothing ? t.muted : t.accent,
        hint: nothing ? "nothing to decide" : null,
        tail: nothing ? [] : [div().font_family(mono()).text_size(10.5).text_color(t.dim).truncate().child(m.width > 330 ? countsLine(r) : String(all.length))],
        tint: nothing ? null : alpha(t.accent, "1f"),
        only: !rows.length,
        tip: nothing ? "What dreams propose shows here: nothing is memory until you accept it" : `${all.length} to decide${countsLine(r) ? `: ${countsLine(r)}` : ""}\nWhat dreams propose: nothing is memory until you accept it.`,
        slots: [
          slot(t, "rv-all", { on: many > 0 && !searching, glyph: "check-check", tip: `Accept all ${many}: asks once more (AGENTS.md proposals are applied one by one)`, hover: t.ansi2, onClick: (_e, cx) => m.acceptMany(notes, "All the proposals shown", cx) }),
          slot(t, "rv-more", { glyph: "more", tip: "More: reject all, comments, what was decided", onClick: (_e, cx) => m.menu({ kind: "review-card" }, cx) }),
          slot(t, "rv-fold", { on: !nothing && !searching, glyph: open ? "chevron-down" : "chevron-right", size: 12, tip: open ? "Fold" : "Unfold", onClick: (_e, cx) => m.toggle("review", true, cx) }),
        ],
        onClick: nothing || searching ? null : (cx) => m.toggle("review", true, cx),
        onRight: (cx) => m.menu({ kind: "review-card" }, cx),
      });
      items.push(...cardItems(t, head, rows));
    }
  }

  // ── Inbox ──
  const inbox = d.inbox.filter((i) => !searching || hit(norm(i.text)));
  if (inbox.length) {
    const open = searching || m.isOpen("inbox", true);
    const rows = open ? inbox.map((item) => add({ kind: "inbox", item }, (at) => inboxRow(m, t, item, at, tw))) : [];
    const head = () => cardHead(t, {
      id: "card-inbox",
      lead: leadIcon(t, "inbox", t.working),
      name: "Inbox",
      hint: m.width > 300 ? "for the next dream" : null,
      tail: [div().font_family(mono()).text_size(10.5).text_color(t.dim).child(String(inbox.length))],
      only: !rows.length,
      tip: "Kept with memory_inbox or /remember. The next dream reviews these; they become memory once you accept what it proposes.",
      slots: [
        slot(t, "ib-add", { glyph: "plus", tip: "Remember something for the next dream", onClick: (_e, cx) => m.rememberForm(cx) }),
        slot(t, "ib-fold", { on: !searching, glyph: open ? "chevron-down" : "chevron-right", size: 12, tip: open ? "Fold" : "Unfold", onClick: (_e, cx) => m.toggle("inbox", true, cx) }),
      ],
      onClick: searching ? null : (cx) => m.toggle("inbox", true, cx),
      onRight: (cx) => m.menu({ kind: "inbox-card" }, cx),
    });
    items.push(...cardItems(t, head, rows));
  }

  // ── scopes: this project, Global, then the others by name ──
  const byId = new Map(d.scopes.map((s) => [s.id, s]));
  const mine = ctx?.scope ? byId.get(ctx.scope) : null;
  const groups = [];
  if (mine) groups.push({ scope: mine, key: mine.id, name: ctx.name || mine.name, hint: "this project", main: true });
  const global = byId.get("global");
  if (global && global !== mine) groups.push({ scope: global, key: "global", name: "Global", hint: "all projects", main: true });
  for (const s of d.scopes.filter((s) => s.id !== "global" && s !== mine).sort((a, b) => a.name.localeCompare(b.name))) groups.push({ scope: s, key: s.id, name: s.name, main: false });

  // A project here with no memory yet: its card, empty, with + to start it.
  if (ctx && !mine && !searching && ctx.key) {
    const scope = { id: ctx.newScope ?? `new:${ctx.key}`, key: ctx.key, name: ctx.name, root: ctx.root ?? null };
    items.push(...cardItems(t, () => cardHead(t, {
      id: "card-new-project",
      lead: scopeAvatar(t, scope),
      name: ctx.name,
      hint: "no notes yet",
      only: true,
      slots: [slot(t, "np-add", { on: Boolean(ctx.newScope), glyph: "plus", tip: `Write the first note for ${ctx.name}`, onClick: (_e, cx) => m.newNote(ctx.newScope, cx) })],
    }), []));
  }

  const skills = d.skills ?? [];
  for (const g of groups) {
    const notes = d.byScope.get(g.scope.id) ?? [];
    const its = skills.filter((s) => s.scope === g.scope.id);
    const scope = g.scope;
    const index = scope.index ?? { tokens: 0, over: 0 };
    let rows = [];
    let open = false;
    if (searching) {
      const matches = notes.filter((n) => hit(hay(n)));
      const found = its.filter((s) => hit(norm(`${s.name}\n${s.description}\n${s.body}`)));
      if (!matches.length && !found.length) continue;
      open = true;
      rows = [
        ...matches.map((n) => add({ kind: "note", note: n, scope }, (at) => noteRow(m, t, n, at, tw, snippet(n, terms)))),
        ...found.map((s) => add({ kind: "skill", skill: s }, (at) => skillRow(m, t, s, at))),
      ];
    } else {
      open = m.isOpen(g.key, g.main);
      if (open) {
        // Active notes in index order, then the ones turned off; the archive and the
        // skills fold after them.
        const active = notes.filter((n) => n.reach !== "off" && n.reach !== "archived");
        const off = notes.filter((n) => n.reach === "off");
        const old = notes.filter((n) => n.reach === "archived");
        rows = [...active, ...off].map((n) => add({ kind: "note", note: n, scope }, (at) => noteRow(m, t, n, at, tw)));
        if (old.length) {
          const key = `archive:${g.key}`;
          const openOld = m.isOpen(key, false);
          rows.push(fold(key, "Archived", old.length, openOld, false, { lead: svg(icon("archive")).size(12), tip: "Replaced or closed notes: kept for history, pi no longer uses them" }));
          if (openOld) rows.push(...old.map((n) => add({ kind: "note", note: n, scope }, (at) => noteRow(m, t, n, at, tw))));
        }
        if (its.length) {
          const key = `skills:${g.key}`;
          const openS = m.isOpen(key, false);
          rows.push(fold(key, "Skills", its.length, openS, false, { lead: div().text_size(12).font_semibold().text_color(t.ansi6).child("§"), tip: "Procedures pi loads on demand in this scope's sessions" }));
          if (openS) rows.push(...its.map((s) => add({ kind: "skill", skill: s }, (at) => skillRow(m, t, s, at))));
        }
        if (!rows.length) rows.push({ h: H_SUB, make: () => subRow(t, { id: `empty-${g.key}`, label: "No notes yet" }) });
      }
    }
    const active = notes.filter((n) => n.reach !== "off" && n.reach !== "archived").length;
    const over = index.over > 0;
    const head = () => cardHead(t, {
      id: `card-${g.key}`,
      lead: scopeAvatar(t, scope),
      name: g.name,
      color: g.main ? t.foreground : t.muted,
      hint: g.hint && m.width > 300 ? g.hint : null,
      tail: [
        ...(over ? [div().id(`over-${g.key}`).flex_none().text_size(10.5).font_bold().text_color(t.blocked).tooltip(`${plural(index.over, "note")} did not fit the index budget: search only`).child("!")] : []),
        div().id(`count-${g.key}`).flex_none().font_family(mono()).text_size(10.5).text_color(t.dim).tooltip(`Index: ~${tokens(index.tokens)} of ${tokens(scope.budget)} tokens`).child(String(searching ? rows.length : active)),
      ],
      only: !rows.length,
      tip: `${scope.key === "global" ? "Global notes: every project on this computer" : scope.key}\nIndex: ~${index.tokens} of ${scope.budget} tokens${index.over ? ` · ${index.over} over budget` : ""}`,
      slots: [
        slot(t, `sc-add-${g.key}`, { glyph: "plus", tip: `New note in ${g.name}`, onClick: (_e, cx) => m.newNote(scope.id, cx) }),
        slot(t, `sc-more-${g.key}`, { glyph: "more", tip: "More: what it's for, what a session gets", onClick: (_e, cx) => m.menu({ kind: "scope", scope }, cx) }),
        slot(t, `sc-fold-${g.key}`, { on: !searching, glyph: open ? "chevron-down" : "chevron-right", size: 12, tip: open ? "Fold" : "Unfold", onClick: (_e, cx) => m.toggle(g.key, g.main, cx) }),
      ],
      onClick: searching ? null : (cx) => m.toggle(g.key, g.main, cx),
      onRight: (cx) => m.menu({ kind: "scope", scope }, cx),
    });
    items.push(...cardItems(t, head, rows));
  }

  if (searching && flat.length === 0) items.push({ h: 34, make: () => div().h(34).flex_none().px(10).flex().items_center().text_size(12).text_color(t.dim).child("Nothing found") });
  if (!searching && groups.length) items.push(legend(t, W));
  items.push({ h: 8, make: () => div().h(8).flex_none() });
  return { items, flat };
}

function noteRow(m, t, n, at, tw, found = null) {
  const id = `n-${n.id}`;
  const how = n.reach;
  const quiet = how === "archived" || how === "off";
  const right = how === "off" ? div().text_size(10.5).font_family(mono()).text_color(t.dim).child("off")
    : n.pinned ? svg(icon("pin")).size(11).text_color(t.dim)
    : null;
  const f = fit(n.title || n.id, tw - (how === "off" ? RIGHT.word : n.pinned ? RIGHT.icon : 0));
  const h = rowHeight(f.lines, Boolean(found));
  return {
    at,
    h,
    make: () => listRow(t, {
      id,
      h,
      lines: f.lines,
      on: m.cursor === at,
      hovered: m.hovered === id,
      lead: mark(t, how, `m-${n.id}`),
      title: f.text,
      color: quiet ? t.dim : undefined,
      strike: how === "archived",
      sub: found,
      right,
      quick: n.status === "active" ? [
        slot(t, `nq-off-${n.id}`, { glyph: "power", tip: n.enabled === false ? "Turn on (O)" : "Turn off: pi stops getting it (O)", onClick: (_e, cx) => m.patchNote(n, { enabled: n.enabled === false }, cx) }),
        slot(t, `nq-pin-${n.id}`, { glyph: n.pinned ? "pin-off" : "pin", tip: n.pinned ? "Unpin (P)" : "Pin: first in the index, never closed by a dream (P)", onClick: (_e, cx) => m.patchNote(n, { pinned: !n.pinned }, cx) }),
      ] : null,
      onClick: (cx) => m.openAt(at, cx),
      onRight: (cx) => m.menu({ kind: "note", note: n }, cx),
      onHover: (over, cx) => m.hover(id, over, cx),
    }),
  };
}

function inboxRow(m, t, item, at, tw) {
  const id = `i-${item.id}`;
  const f = fit(item.text, tw);
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
      lead: div().text_size(13).text_color(t.working).child("+"),
      title: f.text,
      quick: [slot(t, `iq-x-${item.id}`, { glyph: "x", tip: "Dismiss: the next dream won't see it (X)", hover: t.blocked, onClick: (_e, cx) => m.dismiss(item, cx) })],
      onClick: (cx) => m.openAt(at, cx),
      onRight: (cx) => m.menu({ kind: "inbox", item }, cx),
      onHover: (over, cx) => m.hover(id, over, cx),
    }),
  };
}

function skillRow(m, t, s, at) {
  const id = `s-${s.scope}-${s.name}`;
  const h = rowHeight(1);
  return {
    at,
    h,
    make: () => listRow(t, {
      id,
      h,
      lines: 1,
      on: m.cursor === at,
      hovered: false,
      lead: div().text_size(13).font_semibold().text_color(t.ansi6).child("§"),
      title: div().id(`${id}-name`).truncate().font_family(mono()).text_size(12.5).tooltip(s.description).child(s.name),
      onClick: (cx) => m.openAt(at, cx),
      onRight: (cx) => m.menu({ kind: "skill", skill: s }, cx),
    }),
  };
}

// What the marks mean, after the last card.
function legend(t, width) {
  const item = (how, text) => h_flex().gap(5).items_center().child(mark(t, how, `legend-${how}`)).child(div().child(text));
  const wide = width >= 320;
  const h = wide ? 28 : 46;
  return {
    h,
    make: () => h_flex()
      .h(h)
      .flex_none()
      .flex_wrap()
      .content_center()
      .px(10)
      .gap_x(12)
      .text_size(11)
      .text_color(t.dim)
      .child(item("always", "always in context"))
      .child(item("pointer", "when relevant"))
      .child(item("none", "search only")),
  };
}

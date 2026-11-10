# wierd-memory: the Herdr panel

A panel for the [Herdr app](https://herdr.dev) that shows what wierd-memory remembers for pi and does
everything the web UI does with it: decide on what dreams propose, keep and edit notes, look after the dreams.
It is drawn like the sidebar (the `wierd-agents` mod): a list of cards on the chrome, inside the same frame as
Files and Changes.

## What it shows

A search field and **+** (a new note here or in Global, something to remember for the next dream), then cards:

- **Review**: everything dreams propose, as rows. There are no numbered reviews or rounds: all proposals wait
  together on one branch (`dreams`) until you decide them, any of them, at any time. A row is one of
  `+` new note, `~` edit, `→` move, `⇄` replacement, `−` close, `✓` confirm, `§` skill, `¶` AGENTS.md edit,
  and its title: what changes, why and where is on its card. ⚠ beside the mark asks to read a warning first. Rows
  are grouped by project under its name (the focused pane's first, then Global; each group's **Accept N** asks
  once more), confirmations fold after them, AGENTS.md proposals come last. A line warns when the
  dreams flagged something to read before accepting in bulk, another when comments wait for a dream (**Apply now**).
  The header's **✓✓** accepts every proposal shown (it asks first); its **⋯** has the rest: reject all (with a
  reason), a comment on the proposals as a whole, the comments, what was decided lately, the dreams behind them.
  With nothing to decide the card is just its header.
- **Inbox** (while something waits): what was kept for the next dream (`memory_inbox`, `/remember`); **+** adds.
- **The focused pane's project** and **Global**, then every other project, folded. The avatar wears the color of
  the space working in that project, as the sidebar does. A mark says how a note reaches pi: ● always in context,
  ○ when relevant, · search only (red: over the index budget), grey ring + "off": turned off, dash: archived.
  Archived notes and the scope's skills fold at the end of its card. **+** writes a note there, **⋯** opens what the
  scope is for (its charter, editable), how much of the index budget it uses and the exact `<memory>` text a
  session there gets.
- **Footer**: the dream's state; click it for **Dream now**, **Apply the comments now**, **Stop the dream**,
  scheduled dreams on / off, **Sync with the remote now**. "N to decide" goes to the proposals.

Actions come in three steps:

1. **Under the pointer** a row shows its frequent ones: ✓ / ✕ on a proposal (an AGENTS.md one: apply / reject),
   turn off / pin on a note, ✕ on an inbox item.
2. **A row's card** (Enter, a click) has the main ones as buttons at its bottom edge: Accept / Edit / Reject,
   Turn off / Edit / Pin, Apply / Reject, Dismiss. A proposal's card shows what changes (before → after), why, the
   fact check, warnings, your comments on it and the evidence it adds; ↑ ↓ in its header step through the
   proposals, and a decision opens the next one. Its text reads at the terminal's font size.
   How it reaches pi, its type and its scope are lists to choose from right on the card (the chips with ⌄, each
   choice with its mark, icon or avatar): on a note the choice is saved at once; on a proposal it waits for Accept
   ("Accept with changes", **Undo** takes it back) and goes in with ✓ and Accept all too. A note's card has its text, when it applies, where it came from
   (↗ opens a cited session in a peek panel) and its **history**: every commit that changed it, any older version
   restorable.
3. **⋯ or a right click** (`.` from the keyboard) opens the menu with everything else, drawn as Herdr's own:
   reject with a reason, a comment for the dream, the approved note behind a proposal; close / reopen, move to
   another scope, history, open the file in `$EDITOR` (notes are Markdown files in a git repository: save, and the
   server commits the edit), copy the id, open in the browser, delete (it asks first).

Edits are forms in the panel (⌘Enter saves): a note's title, when it applies and body (how it reaches pi, its type
and scope are on the card; a new note's form asks for them too). Edit-then-accept uses the same form on a proposal.

Each decision carries the versions shown: if a proposal changed or was decided meanwhile, the server refuses, the
panel says so and reloads. An AGENTS.md proposal is **applied** to the project's working copy (nothing is
committed) or rejected.

It follows the server live (`GET /api/wait`); when the server is away it says so and comes back by itself once
`wmem serve` runs again.

## Keys

In the list: `↑` `↓` (`j` `k`) move, `Enter` opens, `/` searches, `Esc` clears the search, `.` opens the row's menu.
On a proposal's row or card: `a` accept, `e` edit, `x` reject, `⇧X` reject with a reason, `c` comment for the dream
(an AGENTS.md proposal: `a` apply, `x` reject). On a note: `e` edit, `o` turn off / on, `p` pin. On an inbox item: `x`
dismiss. In a card: `Esc` or `Backspace` goes back, `↑` `↓` step through the proposals. In a form: `⌘Enter` saves,
`Esc` cancels. The keys work on a Russian layout too.

## Commands

Bind them in `keys.json` as `wierd-memory.<command>` (they reach a shown copy):

| Command | What it does |
|---|---|
| `wierd-memory.search` | the keyboard goes to the search field |
| `wierd-memory.review` | the list with the Review card open, the cursor on its first proposal |
| `wierd-memory.open-<note id>` | opens that note's card (`wierd-memory.open-m-1a2b3c`) |
| `wierd-memory.focus` | the keyboard goes to the panel (what `pane.go` sends with `"focusable": true` in `mod.json`) |

The panel's menus and questions answer it the same way (`menu-<token>-<n>`, `dialog-<token>`): they are copies
of this mod opened as a popup or a dialog.

## Install

```sh
wmem herdr install
```

copies this folder to `~/.config/herdr-app/mods/wierd-memory/`, writes the server's address to
`server.json` there (the mod reads it at start; without it: `http://127.0.0.1:7433`) and runs `herdr-app check`.
Run it again after changing the port or updating wierd-memory.

Then put the panel into a layout (`~/.config/herdr-app/layouts/<name>.json`), e.g. beside Files in a stack:

```json
{ "id": "wierd-memory", "type": "block", "content": { "mod": "wierd-memory" } }
```

or look at it without touching a layout: `herdr-app do mod.open --name wierd-memory` (again: closes it).

## Files

| | |
|---|---|
| `main.js` | the panel: reading the server, what it shows, the actions, the forms' saving, keys, the header and footer |
| `list.js` | the list: the Review, Inbox and scope cards and their rows |
| `review.js` | proposals: rows, cards, AGENTS.md; the comments, decisions and dreams pages |
| `cards.js` | a note's card (with its history), an inbox item's, a skill's, a scope's; the forms; "where it came from" |
| `menu.js` | what each menu holds; the popup menu and the dialog (copies of this mod) |
| `scroll.js` | the list scrolling itself, as the sidebar's does (every row has a known height) |
| `ui.js`, `text.js`, `api.js` | cards, rows, marks, buttons; text helpers (a title's lines by its letters' widths); the HTTP client |
| `*.svg` | icons (Lucide) |

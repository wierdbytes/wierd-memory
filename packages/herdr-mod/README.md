# wierd-memory: the Herdr panel

A panel for the [Herdr app](https://herdr.dev) that shows what wierd-memory remembers for pi,
and lets you decide on what dreams propose without leaving the window.

## What it shows

Top to bottom:

- **Review** (only while something waits for a decision): everything dreams propose, as rows. There are no
  numbered reviews or rounds: all proposals wait together on one branch (`dreams`) until you decide them,
  any of them, at any time. A row is one of
  `+` new note, `~` edit, `→` move, `⇄` replacement, `−` close, `✓` confirm, `§` skill, `¶` AGENTS.md edit.
  A row opens as a card: what changes (before → after), why, the fact check, warnings, the evidence it adds.
  **Accept**, **Edit** (change the text, then accept), **Reject**. "Accept all" in the group's heading asks once more
  and accepts the notes and skills the panel shows (not what a dream proposed since). Each decision carries the
  versions shown: if a proposal changed or was decided meanwhile, the server refuses, the panel says so and reloads.
  An AGENTS.md proposal is **applied** to the project's working copy (nothing is committed) or rejected.
- **Inbox**: what waits for the next dream (`memory_inbox`, `/remember`). A card can be dismissed.
- **This project** (the focused pane's) and **Global**, then every other project, folded.
  A mark says how a note reaches pi: ● always in context, ○ when relevant, · search only
  (red: over the index budget), grey ring + "off": turned off, dash: archived.
  A note's card has its text, when it applies, where it came from (sessions, the cited lines,
  ↗ opens the session in a peek panel) and actions: **Turn off / on**, **Edit** (applied at once),
  **Pin / Unpin**, open its file in `$EDITOR` (notes are Markdown files in a git repository: save,
  and the server commits the edit), copy its id, open it in the browser.
- **Footer**: the dream's state, "N to decide" (goes to the proposals; its tooltip has the counts by kind),
  the inbox count, a link to the web UI.

It follows the server live (`GET /api/wait`); when the server is away it says so
and comes back by itself once `wmem serve` runs again.

## Keys

In the list: `↑` `↓` move, `Enter` opens, `/` searches, `Esc` clears the search.
In a card: `Esc` or `Backspace` goes back. In a review card: `a` accept, `e` edit, `x` reject
(the cursor lands on the next proposal, so `Enter` `a` `Enter` `a` … walks the proposals).
In the edit form: `⌘Enter` saves, `Esc` cancels.

## Commands

Bind them in `keys.json` as `wierd-memory.<command>` (they reach a shown copy):

| Command | What it does |
|---|---|
| `wierd-memory.search` | the keyboard goes to the search field |
| `wierd-memory.review` | the list with the Review group open, the cursor on its first proposal |
| `wierd-memory.open-<note id>` | opens that note's card (`wierd-memory.open-m-1a2b3c`) |
| `wierd-memory.focus` | the keyboard goes to the panel (what `pane.go` sends with `"focusable": true` in `mod.json`) |

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
| `main.js` | the panel: reading the server, the list, keys, the footer |
| `cards.js` | a note's card, an inbox item's, the edit form, "where it came from" |
| `review.js` | proposals: rows, cards, AGENTS.md |
| `ui.js`, `text.js`, `api.js` | marks / chips / buttons, text helpers, the HTTP client |
| `*.svg` | icons |

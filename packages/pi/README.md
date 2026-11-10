# @wierdbytes/pi-memory

Long-term memory for [pi](https://pi.dev): the pi side of
[wierd-memory](https://github.com/wierdbytes/wierd-memory), a memory kept as Markdown notes in a git repository,
where background **dreams** over your past sessions propose changes and nothing becomes memory until you accept it.

```sh
pi install npm:@wierdbytes/pi-memory
```

It needs the wierd-memory server running on this machine (`wmem serve`, by default on `127.0.0.1:7433`) — see
[Setup](https://github.com/wierdbytes/wierd-memory#setup). The extension only talks to the server's HTTP API.

## What it does

- **`<memory>` in the system prompt**: the approved notes for the session's project (global + project scope), as a
  small index within a token budget. It is asked of the server once per session and then frozen, so the prompt
  cache keeps hitting; resumed sessions replay what they got.
- **Skills** approved in memory are offered to the session.
- **Tools**
  - `memory_search` — approved notes and digests of past pi sessions;
  - `memory_read` — a note by id (`m-xxxxxx`) with its evidence, or a past session entry (`s:<session>#<entry>`);
  - `memory_inbox` — keep something for the next dream; it becomes memory only after you approve it.
- **Commands**
  - `/memory` — what this session got from memory, and the server's status;
  - `/dream [status|run|review|dry|index|log|open]` — drive dreams on the server;
  - `/remember <text>` — put a note in the inbox yourself.
- **Flag** `--no-memory` — no injection and no memory tools for this run (also `WMEM_DISABLE=1`).

A pi session never waits on memory: calls have short timeouts, and without a server the session simply goes
without memory. When the server does not answer, the extension tries once to start it — the launchd agent of
`wmem service install` on macOS, else `wmem serve` if `wmem` is on `PATH` (`WMEM_NO_AUTOSTART=1` turns this off).
`WMEM_URL` points it at another server.

## License

MIT

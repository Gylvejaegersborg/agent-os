# Desktop activity (own HUD mode, part 1)

The "always watching" half of HUD mode. Hermes' HUD only looks when you ask;
this records what you actually do, so agents can learn how you work.

```
Windows                          agent-os gateway (127.0.0.1)
┌────────────────────┐  POST     ┌──────────────────────────────────────┐
│ desktop/sensor     │──spans──▶ │ core/desktop.ts                      │
│ foreground window  │  /desktop │  stream desktop:YYYY-MM-DD (JSONL)   │
│ + idle, privacy    │  /spans   │  → timeline, summary, digest         │
│ rules, offline     │           │  → bus: desktop.focus (on change)    │
│ spool              │           │  GET /desktop/now|timeline|summary   │
└────────────────────┘           │  MCP: desktop_activity               │
                                 └──────────────────────────────────────┘
```

## What is and isn't collected

Collected: process name, window title (after your privacy rules), start/end,
and idle stretches (from `GetLastInputInfo`, which says *when* you last
touched input, never *what*).

Never collected: keystrokes, typed text, clipboard, screenshots, audio. The
gateway refuses any span kind other than `active`/`idle`.

## Run it

1. Start the gateway as usual (`npm run gateway`, port 8787 by default).
2. On the same machine: `copy desktop\sensor\privacy.example.json desktop\sensor\privacy.json`
   and edit it (apps to hide, titles to hide, apps where only the name is kept).
3. `python desktop\sensor\sensor.py --dry-run` to see what it would send,
   then without `--dry-run`. Stdlib only — nothing to pip install.
4. Autostart: shortcut in `shell:startup` to `pythonw.exe <path>\sensor.py`.

Check it: `http://127.0.0.1:8787/desktop/summary` (add `?day=YYYY-MM-DD`).

## Projection

`desktopDaySummary(day)`: active/idle time, app switches, time per app, top
windows, focus blocks (≥25 min in one app, unbroken by idle or another app),
and time per BaseSpace project/goal — a window counts toward one when every
significant word of its name is in the title. Deliberately strict; titles
that match nothing are reported as unmatched rather than guessed.

## Tests

- `npm run test-desktop` — ingest, dedup, validation, merge, summary,
  matching, gateway routes, MCP tool.
- `python desktop/sensor/test_sensor.py [gateway-url]` — privacy, span
  tracking, idle back-dating, offline spool; with a URL, a live end-to-end post.

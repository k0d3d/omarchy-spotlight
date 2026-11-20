# 5. Usage bridge

Spotlight records usage for itself, but the log is designed as a shared file:
another shell plugin, a CLI tool, or an external app can write the same events
and get the same "For you" treatment without importing any QML.

There are two public surfaces:

- a **CLI** (`~/.local/bin/spotlight`) that appends to the log and aggregates it;
- an **IPC target** (`k0d3d.spotlight`) on the running shell, which goes through
  `Capture.qml` and therefore shares its dedupe, kill switch and debounce.

Both use the same schema. The UI never reads the log directly.

## Schema v1

```json
{
  "v": 1,
  "ts": 1795171109133,
  "type": "launch",
  "id": "app:helium",
  "source": "spotlight",
  "label": "Helium (0.21.3.1)",
  "appId": "helium",
  "data": { "profile": "work" }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `v` | number | written by writer | always `1` |
| `ts` | number | optional | Unix ms; invalid or missing becomes `Date.now()` |
| `type` | string | yes | see below |
| `id` | string | yes | stable, namespaced |
| `source` | string | optional | `spotlight`, `toplevel`, `cli`, or your tool's name |
| `label` | string | optional | human text; omitted when empty |
| `appId` | string | optional | desktop id; used for launch/focus dedupe |
| `data` | object | optional | free-form; stored but not interpreted by Spotlight |

### Types

```
launch  focus  open  action  custom  pin  unpin  dismiss
```

Only `launch` and `focus` are emitted today. `open` and `action` are reserved for
external producers. `custom` is the escape hatch for a producer's own id; it
still counts toward a row if that id matches a command.
`pin`, `unpin` and `dismiss` are in the schema but no UI emits them yet. They
increment the snapshot's raw `count`, but `smartPicks` excludes them from
frequency via `Storage.usageCount()`; `last` still includes their timestamps.

### Ids

The convention is namespace + stable identity:

| Producer | Example |
|---|---|
| app row | `app:org.gnome.Nautilus` |
| action row | `action:screenshot` |
| shortcut row | `shortcut:files` |
| external tool | `custom:my-tool.thing`, `app:Discord` |

The `app:` id must match the desktop-entry id `AppLibrary` uses (without the
`.desktop` suffix). If it does not, the event is stored and aggregated but
ignored by `smartPicks`, because there is no row to attach it to. Flatpak and web
apps are the usual source of mismatches; verify the id in
`~/.local/state/omarchy/spotlight/snapshot.json` after a real launch.

### Normalization rules

`Storage.normalize()` is the gate for in-shell and IPC writes:

- non-object input → `null` (rejected);
- unknown `type` → `null`;
- empty `id` → `null`;
- `ts` coerced to a positive finite number, rounded, or now;
- `source` trimmed, with a default;
- `label` / `appId` trimmed and omitted if empty;
- `data` must be a plain object (not an array), otherwise dropped;
- unknown keys are dropped.

The CLI form path (`--type … --id …`) performs the same type whitelist check in
bash. The `--json` path validates `type` against the same list (inside jq), so
an unknown type fails there too.

## CLI

The helper is bash + jq. It requires `jq`; `flock` is used when available.

```bash
spotlight --help
```

### `record`

Form path:

```bash
spotlight record \
  --type launch \
  --id app:Discord \
  --label Discord \
  --source my-tool
```

Options:

| Flag | Meaning |
|---|---|
| `--type` | one of the eight types; required unless `--json` |
| `--id` | namespaced id; required unless `--json` |
| `--label` | optional display label |
| `--source` | optional producer name; defaults to `cli` |
| `--data` | optional JSON object, must parse |
| `--json` | a whole event object instead of the form flags |
| `--no-snapshot` | append only; skip the automatic snapshot rebuild (works on both forms) |

The form path has no `--appId` flag. If you need `appId` (for the launch/focus
dedupe), use `--json`.

`--json` path:

```bash
spotlight record --json '{
  "type": "launch",
  "id": "app:Discord",
  "label": "Discord",
  "appId": "Discord",
  "source": "my-tool",
  "data": {"why": "external launcher"}
}'
```

The `--json` path:

- requires `type` and `id` to be non-empty strings;
- rejects a `type` that is not in the documented list;
- fills `v = 1` and a fresh `ts` if missing;
- keeps a non-empty `source`, otherwise uses `cli`;
- preserves `label`, `appId`, `data` and any other keys.

`record` appends exactly one line and then rebuilds `snapshot.json` by default.
Pass `--no-snapshot` when a producer is writing a burst and will run
`spotlight snapshot` once at the end:

```bash
for id in app:A app:B app:C; do
  spotlight record --type launch --id "$id" --no-snapshot
done
spotlight snapshot
```

If `~/.config/omarchy/spotlight.json` has `capture: false`, `record` prints
`spotlight: capture is off; event dropped` to stderr and exits 0 without writing.

### `snapshot`

```bash
spotlight snapshot
```

Reads `events.jsonl`, drops lines that do not parse, and writes
`snapshot.json.tmp.$$`, then renames it to `snapshot.json`. Safe to run at any
time. It is a full re-read, not an incremental update.

Each entry in `items` has this shape:

```json
{
  "count": 3,
  "last": 1795178384262,
  "types": { "launch": 2, "pin": 1 },
  "terms": [{ "term": "brv", "at": 1795178384262 }],
  "frecency": 200.99,
  "openedAt": 1795178384262
}
```

`count` is raw and includes bookkeeping events. `frecency` is derived, not
stored in the log: every event of a usage type adds
`exp(-ln(2)/10 · age_days)` and a visit is worth 100, so the number halves every
ten days. `terms` are the last 20 `data.query` values from `launch` events,
deduped by term, newest last. `openedAt` is the last event timestamp.

Because `frecency` and `terms` are derived, the log remains the source of truth:
deleting `snapshot.json` is always safe, and an older snapshot without those
fields still works (the UI falls back to `count`).

### `recent`

```bash
spotlight recent          # TSV: id <TAB> count <TAB> last, newest first
spotlight recent 5
spotlight recent --json 5 # JSON array with id/count/last/types
```

`recent` reads `snapshot.json`. It calls `ensure_snapshot`, which rebuilds only
when `events.jsonl` is newer than `snapshot.json` (or when the snapshot is
missing). Note that the `count` it reports is the snapshot's raw total; that
includes bookkeeping types. The smart block uses the filtered `usageCount`
instead.

Example TSV:

```
app:helium	16	1795171294030
app:io.github.lgse.Strata	7	1795171293277
app:ai.opencode.desktop	3	1795171289276
```

Example JSON:

```json
[
  {
    "id": "app:helium",
    "count": 16,
    "last": 1795171294030,
    "types": { "focus": 15, "launch": 1 }
  }
]
```

### `run`

```bash
spotlight run --chord "SUPER SHIFT + Q / XF86Calculator" --label "Calculator"
# ok	exec	omacalc
```

This is not part of the usage bridge; it is what Enter on a shortcut row calls.
It reads Omarchy's keybinding cache and dispatches the binding, so a bind that
`hyprctl binds` only reports as `__lua` still runs. `--label` is optional: with
only `--chord`, the first record whose chord matches wins.

Exit status is non-zero when the chord is unknown or the binding has no
dispatcher. The output is `ok<TAB>kind<TAB>arg` on success.

### `files`

```bash
spotlight files --query backup --limit 5
spotlight files                 # no query: recent files
```

```json
[
  { "path": "/home/u/Work/backup.ab", "name": "backup.ab", "dir": "~/Work" }
]
```

Backs the files lens. No query returns files modified in the last 30 days under
`$HOME` (newest first, dot paths and `node_modules` skipped). A query runs
`fd --fixed-strings --type f`, so it is a literal name match, not a regex, and
hidden/gitignored paths stay out.

### `stats`

```bash
spotlight stats
```

```json
{
  "events": 32,
  "ids": 7,
  "generatedAt": 1795171414493,
  "eventsPath": "/home/k0d3d/.local/state/omarchy/spotlight/events.jsonl",
  "snapshotPath": "/home/k0d3d/.local/state/omarchy/spotlight/snapshot.json",
  "configPath": "/home/k0d3d/.config/omarchy/spotlight.json",
  "capture": true,
  "focus": true
}
```

`events` is the number of valid events, not raw lines. The CLI and the IPC
handler now return the same fields: `events`, `ids`, `generatedAt`, both dev
paths, `configPath`, `capture` and `focus`.

### `capture`

```bash
spotlight capture        # prints the current flag: true / false
spotlight capture off
spotlight capture on
```

Reads and writes `~/.config/omarchy/spotlight.json`. It creates the file with
`{}` if missing. The read uses:

```bash
jq 'if has("capture") then .capture else true end'
```

not `.capture // true`. jq's `//` treats `false` as empty, so the short form
returns `true` for an explicit `false`. That was a real bug; see the dev log.

This flag now gates both paths: `Capture.record()` (UI launches, IPC `record`,
focus) and the CLI `spotlight record`. A CLI record with capture off prints
`spotlight: capture is off; event dropped` to stderr and exits 0. `--no-snapshot`
does not bypass the switch.

`captureFocus` is separate. Turning it off stops focus events while launches
from the Spotlight UI still record.

### `path`

```bash
spotlight path
# /home/k0d3d/.local/state/omarchy/spotlight
```

## IPC

The handler is declared in `Spotlight.qml`:

```qml
IpcHandler {
  target: "k0d3d.spotlight"

  function record(payloadJson: string): string { … }
  function recent(limit: string): string { … }
  function stats(): string { … }
  function state(): string { … }
  function focusNow(): string { … }
  function openedState(): string { … }
}
```

Call it through the shell socket:

```bash
omarchy-shell k0d3d.spotlight state
```

### Methods

| Call | Returns | Notes |
|---|---|---|
| `record '<json>'` | `"ok"` or `"error: …"` | goes through `Capture.record()`; subject to dedupe and kill switch |
| `recent <n>` | JSON array | reads the in-memory `usage` map, not the file |
| `stats` | JSON object | events/ids/generatedAt/paths/capture/focus |
| `state` | JSON object | debug state: writer, activeAppId, dedupe fields, ids |
| `focusNow` | JSON object | samples `ToplevelManager` now, then returns `state`; side effect |
| `openedState` | JSON object | `opened`, `lens`, `filter`, `rows`, `commands`, `smart` |

`record` example:

```bash
omarchy-shell k0d3d.spotlight record \
  '{"type":"launch","id":"app:Discord","label":"Discord","source":"my-tool"}'
# ok
```

`recent` example:

```bash
omarchy-shell k0d3d.spotlight recent 3
# [{"id":"app:ai.opencode.desktop","count":10,"last":…,"types":{"focus":10}}, …]
```

`state` example:

```json
{
  "enabled": true,
  "focusEnabled": true,
  "suspended": false,
  "writer": true,
  "activeAppId": "ai.opencode.desktop",
  "lastFocusId": "ai.opencode.desktop",
  "lastFocusAt": 1795171859516,
  "ids": 7
}
```

`openedState` example:

```json
{
  "opened": false,
  "lens": "all",
  "filter": "",
  "rows": 4,
  "commands": 78,
  "smart": {
    "forYou": [{ "id": "app:helium", "detail": "used 16×" }],
    "recent": [{ "id": "app:brave-browser", "detail": "4m ago" }]
  }
}
```

`openedState` is the quickest way to check that a keypress changed the lens or
filter without taking a screenshot: it reports the live `lens` and `filter`
alongside the row count.

### Focus capture rules

`Capture.qml` is deliberately conservative, because a noisy log makes every
"recent" list wrong:

- While the overlay is open, focus capture is suspended.
- On close, the app that was underneath is remembered and its next activation is
  ignored for 4 seconds. Closing Spotlight is not app usage.
- A second activation of the same app within 1.5 seconds is folded into one
  session.
- A `focus` event for an app launched from Spotlight within 15 seconds is
  dropped; the `launch` event already counted the intent.
- `k0d3d.spotlight` and `org.quickshell` are never recorded.
- Window titles are never stored; only the desktop `appId`.

### Two host constraints

1. **Parameters must be typed.** `record(payloadJson: string)` is accepted;
   `record(payloadJson)` is not. Quickshell logs a message like
   `Type of argument … cannot be used across IPC` and the handler does not
   register. This applies to `recent(limit: string)` too.
2. **The handler only exists while the plugin is loaded.** `keepLoaded: true`
   means it exists from shell startup. Without that, `state` before the first
   open would be `unknown`.

The shell's socket is user-scoped. Any process running as the same user in the
same session can call the target. Treat this as a convenience API, not a
privilege boundary.

## Files

| Path | Contents |
|---|---|
| `$XDG_STATE_HOME/omarchy/spotlight/events.jsonl` | one JSON object per line, append-only |
| `$XDG_STATE_HOME/omarchy/spotlight/snapshot.json` | aggregated map the UI reads |
| `$XDG_CONFIG_HOME/omarchy/spotlight.json` | optional capture flags |
| `~/.local/bin/spotlight` | the CLI |

Defaults are `~/.local/state/omarchy/spotlight/` and
`~/.config/omarchy/spotlight.json`. `Capture.qml` resolves `XDG_STATE_HOME` and
`XDG_CONFIG_HOME` at load time, and hard-codes the helper at
`$HOME/.local/bin/spotlight`. If you move the CLI, update `Capture.qml` or the
debounced rebuild stops working.

## Append-only, and where it is not perfectly concurrent

The log is append-only on purpose:

- a crash can lose at most the in-flight line;
- `tail -f` and a reader can see a prefix at all times;
- no rewrite means no window where the file is empty or half-written;
- the snapshot can be regenerated from the log at any point.

Write path details:

- `Capture.qml` keeps one `sh -c 'cat >> events.jsonl'` process alive and writes
  one line per event through stdin. If it dies, a 1 s timer restarts it; up to
  200 pending lines are buffered.
- The CLI uses `flock -w 2` on an append file descriptor when `flock` exists.
- The two writers do **not** share a lock. In practice, single-line appends with
  `O_APPEND` are atomic on local filesystems for normal line sizes. Do not treat
  that as a formal guarantee, and do not write huge lines.
- Aggregation writes a temporary file and renames. Two concurrent aggregations
  each produce a valid document; the last rename wins.

### Refresh matrix

| Action | Log | Snapshot | UI |
|---|---|---|---|
| UI launch / IPC `record` | appended | rebuilt after 1.2 s | sees it on the next snapshot load |
| `SUPER+SPACE` open | unchanged | a rebuild starts | `prepare()` + `refreshSmart()` on open; the reload lands when the process exits |
| CLI `record` | appended | rebuilt immediately | FileView reloads if the UI is running |
| CLI `record --no-snapshot` | appended | **unchanged** | unchanged until a rebuild |
| CLI `snapshot` | unchanged | rebuilt | FileView reloads if the UI is running |
| CLI `recent` / `stats` | unchanged | `ensure_snapshot` rebuilds if the log is newer | n/a |

`ensure_snapshot` compares `events.jsonl` to `snapshot.json` with `-nt`. If a
producer writes a burst, `--no-snapshot` plus one final `spotlight snapshot`
avoids a full jq pass per event; otherwise the default `record` keeps the
snapshot warm for every consumer.

## Kill switch

`~/.config/omarchy/spotlight.json`:

```json
{
  "capture": true,
  "captureFocus": true,
  "learnTerms": true
}
```

| Flag | Default | Effect |
|---|---|---|
| `capture` | `true` | gates `Capture.record()` (UI launches, IPC `record`, focus) **and** CLI `record` |
| `captureFocus` | `true` | gates only `captureFocus()`; launches still record |
| `learnTerms` | `true` | gates only `data.query` on a UI launch; usage still records |

Behavior:

- The file is watched; flipping it takes effect without a restart.
- `capture` is a hard gate in `record()`, so an IPC `record` returns
  `"error: rejected"` while off.
- A UI launch still launches when capture is off; only the event is dropped.
- The CLI prints `spotlight: capture is off; event dropped` to stderr and exits
  0; it does not append and does not rebuild the snapshot.
- Missing or unparseable file resets both flags to `true`
  (`Capture.applySettings()` handles the parse-failure path explicitly).

## Privacy

What is stored:

- which app (desktop id), when, and how many times;
- the event type and producer;
- an optional label (for app rows this can include a version string);
- an optional `data` object if a producer supplies one;
- **the query text that led to an app launch**, as `data.query`, when you type a
  filter and press Enter on an app. This is the one place typed text is stored.
  It is kept for 17 days of ranking, then ignored (the event line stays in the
  log until you clear it).

What is **not** stored:

- window titles;
- window contents;
- command lines;
- keystrokes typed into Spotlight beyond the query that launched an app;
- file paths — the files lens opens a file through `gio open` but does not
  record it, so the event log stays a timeline of apps, not documents;
- any network destination. Nothing in the capture path opens a socket.

The query rule is the only change to this list since 0.3.0. It exists because a
learned term is what makes `brv` keep meaning Brave. Two ways to opt out:

```json
{ "learnTerms": false }
```

in `~/.config/omarchy/spotlight.json` stops the query from being attached to a
launch. `capture: false` stops everything.

Consequences:

- The log is a timeline of app usage. Treat it like shell history: local,
  readable by the user, not encrypted.
- `label` and `data` are producer-controlled. Do not put secrets, tokens or
  document names in them.
- Focus events collapse multiple windows of the same app into one app id. That
  is a privacy feature and a product limitation.
- Search terms are plain text in `events.jsonl` and `snapshot.json`. If you would
  not want a query in your shell history, use `learnTerms: false`.

## Security boundary

The design decision is explicit: **event data is never executed**.

- An app row calls `AppLibrary.launch(row.appId, row.label)`. The id comes from
  the live catalog, not from the event.
- A shortcut row runs `spotlight run`, which resolves the chord against
  Omarchy's keybinding cache — the user's own Hyprland configuration, not an
  event.
- An action row runs the `action` string from
  `omarchy-menu.jsonc` / the user's extension file. That is the same command the
  stock menu would run for that row; the event log plays no part. `disabled`
  rows refuse to run.
- A file row runs `gio open -- <path>`; the path comes from the file search, not
  from an event.
- A `custom` id is stored and aggregated but never rendered when there is no
  command with that id. A `custom` event that reuses an existing `app:` id does
  contribute to that row's frequency: `smartPicks` keys on the id, and `custom`
  is one of the five usage types. `pin`/`unpin`/`dismiss` do not contribute to
  frequency.
- `data` is not interpreted anywhere in the UI.
- Invalid JSON lines are dropped by the aggregator.
- Unknown ids are ignored by `smartPicks`.
- There is no `eval`, no shell interpolation from an event, and no per-event
  command execution.

The boundary that matters: the four executable sources are the desktop entry
catalog, the Hyprland binding cache, the Omarchy menu definition and the file
path returned by `fd`. An event can change *what ranks first*; it cannot change
*what runs*.

The remaining trust assumptions:

- anyone who can write `events.jsonl` can inflate counts for an existing id;
- anyone who can reach the shell socket as the same user can call `record`;
- anyone who can edit `omarchy-menu.jsonc` or the Hyprland config can already
  run arbitrary commands, with or without Spotlight;
- the CLI runs with the user's privileges and trusts its arguments.

Those are normal for a local desktop tool, but they are worth stating before an
external app is pointed at the bridge.

## Integrating another plugin or app

### From bash / any language

```bash
spotlight record \
  --type launch \
  --id app:Discord \
  --label Discord \
  --source my-launcher
spotlight snapshot   # only if you need `recent` immediately
```

To read history:

```bash
spotlight recent --json 5 | jq -r '.[] | "\(.id)\t\(.count)\t\(.last)"'
```

### From another QML plugin

The other plugin already runs in the shell process. The simplest path is the
CLI, because it does not depend on Spotlight's internals:

```qml
Process {
  command: ["spotlight", "record", "--type", "launch",
            "--id", "app:Discord", "--label", "Discord",
            "--source", "my-plugin"]
  running: true
}
```

Or via the shell IPC, which goes through Spotlight's dedupe and kill switch:

```qml
Process {
  command: ["omarchy-shell", "k0d3d.spotlight", "record",
            '{"type":"launch","id":"app:Discord","label":"Discord","source":"my-plugin"}']
  running: true
}
```

Use the IPC form when you want the same behavior as the UI; use the CLI form when
you want the log to be written even if in-shell capture is disabled.

Do not import `Storage.js` from another plugin and write directly unless you also
take responsibility for the line format and the lock. The schema is stable; the
file is shared.

### From a long-running external app

Record at the moment of intent, not on a timer:

```python
import json, subprocess, time

def record_launch(desktop_id, label):
    event = {
        "type": "launch",
        "id": f"app:{desktop_id}",
        "appId": desktop_id,
        "label": label,
        "source": "my-app",
    }
    subprocess.run(
        ["spotlight", "record", "--json", json.dumps(event)],
        check=True,
        stdout=subprocess.DEVNULL,
    )

record_launch("Discord", "Discord")
```

For high-frequency events, batch at the application layer and write one CLI call
per meaningful action. A process spawn per keystroke is wasteful; a spawn per
launch is fine.

### Worked example: an external launcher that feeds Spotlight

Suppose `quick-launch` is a small script that starts Discord for you. Make it
record the intent so Discord rises in "For you":

```bash
#!/usr/bin/env bash
set -euo pipefail

spotlight record \
  --type launch \
  --id app:Discord \
  --label Discord \
  --source quick-launch

uwsm-app -- gtk-launch Discord.desktop
```

Then:

```bash
spotlight recent 3
```

The `record` above already refreshed the snapshot; `recent` would also rebuild
if it saw the log newer. Add `--no-snapshot` to the record if this script runs in
a loop and you will snapshot once at the end.

Illustrative output (your counts and ordering will differ):

```
app:Discord	7	1795172000000
app:helium	16	1795171294030
app:ai.opencode.desktop	10	1795171848609
```

Open Spotlight with an empty filter and Discord is in "For you" with
`used 7×`. If it is not, check:

1. `spotlight recent --json | jq '.[] | select(.id=="app:Discord")'` — is the id
   exactly what the catalog uses?
2. Is the app installed and visible in the Apps lens?
3. Was capture on when the record ran? (`spotlight capture`)
4. Is the UI reading a different `XDG_STATE_HOME`? The shell inherits the
   session environment; a terminal override does not affect it.

## Known gaps

These are real and currently unfixed:

- **No compaction.** `snapshot` re-reads the whole log; it grows forever.
- **No retention.** There is no "delete events older than N days" command, and
  no `spotlight reset`.
- **No per-id validation.** A typo in an `app:` id is silently ignored by the
  UI but still counted in `stats`.
- **Shell startup counts once.** `Capture.qml` calls `captureFocus()` in
  `Component.onCompleted`, so a shell restart records the app that happened to be
  focused as a `focus` event. Small noise, not a correctness issue.
- **Raw counts still include bookkeeping.** `recent` and `stats` report the
  snapshot's raw `count`, which includes `pin`/`unpin`/`dismiss`. The smart block
  uses the filtered `usageCount`; `last` still includes bookkeeping timestamps,
  so a pin can keep a row near the top of Recent.

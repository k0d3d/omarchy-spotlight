# 2. Architecture

## The shape in one diagram

```
                         keyboard / bar
                              │
        ┌─────────────────────┴──────────────────────┐
        │                                            │
  SUPER+SPACE / SUPER+K                       bar left-click
  (Hyprland Lua o.rebind)                     (BarWidget.qml)
        │                                            │
        └──────────────► omarchy-shell shell toggle k0d3d.spotlight '<json>'
                              │
                    PluginRegistry.resolveEnabledId
                              │
                    shell.toggle → summon / hide
                              │
                    Loader (manifest.keepLoaded = true)
                              │
                       Spotlight.qml  ──────────────┐
                              │                     │
             open(payloadJson) / close()            │
                              │                     │
              rows = Model.group(commands,          │
                                 lens,              │
                                 filterText,        │
                                 smart)             │
                              │                     │
                        ListView                    │
                                                    │
  ┌─────────────────────────────────────────────────┘
  │
  │  commands: Omarchy menu actions + live keybindings + AppLibrary entries
  │  smart:    { forYou, recent } from snapshot.json
  │
  ▼
Capture.qml (mounted at shell startup because keepLoaded)
  │
  ├─ ToplevelManager.activeToplevelChanged
  │     └─ captureFocus() ── gates ──► record({type:"focus", id:"app:<appId>"})
  │
  ├─ Spotlight.activate(row)
  │     ├─ app + open window → focus it (bringForward)
  │     ├─ app, no window    → AppLibrary.launch
  │     ├─ shortcut row      → spotlight run --chord … --label …
  │     ├─ file row          → gio open -- <path>
  │     └─ record({type:"launch" | "action", id, label})
  │
  └─ record() ── normalize ──► writer.write(line + "\n")
                                   │
                          sh -c 'cat >> events.jsonl'
                                   │
                          statsDebounce (1200 ms)
                                   │
                          Process: spotlight snapshot
                                   │
                          jq -R -s … > snapshot.json.tmp.$$
                          mv snapshot.json.tmp.$$ snapshot.json
                                   │
                          FileView (watchChanges) ──► usage
                                   │
                          Storage.smartPicks(usage, commands, Date.now())
                                   │
                                  smart
```

External writers take a shorter path:

```
spotlight record … ──► flock ──► events.jsonl
                                  │
                                  ├─ default: snapshot immediately
                                  └─ --no-snapshot: later `spotlight snapshot`
                                     or `recent`/`stats` (ensure_snapshot) rebuilds

omarchy-shell k0d3d.spotlight record '<json>'
        └─ IpcHandler ──► Capture.record() ──► writer + debounce (same as UI)
```

## Components

| Component | File | Runs where | Responsibility |
|---|---|---|---|
| Manifest | `manifest.json` | read by `PluginRegistry` | identity, kinds, entry points, `keepLoaded` |
| Surface | `Spotlight.qml` | shell process | overlay, input, lenses, keyboard, theme, IPC, app launch |
| Model | `Model.js` | shell process (also Node) | actions, keybinding parsing, grouping, matching, chord normalization |
| Storage | `Storage.js` | shell process (also Node) | schema, normalization, relative time, `smartPicks` |
| Capture | `Capture.qml` | shell process | event writer, snapshot loader, focus tracking, settings, dedupe |
| Bar entry | `BarWidget.qml` | shell process (bar) | toggle the surface; right-click opens a terminal |
| CLI | `~/.local/bin/spotlight` | user shell | record, aggregate, query, flip capture |
| Aggregate | `snapshot.json` | state dir | the only usage data the UI reads |
| Log | `events.jsonl` | state dir | append-only bridge format |

The shell-side pieces live in one process. There is no helper daemon. The CLI is
invoked as a short-lived process for aggregation.

## Lifecycle

### Startup

Because the manifest says `keepLoaded: true`, the shell's panel `Loader` is
active from startup, not only while the panel is open. `Spotlight.qml` is
constructed and `Capture.qml` runs `Component.onCompleted`:

```qml
root.rebuild()
root.captureFocus()
```

So the first snapshot rebuild and the first focus sample happen before the user
ever presses `SUPER+SPACE`.

### Open

The host calls `open(payloadJson)` with the JSON string from
`omarchy-shell shell toggle …`:

```qml
function open(payloadJson) {
  var payload = ({})
  try { payload = JSON.parse(payloadJson || "{}") } catch (e) { payload = ({}) }

  if (payload.lens) root.lens = String(payload.lens)
  else if (payload.menu === "shortcuts") root.lens = "shortcuts"
  else root.lens = "all"

  root.filterText = ""
  root.selectedIndex = 0
  root.prepare()          // static rows + AppLibrary entries
  root.refreshSmart()     // score against the current snapshot
  capture.beginSession()  // suspend focus capture, remember the app underneath
  capture.rebuild()       // freshen snapshot for the next read
  root.opened = true
  Qt.callLater(function() { filterInput.forceActiveFocus() })
}
```

Two details matter:

- `payload.lens` wins. `{"lens":"shortcuts"}` is what `SUPER+K` sends.
- With no lens payload, `open()` resets to `"all"`. `SUPER+SPACE` sends
  `{"menu":"root"}`, so it always opens Everything, even after a
  `SUPER+K` session.

`prepare()` rebuilds `commands` on every open, so newly installed apps appear
without a shell restart. While the surface is open, the
`AppLibrary.appsChanged` connection calls `prepare()` again, so an install also
shows up live. `capture.beginSession()` stores the app underneath and suspends
focus capture before the overlay takes keyboard focus, so the focus change
caused by opening is not counted as usage.

### Close

```qml
function close() {
  root.opened = false
  root.filterText = ""
  capture.endSession()
}
```

`endSession()` clears the suspend flag, remembers the app underneath, and
suppresses that app's next activation for 4 seconds. That is what prevents the
"close the overlay → the app underneath gains focus → count it" false positive.
The 1.5 s same-app dedupe in `captureFocus()` is the second line of defense.

The shell asks the plugin whether it is open through the `opened` property:

```js
var loader = panelLoaders[id]
if (loader && loader.item && loader.item.opened !== undefined)
  return loader.item.opened === true
```

That is why `opened` is a property, not an internal variable.

## The shortcut catalog

Shortcuts are not hand-maintained. At startup, and again when the overlay opens
if the list is older than 30 seconds, `Spotlight.qml` runs:

```bash
omarchy menu keybindings --print
```

That command already merges the shipped bindings, the user's
`~/.config/hypr/bindings.lua` overrides and app-level binds, and omits internal
binds without descriptions. `Model.parseShortcutLine()` splits each line on
`→`, normalizes the chord's whitespace, and gives the row a stable id:

```js
"shortcut:" + slug(label) + ":" + slug(chord)
// SUPER SHIFT + F → File manager
// shortcut:file-manager:super-shift-f
```

Ids are deduped during the scan. The last successful scan is kept if the
command fails, and a small static shortcut list is used only until the first
scan lands or when the command is unavailable. On this machine the live catalog
is 249 rows; with actions and apps the overlay carries about 316 commands.

The rows are streamed through `SplitParser`, so the UI is not blocked while the
list arrives. If the overlay is already open when the scan finishes,
`prepare()` rebuilds `commands` with the new rows.

## The command row

Every visible row is a plain object with this shape:

```js
{
  id: "shortcut:file-manager:super-shift-f", // stable, namespaced
  kind: "app" | "action" | "shortcut",
  label: "File manager",
  icon: "\uf07b",                // Nerd Font glyph for non-app rows
  chord: "SUPER + SHIFT + F",    // empty when there is none
  detail: "Open",                // right-aligned secondary text
  aliases: [],                   // optional extra search terms
  section: "Shortcuts",          // added by Model.row()
  // app rows only:
  appId: "org.gnome.Nautilus",
  appIcon: "org.gnome.Nautilus",
  appIconPath: "file:///…"
}
```

`Model.row()` clones the command and adds `section`. It only overrides `detail`
when a non-empty override is supplied, which is how smart rows get
`"used 16×"` or `"4m ago"` without mutating the catalog.

Apps are appended by `Spotlight.prepare()`:

```js
var entries = lib.sortedEntries("")
for (var i = 0; i < entries.length; i++) {
  var entry = entries[i].entry
  var id = String(entry.id || "")
  if (!id) continue
  var iconName = String(entry.icon || "")
  list.push({
    id: "app:" + id,
    kind: "app",
    label: lib.entryName(entry),
    appId: id,
    appIcon: iconName,
    appIconPath: lib.iconSource(iconName),
    chord: "",
    detail: lib.entrySubtext(entry) || "",
    aliases: []
  })
}
```

Note the id namespace: `app:org.gnome.Nautilus`. The static rows use
`action:*` and `shortcut:*`. Everything in the log uses the same namespace, so
`app:Discord` from an external writer resolves to the same row as the one the
catalog builds.

## Event schema (v1)

The canonical definition is `Storage.normalize()` in `Storage.js`.

```json
{
  "v": 1,
  "ts": 1795171109133,
  "type": "launch",
  "id": "app:helium",
  "source": "spotlight",
  "label": "Helium (0.21.3.1)",
  "appId": "helium",
  "data": { "optional": "consumer-specific" }
}
```

| Field | Required | Rules |
|---|---|---|
| `v` | written by writer | forced to `1` |
| `ts` | optional | number, ms since epoch; invalid/missing → now |
| `type` | yes | one of `launch focus open action custom pin unpin dismiss` |
| `id` | yes | non-empty string, ideally namespaced |
| `source` | optional | defaults to `"spotlight"` for in-shell events, `"cli"` for the CLI form path, `"unknown"` in `normalize` |
| `label` | optional | trimmed; omitted when empty |
| `appId` | optional | trimmed desktop id; used to suppress the launch follow-up focus |
| `data` | optional | plain object; stored, not interpreted by the UI |

Unknown keys are dropped. That is deliberate: the file is a shared bridge, so it
only carries fields every consumer agreed on. Anything consumer-specific belongs
inside `data`.

Validation in the UI path is strict. The CLI's `--type/--id` form path validates
the type against the same list. The CLI's `--json` path validates only that
`type` and `id` are non-empty strings — an undocumented type can land in the
log. See [05-usage-bridge.md](05-usage-bridge.md).

## Snapshot schema

`spotlight snapshot` reads every line of `events.jsonl`, discards lines that do
not parse, and reduces them into:

```json
{
  "v": 1,
  "generatedAt": 1795171414493,
  "events": 32,
  "items": {
    "app:helium": {
      "count": 16,
      "last": 1795171294030,
      "types": { "focus": 15, "launch": 1 }
    }
  }
}
```

Semantics, from the jq program in `cmd_snapshot()`:

- `events` is the number of **valid** event lines, not the number of raw lines.
- `count` increments for every valid event with that id, regardless of type.
  `count` is the raw total; `smartPicks` does not use it directly.
- `last` is the maximum `ts` seen for that id, regardless of type.
- `types` counts each type separately.
- Ids are arbitrary strings. There is no filtering at aggregation time; unknown
  ids are kept in the snapshot and ignored by the UI.

The aggregation is intentionally dumb. It does not know which ids are apps, and
it does not need to.

## Smart picks

`Storage.smartPicks(signals, commands, now)` is called by
`Spotlight.refreshSmart()` with the snapshot's `items` map and the current
catalog.

Frequency comes from `Storage.usageCount()`, which sums only the usage types:

```
launch  focus  open  action  custom
```

`pin`, `unpin` and `dismiss` are bookkeeping. They are in the schema and they
still increment the snapshot's raw `count`, but they do not make a row look more
frequent. `last` is still the snapshot's maximum timestamp across all types, so
a bookkeeping event can keep a row near the top of "Recent" even though it does
not add frequency. That is a deliberate Phase 0 simplification; see the roadmap.

Step by step:

1. Build `byId` from `commands`.
2. For every id in `signals`:
   - skip if there is no matching command;
   - skip unless `kind` is `app`, `action` or `shortcut` (this is where ids with
     no matching command die, including `custom:*` ids and apps that were
     uninstalled);
   - compute `count = usageCount(signal)` and skip if `count <= 0` or
     `last <= 0`.
   - use the snapshot's `frecency` as the weight; fall back to `count` when an
     older snapshot has no `frecency`.
3. Sort candidates by weight descending, then `last` descending.
4. Take up to 3 for **For you**, with `detail: "used N×"`.
5. Sort all candidates by `last` descending.
6. Take up to 3 **not already in For you** for **Recent**, with
   `detail: relativeTime(last, now)`.
7. Return `{ forYou, recent }` as arrays of `{ id, detail }` (not row objects).

Then `Model.group()` maps those picks back to rows via `findById`. A pick whose
command disappeared between the two steps is dropped again, so the renderer
cannot produce a dead row.

Two consequences worth knowing:

- **Recent is not always three items.** It excludes For you ids and unknown ids.
  On this machine with seven known ids it is often one or two.
- **A `custom` event is still an id, not a rendering rule.** If it reuses an
  existing `app:` id, it contributes to that row's filtered count. A `custom:*`
  id with no command row is ignored.

### Cold start

If `smartPicks` returns nothing, `Model.group()` uses the curated arrays still
present in `Model.js` (`FOR_YOU` and `RECENT`) as demo data. Those ids are
matched against the live catalog, so an id that is not installed is simply not
shown. If fewer than three rows result, it fills with real app rows up to six.
The fill is split at the three-row boundary: rows pushed while `out.length < 3`
are labeled "For you", the rest "Recent".

That is why a fresh install shows a plausible block instead of an empty one, and
why uninstalling an app never leaves a blank row behind.

## Query pipeline

```
FilterInput.text
  │
  ▼
Spotlight.setFilter(text)
  ├─ leading "?" → lens = shortcuts, strip
  ├─ leading "@" → lens = apps,      strip
  ├─ leading ">" → lens = actions,   strip
  ├─ changed text → filterText = stripped, selectedIndex = 0
  └─ changed lens → lens = …, selectedIndex = 0
  │
  ▼
Model.group(commands, lens, filterText, smart, usage)
  ├─ pool = lens === all ? commands : commands of that kind
  ├─ needle = filterText trimmed
  ├─ empty needle + lens === all → smart/curated/cold-start block
  ├─ empty needle + other lens    → rankPool(pool, "") then take 16, one section
  └─ non-empty needle
       ├─ rankPool → toCandidate(row, usage) for each, then Ranker.rank()
       │    ├─ title, subtitle and keywords scored by fuzzyMatch
       │    ├─ alias exact/prefix, learned search terms
       │    └─ buckets: pinned+text, pinned, text, rest
       └─ output:
            lens === all → grouped by kind, sections ordered by their best match
            otherwise    → one section named after the lens
```

Ranking replaced substring matching in 0.4.0. The old `haystack().indexOf()`
approach was precise but literal: `mv win` and `fullscren` returned nothing, and
"workspace 10" sorted before "workspace 2". See [Ranking](#ranking) below.

## Ranking

`Model.js` carries a port of Raycast's root-search algorithm, adapted from
[omacast](https://github.com/typecraft-dev/oma-cast) (MIT; notice in
`LICENSES/omacast-MIT.txt`). QML cannot import one `.js` file from another, so
the ranker lives in `Model.js` rather than its own module. The section is marked
and kept close to upstream so it stays diffable.

The shape matters more than any single number:

- **Dynamic programming, not substring search.** `fuzzyMatch()` walks the query
  against the target and keeps the best path. A cell scores 4 at index 0, 3 at
  a word boundary, 2 mid-word and 1 when it matches a separator, minus 1 for
  any jump. That is why `fs` finds *Full screen*, `mw` finds *Move window* and
  `mv win` finds *Move window*.
- **Separators are part of the query.** A space or `+` in the query matches a
  separator in the target, so chord text can be typed with words.
- **Buckets before comparison.** Records are split into pinned+text, pinned,
  text and rest. Frecency can reorder inside a bucket but cannot pull a weak
  match above a strong one.
- **Exactness has classes.** Exact alias beats exact search term, which beats
  exact title, which beats exact subtitle, which beats prefix matches. Only
  then do match scores, frecency and name order decide.
- **Natural collation.** `collate()` compares numeric runs, so workspace 1…10
  stay in order. It is written out instead of `localeCompare({numeric:true})`
  because Qt is not guaranteed to honour that option.

### Local deviations

Upstream is tuned for macOS app names; a few rules are adjusted for a catalog
that is mostly commands:

| Change | Why |
|---|---|
| One- to three-letter queries match **titles only**, with a fixed score floor | A flat 1-per-jump penalty means long keyword strings match almost any two letters (`ff` hit "folder manager … filesystem") |
| Chords are searched only when the query starts with a modifier (`super`, `sup`, `ctrl`, `alt`, `shift`, `print`, `fn`) | Otherwise `calc` matched every binding containing CTRL and ALT |
| The four- and five-letter threshold is `2 × len`, not upstream's curve | Stops scattered matches like `calc` → "Cycle workspace layout back" |
| A title that starts with the query outranks a whole-word hit later in it | Upstream's whole-word bonus is 0.5 above a start-of-title match, so `calc` put "LibreOffice Calc" first |
| Keyword-match scores are compared | Upstream discards them, leaving keyword-only hits in alphabetical order |
| Equal scores prefer the shorter title | `mw` ranked "Make webcam overlay larger" above "Move window" by collation alone |
| Learned terms also **recall** a row, not just reorder it | Spotlight records the query on launch; a term that can never surface its row is a dead feature |

### Frecency

Each usage event contributes `exp(-λ · age_days)` with `λ = ln(2)/10`, and a
visit is worth 100. The snapshot stores the summed result as `frecency`, so a
row loses half its weight every ten days. The event log stays the source of
truth; `frecency` is derived on every rebuild, never written by the UI.

This is why `For you` is frecency-led rather than count-led: ten launches from
a year ago no longer outrank a habit from this week. Snapshots written before
0.4.0 have no `frecency` field and fall back to the raw count.

### Learned terms

When a row is launched from Spotlight with a non-empty query, the launch event
carries `data.query`. The snapshot keeps up to 20 terms per id with an `at`
timestamp. During ranking, a term matches exactly, as a prefix, or as an
"overbounds" prefix (query is the term plus 1–3 characters). A term is only
considered while the row's frecency is above 1 and the last open is inside
17 days, so a stale habit fades.

The optimistic case: type `brv`, pick Brave once. From then on `brv` recalls
Brave even though the letters are a loose match. Type nothing for three weeks
and the term expires.

## The command row

## Actions

The actions lens is not a hand-written list. Omarchy ships a declarative menu
tree:

```text
$OMARCHY_PATH/default/omarchy/omarchy-menu.jsonc         353 actions
~/.config/omarchy/extensions/omarchy-menu.jsonc          user extensions
```

Each item is an object keyed by a dotted id. The presence of `action` makes it a
command; `target` is a link; otherwise it is a submenu. The stock menu runs the
same strings.

`Model.parseMenu()` strips JSONC line comments and trailing commas, parses, and
normalizes each item. `mergeMenu()` concatenates defaults then user items by id:
an extension that only sets `label` keeps the inherited `action`, which is how
`o.rebind`-style overrides are meant to behave.

Only items with an `action` become rows. Their `detail` is the breadcrumb built
from parent ids (`appearance.windows.corners.theme` → *Appearance › Windows ›
Window Corners*), which is what makes four rows all called "Theme"
distinguishable.

### Guards

`when`, `checked` and `disabled` are shell conditions. Evaluating them one
process at a time would be slow, so `guardScript()` emits one bash script with
the conditions spread across eight background buckets:

```bash
{ if { [[ … ]] ; } >/dev/null 2>&1; then echo 'appearance.theme:w:1'; else echo '…:0'; fi; } &
…
wait
```

`parseGuards()` reads the `id:w:1` / `id:d:1` lines. `when` false hides the row;
`disabled` true keeps it, appends ✓, and makes Enter refuse. On this machine that
is 353 items → 267 visible, 86 hidden by `when`, 6 install rows marked set up,
in about 0.8 s: once at startup, then on every open, so toggle rows show the
current state.

Rows also carry their index in the menu file as `sortHeuristic`, so an empty
Actions lens reads System → Appearance → … rather than alphabetically. The
ranker only uses it as a tie-break, so a typed query still wins on text.

Before the files load, the seven rows in `staticCommands()` fill the first frame.
They are a fallback, not the catalog.

## Activation

`Spotlight.activate(index, forceNew)` is the only place a row becomes an
action. It branches by `kind`:

| Row | What happens |
|---|---|
| app, window open | focus that window (restore if minimized, switch workspace, raise) |
| app, no window | `AppLibrary.launch(appId, label)` |
| app, `Shift+Enter` | always launch a new instance |
| shortcut | `spotlight run --chord … --label …` |
| action | `bash -lc "<action from omarchy-menu.jsonc>"` |
| file | `gio open -- <path>` |

Every branch records one event first: `launch` for apps, `action` for
shortcuts. The query rides along as `data.query` when `learnTerms` is on, which
is what feeds learned terms.

### Focusing a window instead of duplicating it

Windows are matched the same way the dock matches them:

```js
var entry = DesktopEntries.heuristicLookup(toplevel.wayland.appId)
if (entry && String(entry.id) === row.appId) …   // same app
```

`Hyprland.toplevels.values` gives `wayland.appId`, `workspace` and `address`.
Candidates are ordered focused → not minimized → on the active workspace, so
the window you were last in wins.

The dispatch itself cannot just run: while the overlay's layer surface holds
keyboard focus, Hyprland refuses to focus another window, and it refocuses the
previous one when the layer unmaps. `bringForward()` therefore closes the
overlay first and runs a small bash loop that waits for the
`k0d3d-spotlight` namespace to disappear, then dispatches `hl.dsp.focus` and
`hl.dsp.window.alter_zorder`, retrying for half a second. A minimized window is
moved back to the active workspace first with `no_anim` set, so it reappears
without a slide-in. If the window never takes focus, the script exits and
nothing is launched — the user still has the window.

One detail matters for windows on other workspaces: Quickshell's
`HyprlandToplevel.address` is the bare address (`55f37583a100`), while
Hyprland's dispatchers want the `0x` form. `windowsFor()` normalizes it before
building a row, and `bringForward()` normalizes again defensively; without that,
`address:55f…` is "window not found" and the focus silently does nothing.

This is the omacast `AppFocuser` idea, but expressed with the shell's own
`Hyprland` service instead of parsing `hyprctl clients` JSON.

### Running a shortcut

A shortcut row's label describes a keybinding, not a command. The binding is
resolved by `~/.local/bin/spotlight run`, which reads Omarchy's own cache:

```
~/.cache/omarchy/keybindings-<hash>.records
CHORD → LABEL <TAB> kind <TAB> arg
```

That cache is the thing that makes this work at all. `hyprctl binds -j` reports
most Omarchy binds as `dispatcher: "__lua", arg: "57"` — an index into the Lua
config, useless outside it. Omarchy's menu resolves those by evaluating the Lua
source with a stub, and records either the command (`exec`) or the Lua
expression (`lua`). Spotlight reuses that resolution:

| kind | dispatch |
|---|---|
| `exec` | `hl.dsp.exec_cmd("…")` (the legacy `dispatch exec <cmd>` form is broken on a Lua-config Hyprland) |
| `lua` | `hyprctl dispatch "<expression>"` |
| `sendshortcut` | `hl.dsp.send_key_state` down/up, with the legacy dispatcher as fallback |

The cache is refreshed whenever Spotlight scans
`omarchy menu keybindings --print`, so a rebind is picked up on the next open.
If the cache is missing, the CLI rebuilds it by running the print mode once.

Nothing here evals event data. The command comes from the user's own Hyprland
configuration, through Omarchy's resolver, and is dispatched by Hyprland itself.

## Files

There is no file index in the shell process. The files lens asks the bridge:

```bash
spotlight files --query <text> --limit 20
spotlight files                        # no query: recent files
```

- **No query** — `find` under `$HOME`, files modified in the last 30 days,
  depth 8, skipping dot paths and `node_modules`, sorted by mtime.
- **Query** — `fd --fixed-strings --type f`, which ignores hidden and
  gitignored paths by default. Fixed strings means a query like `(` is a
  literal, not a broken regex.

QML debounces the call by 220 ms and only runs it when it can matter: the files
lens, or Everything with at least three characters. Results are merged at render
time (`Model.group(..., root.fileResults)`), never stored in `commands`, because
they change with every query.

Everything appends a **Files** section after the ranked groups; the files lens
shows files only. The empty Everything view never includes files.

Opening is `gio open`, so the desktop's `mimeapps.list` decides. On this machine
`image/png` is bound to Omaroll, so Enter on a PNG opens the image viewer. No
MIME table lives in Spotlight, and a `.desktop` or script is opened, not
executed.

File paths are not recorded as usage. The event log is a timeline of app
activity; putting paths in it would turn the bridge into a record of documents.

## Rebuild and concurrency

The writer is one long-lived process per shell:

```qml
Process {
  command: ["sh", "-c", "mkdir -p \"$1\" && exec cat >> \"$2\"", "sh", stateDir, eventsPath]
  stdinEnabled: true
  running: true
  onStarted: root.flush()
  onExited: writerRestart.restart()
}
```

- Every event is serialized as one line and written with one `write()`.
- If the writer is not running, lines go into `pending` (capped at 200) and the
  process is restarted.
- The CLI uses `flock` around its append. The QML writer does not take that
  lock; it relies on `O_APPEND` and small single-line writes. In practice this
  is fine for normal line sizes, but it is not a shared lock across both
  writers. Do not write multi-megabyte lines.
- Aggregation is debounced 1200 ms, so a launch plus its follow-up focus pays for
  one rebuild, not two.
- Only one snapshot process runs at a time. A request while one is running sets
  `rebuildQueued`, and the completion handler starts the next one.
- The CLI writes `snapshot.json.tmp.$$` and renames it into place. Readers never
  see a half-written JSON document. Two concurrent aggregations may race on the
  rename, but each result is internally consistent; the last one wins.
- `spotlight record` rebuilds the snapshot after appending. `--no-snapshot`
  skips that for bursty producers.
- `spotlight recent` / `spotlight stats` call `ensure_snapshot`: rebuild only
  when `events.jsonl` is newer than `snapshot.json`.
- `FileView` watches `snapshot.json` and reloads on change, so an external
  `spotlight snapshot` updates a running UI.

## Settings

`Capture.qml` watches `~/.config/omarchy/spotlight.json`:

```json
{
  "capture": true,
  "captureFocus": true,
  "learnTerms": true
}
```

- Missing or unparseable file → all three flags reset to `true`.
  `applySettings()` handles the empty/parse-failure path explicitly, so deleting
  the file is a real "back to defaults", not "keep the last kill switch".
- `capture: false` gates `Capture.record()` (UI launches, IPC `record`, focus)
  and the CLI `record` command.
- `captureFocus: false` gates only `captureFocus()`; launches from the UI still
  record.
- `learnTerms: false` drops `data.query` from a UI launch. The event still
  records; the row just never learns the term.
- The file is hot-reloaded (`FileView.watchChanges`), so `spotlight capture off`
  takes effect without a restart.

## Failure behavior

| Failure | What happens |
|---|---|
| `spotlight` helper missing | `snapshotProcess` exits nonzero; the old snapshot stays; the UI keeps working with stale data |
| `jq` missing | CLI commands fail loudly with `spotlight: jq is required`; the UI is unaffected until it tries to rebuild |
| Malformed line in `events.jsonl` | dropped by `fromjson? // empty`; the rest of the file still aggregates |
| Corrupt/missing `snapshot.json` | `loadSnapshot()` sets `usage = {}`; the UI falls back to cold-start rows |
| Corrupt/missing `spotlight.json` | `applySettings()` resets both capture flags to `true` |
| Writer process dies | `writerRestart` retries every 1 s |
| `AppLibrary` throws | `prepare()` logs `spotlight: app catalog failed:` and keeps the static rows |
| Invalid `open` payload | caught; defaults to `{}` |

The UI never crashes on bad usage data; it just shows less.

# 8. YouTube demo script

A build-log video, not a launch trailer. The interesting part is the wiring, so
the camera should spend time on the host contract, the real log, and the two
bugs that cost the most time.

Format: 1080p, 60 fps if the compositor allows it, one screen, terminal at
16–18 px. Record the overlay and the terminal in the same take where possible;
cutting between them hides the latency that makes the demo believable.

Total runtime: ~14 minutes. A 60-second cut is at the end.

## Pre-flight

Do this before recording, not on camera:

```bash
# Capture is on and the log is live
spotlight capture
spotlight stats

# A few real events so "For you" is not empty
tail -n 5 ~/.local/state/omarchy/spotlight/events.jsonl

# The temp dir used by the CLI demo
rm -rf /tmp/spotlight-demo
```

Screen hygiene:

- Close personal chat, mail and anything with a token in the title bar.
- Turn off notifications with the shell's DND toggle (do not assume `makoctl` is
  installed).
- Do not show `~/.ssh`, browser profiles, or the inside of a password manager.
- Keep the terminal prompt short; a long path eats the frame.
- Do not restart the shell during the recording. If you must, do it before the
  first take.

`SUPER+SPACE` now resets to Everything, so the hook is reproducible even after
a `SUPER+K` take. No lens-reset workaround is needed.

## Run of show

| Time | Screen | Beat |
|---|---|---|
| 0:00 | overlay | hook: type a chord, get a shortcut |
| 0:25 | terminal + `/usr/share` | constraints: read-only host, one manifest |
| 1:40 | `Model.js` | wireframe: rows are a projection |
| 3:00 | overlay + `shell.json` | host integration: `open`/`close`, `OverlayWindow`, bar |
| 4:30 | `Model.js` + node | typeahead internals: fuzzy match, ranker, deviations |
| 6:00 | `events.jsonl` | real capture: focus, launch, no titles |
| 8:00 | terminal | bridge: CLI + IPC + snapshot |
| 10:30 | code + terminal | failure stories: `clonedFrom`, jq `false`, typed IPC, loop |
| 12:30 | code | roadmap: pins, window focus, pacman, transitions |
| 13:40 | overlay | close: the surface teaches its own chords |

## Scene 1 — Hook (0:00–0:25)

**On screen:** the desktop with a normal window focused. Press `SUPER+SPACE`.
The card appears centered; the input is focused.

Type, slowly enough to read:

```
super shift f
```

The list narrows to **File manager** with `SUPER + SHIFT + F` on the right.

Sigils only work at the start of the input, so clear the filter first. Press
`Esc` once (clears the query, stays in Everything), then:

```
?
```

The chip changes to **Shortcuts**. Type `sup`, press `Esc` to clear, then `@`
(Apps), `Esc`, `>` (Actions) to show the chip cycling. Press `Tab` once, then
`Esc` twice to close.

**Say:**

> This is one input over five lenses: everything, apps, actions, shortcuts,
> files. The trick is that the chords are searchable text, so I can type the
> keybinding I half remember and get the row even if I never opened the
> shortcuts lens.

Enter is real in 0.6.0: apps launch or focus, shortcuts run their bindings,
actions run Omarchy's own menu commands, and files open in their default app.

## Scene 2 — Constraints (0:25–1:40)

**On screen:** terminal.

```bash
ls -l /usr/share/omarchy/shell/plugins/menu/
wc -c /usr/share/omarchy/shell/plugins/menu/Menu.qml \
      /usr/share/omarchy/shell/plugins/menu/MenuModel.js
```

Point at root ownership (the files live under `/usr`, so you cannot write them
without sudo) and the 65 KB + 29 KB numbers.

```bash
ls -l ~/.config/omarchy/plugins/k0d3d.spotlight/
cat ~/.config/omarchy/plugins/k0d3d.spotlight/manifest.json
omarchy plugin validate ~/.config/omarchy/plugins/k0d3d.spotlight
```

**Say:**

> The host is read-only and it updates. Forking a 65-kilobyte menu means merging
> it forever. A plugin is one directory and one manifest, and the shell validates
> it with the same rules it uses to load it.

Show the manifest's `kinds` and `keepLoaded`:

> `menu` gives me the overlay lifecycle and the app catalog. `bar-widget` gives
> me the button. `keepLoaded` is why the usage capture runs before I ever open
> the surface.

## Scene 3 — The first wireframe (1:40–3:00)

**On screen:** `Model.js`.

Show the parser for the live keybinding catalog and the menu tree:

```bash
cd ~/.config/omarchy/plugins/k0d3d.spotlight
grep -n "function parseShortcutLine" -A18 Model.js
grep -n "function parseMenu" -A6 Model.js
```

```bash
omarchy menu keybindings --print | wc -l
omarchy menu keybindings --print | grep -i "ocr"
omarchy menu keybindings --print | grep -i "move window" | head -3
grep -c '"action"' /usr/share/omarchy/default/omarchy/omarchy-menu.jsonc
```

**Say:**

> The first shortcut lens was eleven hand-written rows. I searched `ocr` and got
> nothing, even though `SUPER CTRL + PRINT` exists. So the catalog now comes from
> the same print mode the keybindings menu uses: 249 rows here, including user
> overrides. That is also why `move window` suddenly has 31 results.

Show the cold-start fallback arrays with `"recently"`, `"used 14×"`,
`"2 min ago"`:

```bash
grep -n "var FOR_YOU" -A10 Model.js
```

**Say:**

> The first version was fake on purpose. The renderer took a flat array of rows
> and did not know whether the data was real. Those arrays are still the
> cold-start fallback. When the snapshot has history, the same shape comes from
> `smartPicks` instead.

Show the projection:

```bash
grep -n "function group" -A45 Model.js
```

**Say:**

> Rows are a pure function of four things: the catalog, the lens, the query and
> the smart block. No row owns state. That is why I could replace the fake
> recents without touching the delegate, and why I can test the whole thing in
> Node.

## Scene 4 — Host integration (3:00–4:30)

**On screen:** `shell.json` and the overlay.

```bash
jq '.bar.layout.left, .bar.layout.center, .cloneSourceRestores, .plugins, .disabledPlugins' \
  ~/.config/omarchy/shell.json
```

Point out:

- `omarchy.menu` in `left`, the system menu;
- `k0d3d.spotlight` in `center`, beside the clock, with the magnifier glyph;
- `cloneSourceRestores` only contains `custom.media`;
- `plugins: []`;
- neither menu is in `disabledPlugins`.

```bash
omarchy plugin list | grep -E 'spotlight|omarchy.menu'
```

Both read `enabled`. The stock button stays on purpose: removing its bar
placement makes Omarchy report it as disabled and the theme/background/power
routes stop being reliable.

Then open with the exact command the keybinding runs:

```bash
omarchy-shell shell toggle k0d3d.spotlight '{"menu":"root"}'
```

Close with `Esc`.

**Say:**

> The shell owns the loader. My plugin only has to implement `open(payloadJson)`,
> `close()`, and an `opened` property. `toggle` checks `opened` to decide whether
> to summon or hide. The surface is an `OverlayWindow`: exclusive keyboard,
> focused monitor, scale-safe reveal. I did not write a layer-shell window.

Show the two rebinds:

```bash
grep -n "spotlight" ~/.config/hypr/bindings.lua
```

**Say:**

> Two `o.rebind` lines. Spotlight is the primary launcher; the stock menu keeps
> its system button and still answers `omarchy menu …` for theme, background and
> power. That coexistence, without cloning the id, is the point.

## Scene 5 — Typeahead internals (4:30–6:00)

**On screen:** `Model.js` and a Node one-liner.

```bash
grep -n "function fuzzyMatch" -A12 Model.js
```

Show the score table in the comment above the algorithm: 4 at index 0, 3 at a
word boundary, 2 mid-word, 1 on a separator, minus 1 for a jump.

```bash
/usr/bin/node -e "
const Model = require('./Model.js')
for (const [t,q] of [['Full screen','fs'],['Move window','mv win'],['Brave','brv']])
  console.log(q.padEnd(8), JSON.stringify(Model.fuzzyMatch(t,q)))
"
```

Output:

```text
fs       {"score":6,"skipped":0}
mv win   {"score":12,"skipped":0}
brv      {"score":7,"skipped":0}
```

**Say:**

> This is a port of Raycast's root-search algorithm, adapted from omacast, which
> is MIT and does the same clean-room port. I kept the code in one file because
> QML cannot import one `.js` module from another, and I marked the section so a
> future diff against upstream is readable.
>
> The old version was `haystack.indexOf(query)`. Literal. `mv win` returned
> nothing. This walks the query against the title and keeps the best path, so
> `mv win` finds Move window and `fullscren` finds Full screen.

Show the deviations as a table on screen (from `docs/02-architecture.md`):

> Four things upstream gets wrong for a command catalog. Two-letter queries hit
> long keyword strings, so short queries are title-only. Every chord used to be
> a keyword, so `calc` matched CTRL ALT C; chords are searched only when the
> query starts with a modifier. A whole-word hit beat a title prefix by half a
> point, which put LibreOffice Calc above Calculator. And keyword-only rows fell
> back to alphabetical order.

Mention the mise shim:

```bash
node -v        # mise error in this environment
/usr/bin/node -v
```

> Use the real binary. The pure-JS layer is the reason I can test this without
> touching the shell, and there are sixteen tests in `tests/`.

## Scene 6 — Real recents (6:00–8:00)

**On screen:** a terminal running:

```bash
tail -f ~/.local/state/omarchy/spotlight/events.jsonl
```

Switch focus between two windows (or use a Hyprland Lua focus dispatch if you
are scripting the shot). New lines appear:

```json
{"v":1,"ts":1795171002870,"type":"focus","id":"app:helium","source":"toplevel","appId":"helium"}
```

Point at the fields:

- `type: focus`
- `id: app:helium`
- `appId: helium`
- **no title**

**Say:**

> Focus capture stores which app, when, and how often. It does not store the
> window title. Same-app focus within 1.5 seconds is deduped, and the focus that
> follows a launch is dropped for 15 seconds, so one intent counts once.

Open Spotlight, launch an app from the list, close. The log gets:

```json
{"v":1,"ts":1795171109133,"type":"launch","id":"app:helium","source":"spotlight","label":"Helium (0.21.3.1)","appId":"helium"}
```

Then:

```bash
spotlight snapshot
spotlight recent 5
spotlight stats
```

Show the snapshot entry:

```bash
jq '.items["app:helium"]' ~/.local/state/omarchy/spotlight/snapshot.json
```

**Say:**

> The UI never reads the JSONL. A debounced process turns the log into this map,
> and the UI reads the map through a watched file. The snapshot is the only
> thing the renderer knows about.

Open Spotlight with an empty filter and show the real For you / Recent rows.

**Say:**

> Four rows here, not six. Recent excludes the For you ids, and ids that do not
> resolve to an installed app are dropped. That is why uninstalling an app never
> leaves a dead row.

## Scene 7 — Bridge demo (8:00–10:30)

Use a temp state dir so the demo does not pollute real history. The UI will not
see this data; that is the point — it is the file API in isolation.

```bash
export XDG_STATE_HOME=/tmp/spotlight-demo
export XDG_CONFIG_HOME=/tmp/spotlight-demo-config
rm -rf "$XDG_STATE_HOME" "$XDG_CONFIG_HOME"

spotlight path
spotlight record --type launch --id app:Discord --label Discord --source demo
spotlight record --json '{"type":"focus","id":"app:helium","appId":"helium","source":"demo"}'

spotlight recent --json 5
spotlight stats
```

Expected shape:

```json
[
  {
    "id": "app:helium",
    "count": 1,
    "last": 1795173000000,
    "types": { "focus": 1 }
  },
  {
    "id": "app:Discord",
    "count": 1,
    "last": 1795172999000,
    "types": { "launch": 1 }
  }
]
```

Point out that the snapshot is kept warm automatically:

```bash
spotlight record --type launch --id app:Slack --label Slack --source demo
spotlight recent 5          # Slack is already there
spotlight record --type launch --id app:Zed --label Zed --source demo --no-snapshot
spotlight recent 5          # ensure_snapshot rebuilds; Zed appears
```

**Say:**

> `record` appends and rebuilds by default. For a burst, `--no-snapshot` skips
> the per-event jq pass; `recent` and `stats` rebuild once when the log is newer
> than the snapshot. That is the compromise: no stale reads, no rebuild per
> keystroke.

Then the IPC surface, back in the real state:

```bash
unset XDG_STATE_HOME XDG_CONFIG_HOME

omarchy-shell k0d3d.spotlight state
omarchy-shell k0d3d.spotlight openedState
omarchy-shell k0d3d.spotlight recent 3
```

`openedState` now carries the lens and filter, so it is usable as a debugger:

```
{"opened":false,"lens":"all","filter":"","rows":4,"commands":78,...}
```

Show a rejected event (does not write):

```bash
omarchy-shell k0d3d.spotlight record '{"type":"bogus","id":"x:y"}'
# error: rejected
```

**Say:**

> The IPC path goes through the same normalize step as the UI. Unknown types are
> rejected. Parameters have to be typed, or Quickshell will not register the
> handler at all: `record(payloadJson: string)`, not `record(payloadJson)`.

Close the scene with the privacy boundary:

> No titles, no keystrokes, no network. The log is a local app-usage timeline.
> Event data is never executed. The only launch path is an app row through the
> app library.

## Scene 8 — Failure stories (10:30–12:30)

### 8a. `clonedFrom`

**On screen:** the manifest and the registry.

```bash
grep -n "clonedFrom" ~/.config/omarchy/plugins/k0d3d.spotlight/manifest.json \
  || echo "none — on purpose"
```

Then show the mechanism:

```bash
sed -n '171,182p' /usr/share/omarchy/shell/services/PluginRegistry.qml
```

**Say:**

> I added `"omarchy": {"clonedFrom": "omarchy.menu"}` because it looked like a
> provenance note. It is not. `resolveEnabledId` redirects every call for
> `omarchy.menu` to the clone, and enabling a non-widget clone adds the source to
> `disabledPlugins`. My theme, background and power routes all landed in a
> surface that does not implement routes. Nothing crashed. The menu just stopped
> answering.

Show the fix:

```bash
grep -n "o.rebind" ~/.config/hypr/bindings.lua
```

> Remove the metadata, re-enable the stock menu, bind the two keys. That is the
> whole fix.

### 8b. jq treats `false` as empty

```bash
echo '{"capture":false}' | jq '.capture // true'
# true
echo '{"capture":false}' | jq 'if has("capture") then .capture else true end'
# false
```

**Say:**

> The kill switch read looked correct and lied. `//` is an alternative operator,
> not a null-coalescing operator that preserves `false`. The explicit `has()`
> form distinguishes "absent" from "present and false".

### 8c. Typed IPC (if you want a third)

Show the signature and say the log line:

```qml
function record(payloadJson: string): string
```

> Untyped arguments cannot cross the IPC boundary. The handler is skipped at
> registration; the call says `unknown`.

### 8d. The binding loop

Show the fixed detail column in `Spotlight.qml`:

```bash
grep -n -A6 "id: detailText" Spotlight.qml
```

**Say:**

> The first version used `width: Math.min(implicitWidth, …)` and anchored the
> label to it. That is a loop through the label's right anchor. The overlay did
> not paint. A fixed 110-pixel column with elide is less clever and always works.

## Scene 9 — Roadmap (12:30–13:40)

**On screen:** `07-roadmap.md` or a simple slide. Keep it concrete.

**Say:**

> Phase 1 is what remains: pins and dismiss, and the kill-switch toggle. Ranking
> shipped, shortcuts run their real bindings, actions come from Omarchy's own
> menu tree with its guards, Enter focuses an open window, and files open in the
> desktop's default handler.
>
> Phase 2 reads `pacman.log` for `installed` and `reinstalled` only, with an
> incremental byte offset. It never rotates the log and never treats an upgrade
> as a new app.
>
> Phase 3 is motion: a short card transition, after the overlay's scale-ready
> reveal, not before it.

Mention the honest gaps:

> The lens reset, CLI type validation and snapshot refresh are in. Actions are
> still not executable, and the install/pin/transition phases are still ahead.

## Scene 10 — Close (13:40–14:00)

Open the overlay one last time. Type `super shift f`, let the File manager row
sit for a second, then `Esc`.

**Say:**

> One surface, five lenses, and the chords teach themselves. The code is a
> manifest, two QML files, two pure-JS files, and a bash bridge. The docs in the
> repo include the schema, the failures, and the commands.

## 60-second cut

Vertical or horizontal; six shots, no talking head required. Text overlays in
quotes.

| Time | Shot | Text overlay |
|---|---|---|
| 0:00–0:08 | `SUPER+SPACE`, type `super shift f`, File manager appears | "type the chord you half remember" |
| 0:08–0:18 | cut to `wc -c` on the stock menu, then `manifest.json` | "read-only host · one manifest" |
| 0:18–0:30 | `tail -f events.jsonl`, focus changes; a launch line appears | "real launches + focus · no window titles" |
| 0:30–0:42 | `spotlight snapshot`, `jq '.items["app:helium"]'`, `spotlight recent 5` | "append-only log → snapshot → UI" |
| 0:42–0:52 | temp CLI: record, snapshot, recent; then `omarchy-shell k0d3d.spotlight state` | "CLI + IPC bridge" |
| 0:52–1:00 | overlay close, then a card with "Phase 1: boost · pins" | "Phase 0 is live" |

Commands, condensed:

```bash
# 1
# SUPER+SPACE, type: super shift f

# 2
wc -c /usr/share/omarchy/shell/plugins/menu/Menu.qml
cat ~/.config/omarchy/plugins/k0d3d.spotlight/manifest.json

# 3
tail -f ~/.local/state/omarchy/spotlight/events.jsonl

# 4
spotlight snapshot
jq '.items["app:helium"]' ~/.local/state/omarchy/spotlight/snapshot.json
spotlight recent 5

# 5
export XDG_STATE_HOME=/tmp/spotlight-demo
export XDG_CONFIG_HOME=/tmp/spotlight-demo-config
spotlight record --type launch --id app:Discord --label Discord --source demo
spotlight recent --json 3
unset XDG_STATE_HOME XDG_CONFIG_HOME
omarchy-shell k0d3d.spotlight state

# 6
# SUPER+SPACE, Esc
```

Voiceover, five lines:

1. "One input, five lenses — and the chords are searchable."
2. "The host is read-only, so this is one manifest and no fork."
3. "Real launches and focus, with no window titles."
4. "An append-only log, a snapshot the UI can afford to read."
5. "CLI and IPC for everything else. Phase 0 is live."

## Claims and proof

Keep these paired so the video never overclaims:

| Claim | Proof shot |
|---|---|
| Apps are real | Apps lens, launch, `AppLibrary` call |
| Enter focuses an open window, Shift+Enter opens a new one | `hyprctl clients` count before/after |
| Shortcuts actually run | `calc` → Enter → calculator window; `spotlight run` output |
| Files open in the desktop's default handler | `gio open` on a PNG → image viewer |
| Actions run Omarchy's menu command | Enter on *Theme*; `omarchy-image-selector` layer appears |
| Guards hide what the system would hide | 353 actions → 267 visible; an installed app's Install row shows ✓ |
| The log is local and title-free | `tail` line with `appId` and no title |
| The UI does not parse JSONL | `FileView` / snapshot code, `spotlight snapshot` |
| The stock menu still answers routes | `omarchy-shell shell call omarchy.menu ping` / `omarchy menu theme` |
| Spotlight centered beside the clock, stock menu in `left` | `jq` on `shell.json` |
| Live shortcut catalog | `wc -l` on `omarchy menu keybindings --print`; search `ocr` |
| `clonedFrom` was removed | `grep` returns none |
| Phase 0 is done | `spotlight stats` + smart rows |

## If something fails on camera

| Symptom | Recovery |
|---|---|
| Overlay does not open | `omarchy-shell shell toggle k0d3d.spotlight '{"menu":"root"}'`; check `omarchy plugin list` |
| For you is empty | `spotlight capture`, focus a few apps, `spotlight snapshot`, reopen |
| CLI `recent` is empty after a manual edit | `spotlight snapshot`; `recent` refreshes when it sees the log newer, but an explicit rebuild is the fallback |
| CLI `record` is a silent no-op | `spotlight capture`; capture off drops the event by design |
| IPC says `unknown` | The plugin is not loaded or the param is untyped; `omarchy-shell k0d3d.spotlight state` |
| `spotlight` not found | It is `~/.local/bin/spotlight`; check `PATH` |
| Node fails | Use `/usr/bin/node`; the shim is broken in this environment |

Do not debug `clonedFrom` live by enabling it. Show the code and the fix; the
symptom is too confusing to reproduce safely in one take.

# 6. Dev log

First-person build notes. These are the commands this build used; where a step
is reconstructed rather than replayed from scrollback, I say so. "At the time"
means the numbers were observed during the build and will drift as the log
grows.

## 1. Reading the host before writing anything

I started by reading the stock menu, not by scaffolding a plugin.

```bash
wc -c /usr/share/omarchy/shell/plugins/menu/Menu.qml \
      /usr/share/omarchy/shell/plugins/menu/MenuModel.js
# 65392 /usr/share/omarchy/shell/plugins/menu/Menu.qml
# 28912 /usr/share/omarchy/shell/plugins/menu/MenuModel.js
```

The first useful discovery was how little a `menu` plugin actually needs:

- a `manifest.json` with `kinds: ["menu"]`,
- an `Item` with `open(payloadJson)` and `close()`,
- an `opened` property,
- an `OverlayWindow` driven by that property.

Everything else — the tree, the JSONC routes, the `when:`/`checked:`
evaluation, the execution engine — is the stock menu's own model, not the
host's requirement. That is what made a standalone surface viable.

The second discovery was that `menu` is the kind that receives an `AppLibrary`
facade. An `overlay` does not. If I wanted real apps without reimplementing
desktop-entry parsing, the plugin had to be a `menu`.

## 2. The wireframe and its fossils

The first version was deliberately fake: `Model.staticCommands()` plus two
hard-coded arrays in `Model.js`:

```js
var FOR_YOU = [
  { id: "app:foot", detail: "recently" },
  { id: "app:brave-browser", detail: "used 14×" },
  { id: "action:screenshot", detail: "2 min ago" }
]
```

Those arrays are still in the file as the cold-start fallback. They are the
fossil layer: when there is no history, the surface shows curated rows if the
ids exist; when there is history, `smartPicks` supplies the same shape from real
data. Leaving them in was useful because it kept the renderer honest — the
renderer never knew the difference.

The first render used a `Column` inside a `BorderSurface`, a `FilterInput`, and
a `ListView` with sections. The layout was right almost immediately. The bugs
were in the details.

## 3. The binding loop that ate the overlay

The first detail column was:

```qml
Text {
  width: Math.min(implicitWidth, …)
  anchors.right: chordText.left
  // …
}
```

That is a loop: `implicitWidth` depends on the text, the text depends on the
width, and the anchors close the cycle through the label's `anchors.right`.
The symptom was not a warning I noticed first — it was that the overlay did not
appear at all. A QML layout loop can kill the surface before it paints.

The fix was boring and correct:

```qml
Text {
  width: visible ? Style.space(110) : 0
  anchors.right: chordText.left
  anchors.rightMargin: Style.space(12)
  elide: Text.ElideRight
}
```

A fixed detail column, elided. The label anchors to `detailText.left` when the
detail is visible and to `chordText.left` when it is not. No implicit width in
the anchor chain.

Lesson: in a row with three right-aligned pieces, give the middle piece a fixed
width. "Hug the content" is how you get a loop.

## 4. First summon, and why `wtype` is the wrong test tool

The first open was:

```bash
omarchy-shell shell toggle k0d3d.spotlight '{"menu":"root"}'
```

That worked. `wtype` did not:

```bash
wtype 'super shift f'
```

`wtype` injects text into the focused client; it does not synthesize a
compositor-level key chord. Hyprland never sees `SUPER+SHIFT+F`, so the global
bind does not fire. Once the overlay owns keyboard focus, `wtype` *can* type into
the `FilterInput` — which is useful for screenshots, but not for testing the
binding.

For focus-capture testing I used the compositor's Lua dispatcher. This
Hyprland (0.56.2 with Lua config) accepts:

```bash
hyprctl dispatch 'hl.dsp.focus({ window = "address:0x..." })'
```

It does **not** accept the classic form:

```bash
hyprctl dispatch focuswindow address:0x...
```

The classic form did not focus the window on this build; the Lua dispatcher is
the supported path here. I used it to bounce focus between two windows and watch
`events.jsonl` grow.

## 5. The `clonedFrom` detour

This is the mistake worth the most screen time.

I added:

```json
{
  "omarchy": {
    "clonedFrom": "omarchy.menu"
  }
}
```

to the manifest. My mental model was "same shape, based on the stock menu". The
registry's model is "this plugin replaces that plugin". On the next enable:

- `omarchy.menu` was added to `disabledPlugins`;
- the shell's `resolveEnabledId("omarchy.menu")` started returning
  `k0d3d.spotlight`;
- `omarchy menu theme`, `omarchy menu background`, `omarchy menu power` and
  anything else calling the stock id landed in Spotlight's `open()`.

Spotlight does not implement routes. `open({"menu":"theme"})` fell through to
"keep the current lens", so the theme/background/power menus appeared broken.
Nothing crashed. The stock menu simply stopped being the thing that answered.

The fix was not in code. It was in the manifest and the config:

1. Delete the `omarchy.clonedFrom` block.
2. Re-enable `omarchy.menu`.
3. Restore its bar entry.
4. Rebind the two keys with `o.rebind` instead of claiming the id.

I also found a leftover `cloneSourceRestores` entry for `k0d3d.spotlight` in
`shell.json`. It is harmless now, but it is a scar from the experiment; remove
it when cleaning up. (Done in the post-review pass; only `custom.media` remains.)

Lesson: `clonedFrom` is a routing declaration. It is not provenance, not a
compatibility note, and not a shortcut for "make my plugin look like that one".

## 6. Typed IPC parameters

The first handler was:

```qml
function record(payloadJson) { … }
```

The shell registered nothing. Quickshell logged a message along the lines of:

```
Type of argument ... cannot be used across IPC
```

The fix is one annotation:

```qml
function record(payloadJson: string): string { … }
```

Same for `recent(limit: string): string`. Untyped parameters are not
serializable across the IPC boundary, so the function is skipped at registration
time. If `omarchy-shell k0d3d.spotlight state` says `unknown`, check the
signature before checking the target.

## 7. Focus capture and the 15-second ghost

The first focus implementation counted everything, including the focus change
caused by opening the overlay and the focus change caused by closing it. The
result was a burst of `focus` events for whatever was underneath, twice per
open.

Three guards fixed it:

1. `suspended` is true while the overlay is open; `captureFocus()` returns
   early.
2. A launch sets `lastLaunchId`/`lastLaunchAt`; a `focus` for the same id within
   15 s is dropped, because it is the app catching focus after the launch, not a
   separate decision.
3. A same-app focus within 1.5 s is dropped, because alt-tabbing between two
   windows of the same app is still one session.

On close, `markCurrentFocus()` updates `lastFocusId`/`lastFocusAt` without
recording. That covers the focus change back to the app underneath; the 1.5 s
guard covers the event that arrives just after.

The overlay also skips `k0d3d.spotlight` and `org.quickshell` as app ids. Verify
the exact app id on your compositor if you add rules; the layer namespace is
`k0d3d-spotlight`, which is not the same string.

## 8. The jq `//` bug

The capture flag read was:

```bash
jq '.capture // true' "$CONFIG"
```

With `{"capture": false}` this printed `true`. jq's alternative operator treats
`false` as empty, exactly like `null`. The kill switch appeared to be on while
it was off.

The test:

```bash
echo '{"capture":false}' | jq '.capture // true'
# true

echo '{"capture":false}' | jq 'if has("capture") then .capture else true end'
# false
```

The fix is the explicit `has()` form. It also distinguishes "key absent"
(default true) from "key present and false".

This is the kind of bug that survives a UI test: the UI's `applySettings()` reads
JSON directly and honors `false` correctly, so only the CLI lied.

## 9. Snapshot design, and the staleness I did not expect

The obvious first design was to parse `events.jsonl` in QML on every refresh.
That is wrong for three reasons: it blocks the UI thread, it grows with history,
and it couples the renderer to the file format.

The replacement is a small jq reducer (abridged here; the real program is in
`cmd_snapshot()` in the CLI):

```bash
jq -R -s --argjson generatedAt "$now" '
  split("\n")
  | map(select(length > 0) | (fromjson? // empty))
  | reduce .[] as $e ({};
      .[$e.id] = (
        (.[$e.id] // { count: 0, last: 0, types: {} }) as $s
        | { count: ($s.count + 1),
            last: ([$s.last, ($e.ts // 0)] | max),
            types: ($s.types + { ($e.type // "unknown"): … }) }
      ))
' events.jsonl > snapshot.json.tmp.$$
mv snapshot.json.tmp.$$ snapshot.json
```

The UI reads only `snapshot.json` through a watched `FileView`.

What I did not expect: **external CLI writes do not trigger a rebuild.** The
shell's capture path debounces one, and opening Spotlight triggers one, but
`spotlight record` only appends. `spotlight recent` reads the existing snapshot
and rebuilds only if the file is missing. So this sequence is stale:

```bash
export XDG_STATE_HOME=/tmp/spotlight-test-state
spotlight record --type launch --id app:A
spotlight snapshot
spotlight record --type launch --id app:B
spotlight recent 5
# app:A only
```

After another `spotlight snapshot`, `app:B` appears. I kept the behavior because
auto-rebuilding on every `record` would make the CLI slower and reintroduce the
race the snapshot was meant to remove. The fix is documentation plus an explicit
`snapshot` call, not a hidden rebuild.

> **Update (post-review):** this decision changed. `record` now rebuilds by
> default, `--no-snapshot` is the batching escape hatch, and `recent`/`stats`
> call `ensure_snapshot`. See [Post-review fixes](#post-review-fixes-2026-11-20).
> The older paragraphs above are the original reasoning, kept for the record.

## 10. `node` is not `node` here

The pure-JS files are testable with Node, which is the whole reason they have no
QML imports. But this environment has a broken mise shim first in `PATH`:

```bash
node -v
# mise ERROR opencode.appimage is not a valid shim ...
# mise ERROR Version: 2026.11.8 ...
```

Use the real binary:

```bash
/usr/bin/node -v
# v26.12.0
```

Then:

```bash
/usr/bin/node -e "
const Model = require('./Model.js')
const Storage = require('./Storage.js')
console.log(Model.group(Model.staticCommands(), 'all', 'super shift f', {}))
"
```

That printed the File manager row with `section: "Shortcuts"`. It is the fastest
way to verify a matching or scoring change without touching the shell.

## 11. The typeahead moment

The chord test that made the interaction click:

```bash
/usr/bin/node -e "
const Model = require('./Model.js')
console.log(Model.group(Model.staticCommands(), 'all', 'super shift f', {}))
"
```

Output (trimmed):

```js
[ { id: 'shortcut:files',
    label: 'File manager',
    chord: 'SUPER + SHIFT + F',
    detail: 'Open',
    section: 'Shortcuts' } ]
```

The mechanism is `normalize()` turning `SUPER + SHIFT + F` into
`super shift f`, and `haystack()` including the chord. No special-case code for
"if the query looks like a chord". It falls out of the same substring search as
everything else.

> Superseded in 0.4.0: the substring search was replaced by the ranker, and
> chords now sit behind a modifier gate. See "The matcher was a substring test"
> at the end of this log.

## 12. Real data, and the first time it looked alive

After capture was wired, `spotlight stats` reported (at the time):

```json
{
  "events": 32,
  "ids": 7,
  "generatedAt": 1795171414493
}
```

`openedState` reported 78 commands and a smart block:

```json
{
  "opened": false,
  "rows": 4,
  "commands": 78,
  "smart": {
    "forYou": [
      { "id": "app:helium", "detail": "used 16×" },
      { "id": "app:io.github.lgse.Strata", "detail": "used 7×" },
      { "id": "app:chromium", "detail": "used 2×" }
    ],
    "recent": [
      { "id": "app:brave-browser", "detail": "4m ago" }
    ]
  }
}
```

Four rows, not six. That is correct: For you takes three, Recent excludes those
three and drops ids that do not resolve to an installed app (Slack and the
Strata file chooser in this snapshot). The "next 3" rule is "next 3 *eligible*",
not "always 3".

This was also the first confirmation that the unknown-id filter works: the log
contained those ids, the snapshot kept them, and the UI silently ignored them.

## 13. The overlay race

Opening from a script with a hide immediately followed by a summon can race the
layer surface teardown:

```bash
omarchy-shell shell hide k0d3d.spotlight
omarchy-shell shell summon k0d3d.spotlight '{}'
```

The second call may land before the first surface is gone. Use `toggle` for
normal interaction, or leave a short gap if you are scripting a reopen. The
shell's `toggle` checks `opened` and does the right thing in one call.

## 14. Late findings while writing this down

Two things surfaced only when the docs forced a line-by-line reading:

1. **The lens persists across closes.** `close()` clears the filter but not the
   lens; `open({"menu":"root"})` does not reset it. So after `SUPER+K`, a
   `SUPER+SPACE` reopens Shortcuts. The intended behavior is that `SUPER+SPACE`
   opens Everything; that holds on a fresh shell or after `Esc`-ing back to
   Everything, but not universally. Fix: reset `lens` to `"all"` in `open()`
   unless a lens/menu payload says otherwise.
2. **The CLI `--json` path bypasses the type whitelist.** The form path checks
   `TYPES`, the JSON path only checks non-empty `type`. An unknown type is
   accepted and counted. Fix: validate in jq or reuse the type list.

Neither was fixed in that documentation pass; both were recorded in the
roadmap.

> **Update (post-review):** both are fixed. `open()` resets to `all` when no lens
> payload is present, and `record --json` validates the type list in jq. See
> [Post-review fixes](#post-review-fixes-2026-11-20).

## 15. What I would do differently

- Add the two-line `open()` lens reset before recording the first demo. It is
  the kind of thing that looks like a bug on camera.
- Put the event schema in a single shell-readable file (or generate the CLI's
  type list from `Storage.js`) so the two validators cannot drift.
- Add a `spotlight snapshot --if-stale` mode (compare log mtime to snapshot
  mtime) instead of making every caller remember.
- Test the `keepLoaded` capture path before the UI path. Focus capture is the
  feature that makes the surface feel real; it should not be the last thing
  wired.
- Write the `clonedFrom` lesson down before touching the manifest. It is a
  five-minute mistake with a very confusing symptom.

## Post-review fixes (2026-11-20)

The docs review found a set of behavior gaps. This section is the fix-forward
record; the earlier entries above are the state at the time and are left intact.

### The lens reset

`Spotlight.open()` now has the third branch:

```qml
if (payload.lens) root.lens = String(payload.lens)
else if (payload.menu === "shortcuts") root.lens = "shortcuts"
else root.lens = "all"
```

`SUPER+SPACE` sends `{"menu":"root"}`, so it always opens Everything now, even
after a `SUPER+K` session. `SUPER+K` still sends `{"lens":"shortcuts"}` and still
opens Shortcuts. The old "lens persists" entry in section 14 is superseded.

### Overlay cycles do not inflate usage

The first Phase 0 pass only paused capture while the overlay was open and then
called `markCurrentFocus()`. A slow close could still let the app underneath
report a fresh activation, so opening the launcher a few times could add phantom
uses. `Capture.beginSession()` now stores the app underneath, and
`endSession()` suppresses that app's next activation for four seconds.

Verified on the running shell:

```text
events after 3 open/close cycles: 0
events after a real focus switch: 1   # app:chromium
```

### The shortcut lens was only a demo

The first catalog had eleven hand-picked shortcuts. Searching `ocr` or
`move window` returned nothing, while the real system had bindings for both. The
fix was to stop hand-maintaining the list:

```bash
omarchy menu keybindings --print
```

That command already merges the shipped bindings with user overrides and app
binds. `Model.parseShortcutLine()` splits the output on `→`, normalizes the
chord, and builds a stable id from the label and chord. The scan streams through
`SplitParser`; the overlay is not blocked while it arrives.

On this machine:

```text
parsed: 249 rows, 249 unique ids
commands after merge: 316   # 249 shortcuts + 7 actions + 60 apps
query "ocr"         -> 1 row: Extract text (OCR) from screenshot | SUPER CTRL + PRINT
query "move window" -> 31 rows
```

`spotlight openedState` was used to confirm the live counts, and `wtype` typed
`ocr` into the open overlay to capture the result.

### The stock menu button stays

The first post-review cleanup removed the stock `omarchy.menu` entry from the
bar to leave Spotlight as the only launcher. That was the wrong trade: a
`bar-widget`'s enabled state is its bar placement, so `omarchy plugin list`
flipped to `disabled` and the stock routes were no longer reliably available.
Adding a `plugins[]` entry did not change that report.

The final layout keeps both buttons and splits their roles: the stock system
menu takes the left launcher slot, and Spotlight sits beside the clock in
`center`.

```json
{
  "left": [
    { "id": "omarchy.menu" },
    { "id": "tornikegomareli.spaces" },
    { "id": "custom.media" }
  ],
  "center": [
    { "id": "k0d3d.spotlight" },
    { "id": "omarchy.clock" }
  ],
  "centerEnd": [
    { "id": "omarchy.elsewhen" },
    { "id": "omarchy.weather" },
    { "id": "omarchy.system-update" }
  ],
  "cloneSourceRestores": ["custom.media"],
  "plugins": []
}
```

Spotlight's bar glyph also changed from the Omarchy logo to a magnifier
(`\uf002` in `JetBrainsMono Nerd Font`), so the centered button reads as search
and does not duplicate the system menu's identity.

Removing the stock placement breaks theme/background/power. The stale
`k0d3d.spotlight` entry in `cloneSourceRestores` is still gone. The backups from
editing this file are `shell.json.bak.1795168265`, `.bak.1795172540`,
`.bak.1795173394`, and `.bak.1795174712`.

`omarchy plugin list` now shows both as enabled:

```
omarchy.menu       enabled   first-party  menu,bar-widget  Omarchy menu
k0d3d.spotlight    enabled   third-party  menu,bar-widget  Spotlight
```

### The CLI now matches the schema

`record --json` validates `type` against the same list as `--type`, inside jq:

```bash
spotlight record --json '{"type":"bogus","id":"app:X"}'
# jq: error (at <stdin>:0): unknown type: bogus
# spotlight: invalid event JSON
# exit 1
```

No event is appended.

### `record` keeps the snapshot warm

`record` rebuilds `snapshot.json` after appending. For a burst:

```bash
spotlight record --type launch --id app:A --no-snapshot
spotlight record --type launch --id app:B --no-snapshot
spotlight snapshot
```

`recent` and `stats` call `ensure_snapshot`, which rebuilds when
`events.jsonl` is newer than `snapshot.json` (or when the snapshot is missing).
The old "external writes do not refresh" gotcha in section 9 is superseded.

### The kill switch covers the CLI

If `spotlight.json` has `capture: false`, `spotlight record` prints:

```
spotlight: capture is off; event dropped
```

to stderr and exits 0. It does not append and does not rebuild. The UI and IPC
paths remain gated by `Capture.record()`.

`Capture.applySettings()` now resets both flags to `true` when the file is
missing or unparseable, so deleting `spotlight.json` really means "back to
defaults" instead of "keep the last switch state".

### Bookkeeping events do not inflate frequency

`Storage.usageCount()` sums only:

```
launch  focus  open  action  custom
```

`pin`, `unpin` and `dismiss` stay in the schema and in the raw snapshot
`count`, but they do not contribute to the `used N×` number or the frequency
sort. A `custom` event that reuses an existing `app:` id still counts for that
row; a `custom:*` id with no command is ignored.

One caveat remains: `smartPicks` uses the snapshot's `last` across all types, so
a bookkeeping event can still refresh recency. Frequency is clean; recency is
not fully isolated yet. That is on the roadmap.

### The catalog updates live

`Spotlight.qml` now connects to `AppLibrary.appsChanged`:

```qml
Connections {
  target: root.appLibrary
  function onAppsChanged() { if (root.opened) root.prepare() }
}
```

An install while the overlay is open appears without closing it. The next
`open()` still rebuilds the catalog as before.

### Visual cleanup

- The footer is `↵ Open`, `⇥ Lens`, `? Shortcuts`, `esc Close`; the `→ Run`
  hint is gone because actions/shortcuts still only log.
- `corner` is `Math.max(0, Style.cornerRadius)`. Square themes stay square; the
  old forced 10 px fallback is gone.
- The unused `accent` and `cornerRadius` properties were removed.

### Debug and stats parity

`openedState` now includes `lens` and `filter`:

```json
{
  "opened": false,
  "lens": "all",
  "filter": "",
  "rows": 4,
  "commands": 78,
  "smart": { "forYou": [], "recent": [] }
}
```

`stats` from the CLI and the IPC handler now return the same fields: `events`,
`ids`, `generatedAt`, `eventsPath`, `snapshotPath`, `configPath`, `capture` and
`focus`.

### Cleanup

The stray `demo:noop` event from the docs verification pass was removed, and the
whole log was truncated after the final test pass. The first smart block after
that reflects real focus changes, not the automated switching used to verify
capture.

### The matcher was a substring test

`group()` filtered on `haystack.indexOf(needle) >= 0` and sorted by a five-step
score (exact label, prefix, substring, chord, else) then alphabetically. That is
precise but literal, and the review found it fast:

```text
mv win      -> 0 rows        (should be Move window)
fullscren   -> 0 rows        (should be Full screen)
brv         -> 0 rows        (should be Brave)
move window -> workspace 10 before workspace 2
```

The last one is not fuzzy matching: it is plain alphabetical order.

The fix was not to add a boost multiplier on top of the substring test. It was
to replace the matcher. `Model.js` now carries a port of Raycast's root-search
algorithm, adapted from [omacast](https://github.com/typecraft-dev/oma-cast)
(MIT; see `LICENSES/omacast-MIT.txt`). QML cannot import one `.js` file from
another, so the code lives in `Model.js`, in a marked section kept close to
upstream.

The port ranks by a dynamic programme over the query, not by substring:

```text
(score per matched character: 4 at index 0, 3 at a word boundary,
 2 mid-word, 1 on a separator, minus 1 for a jump)
```

Measured on the real catalog (249 keybindings + 7 actions + 72 apps):

```text
mv win      -> Move window, then the workspace moves
fullscren   -> Full screen, Tiled full screen, Toggle full screen desktop
brv         -> Brave
ocr         -> Extract text (OCR) from screenshot
move window -> workspace 1, 2, 3 … 10 in numeric order
```

#### Four things upstream gets wrong for a command catalog

The port is not verbatim. Each deviation came from a measured failure, not
taste:

1. **Long keyword strings match any two letters.** The algorithm charges a flat
   1 for a jump, so `ff` hit "folder manager … filesystem" in Files' desktop
   keywords. One- to three-letter queries now match titles only, with a fixed
   floor (`shortFloor`: 3, 6, 7).
2. **Every chord was a keyword.** `calc` matched "SUPER CTRL ALT C" on
   Screenshot. Chords are now searched only when the query starts with a
   modifier (`super`, `sup`, `ctrl`, `alt`, `shift`, `print`, `fn`).
3. **A whole-word hit beat a title prefix by 0.5.** The floor formula is
   `4 + (len-1)*2 + 0.5`, which is deliberately above the start-of-title score,
   so `calc` put "LibreOffice Calc" above "Calculator". A start-of-title match
   now wins, and the floor is skipped when the title already starts with the
   query.
4. **Keyword-only rows fell back to alphabetical order.** Keyword scores were
   computed and then discarded. They are compared now, and equal scores prefer
   the shorter (tighter) title.

The 4- and 5-letter threshold is also stricter than upstream's curve
(`2 × len` instead of `1.5 × (len-2) + 4`), because scattered matches across a
long title cleared the original bar: `calc` ranked "Cycle workspace layout
back".

#### Usage had to become a real score

A recall-heavy matcher is only pleasant with usage data; without it, two-letter
queries surface every word-initial coincidence. The snapshot now carries a
decayed score instead of a raw count:

```text
frecency = 1 + 100 · Σ exp(-ln(2)/10 · age_days)
```

Ten-day half-life, computed in the snapshot's jq pass. The log stays the source
of truth; deleting `snapshot.json` is always safe. `Storage.smartPicks` uses
`frecency` for **For you** and falls back to `count` for older snapshots.

Cross-checked the jq output against the same formula in node:

```text
app:foo  2 launches (now, 1 day ago)      -> 194.30
app:bar  1 launch 20 days ago + 1 focus   -> 126.00
```

#### Learned terms

`Spotlight.activate()` now attaches the filter to the launch event:

```js
data: (capture.learnTerms && root.filterText !== "") ? { query: root.filterText } : undefined
```

The snapshot keeps up to 20 terms per id, and `searchTermMatch()` treats an
exact or prefix term as a match. Launching Brave from `brv` once makes `brv`
recall Brave even though the letters are loose. Terms expire after 17 days of
no opens, so a habit fades.

This changed the privacy story: the filter used to be explicitly not recorded.
It is now stored as `data.query` on app launches only, and a separate
`learnTerms` switch (default `true`) turns it off. `capture: false` still turns
off everything.

#### The QML binding loop that was not a QML problem

Adding `capture.usage` to the `rows` binding produced:

```text
WARN scene: QML Spotlight ... Binding loop detected for property "rows"
```

`smart` was a plain property written by `onUsageChanged`, while `rows` read both
`smart` and `usage`. Making `smart` a derived binding and deleting the handler
removed the warning:

```qml
readonly property var smart: Storage.smartPicks(capture.usage, root.commands, Date.now())
```

Live verification, typed into the open surface with `wtype`:

```text
ocr       2 rows   Extract text (OCR) from screenshot, Openscreen
calc      3 rows   Calculator, LibreOffice Calc, Omacalc
mv win   35 rows   Move window first
10        3 rows   workspace 10 rows
```

#### Tests

`tests/model.test.js` runs with `/usr/bin/node --test tests/` and covers the
matcher, short-query floors, natural collation, bucket ordering, frecency
ordering, learned-term recall/expiry, section order, and `smartPicks`. Sixteen
tests, no dependencies.

### Enter did nothing on Calculator

Reported after 0.4.0: type `calc`, press Enter, nothing happens. The first row
was `Calculator [SUPER SHIFT + Q / XF86Calculator]` — a **shortcut** row, and
`activate()` only knew how to launch apps. Everything else logged
`spotlight: would run …` to a journal nobody reads.

The fix was not to special-case Calculator. Omarchy already resolves bindings
for its own keybindings menu, including binds Hyprland reports only as
`dispatcher: "__lua", arg: "57"`. It writes the resolution to a cache:

```text
~/.cache/omarchy/keybindings-<hash>.records
SUPER SHIFT + Q / XF86Calculator    → Calculator	exec	omacalc
SUPER + F                           → Full screen	lua	hl.dsp.window.fullscreen({ mode = "fullscreen" })
```

`spotlight run --chord … --label …` reads that file, normalizes the whitespace,
and dispatches by kind. Spotlight keeps using
`omarchy menu keybindings --print` for the catalog, and that same scan refreshes
the cache, so a rebind is picked up on the next open.

Two Hyprland details worth writing down:

- `hyprctl dispatch exec omacalc` exits 7 on this machine. With a Lua config,
  Hyprland parses the legacy form as Lua (`hl.dispatch(exec omacalc)`) and
  fails. `hl.dsp.exec_cmd("omacalc")` is the working path; the legacy form stays
  as a fallback.
- `hyprctl dispatch` returns `ok`, not JSON. Treating a non-zero exit as failure
  is correct; treating empty output as failure is not.

Verified: `spotlight run --chord "SUPER SHIFT + Q / XF86Calculator" --label
Calculator` printed `ok exec omacalc` and a calculator window appeared. Then
Enter on the row did the same and closed the overlay.

### Enter duplicated windows

The other half of the same complaint: Enter on an app that was already running
started another instance. `openApp()` now looks for a window first:

```js
var entry = DesktopEntries.heuristicLookup(toplevel.wayland.appId)
if (entry && String(entry.id) === row.appId) candidates.push(toplevel)
```

That is the dock's own matching rule, so class, `StartupWMClass` and web-app
names resolve identically. Candidates are ordered focused → on the active
workspace → not minimized.

Focusing is the hard part: the overlay's layer holds keyboard focus, and
Hyprland refuses to focus another window until it is gone. `bringForward()`
closes the overlay, waits for the `k0d3d-spotlight` namespace to leave
`hyprctl layers -j`, then dispatches `hl.dsp.focus` and
`hl.dsp.window.alter_zorder`, retrying for half a second. A minimized window is
moved back to the active workspace with `no_anim` set first.

Measured with `foot`:

```text
0 windows → Enter → 1 window      (launched)
1 window  → Enter → 1 window      (focused, no duplicate)
1 window  → Shift+Enter → 2 windows
```

`Shift+Enter` is the escape hatch and is in the footer now.

### Files, and the default handler question

There was no file search at all, so "hit Enter on a photo" had no row to land
on. The files lens is deliberately thin:

- the bridge does the searching (`spotlight files`), not the shell process;
- no query → `find` for files modified in the last 30 days;
- a query → `fd --fixed-strings --type f`, which skips hidden and gitignored
  paths by default;
- QML debounces 220 ms and only searches in the files lens or in Everything
  with three or more characters;
- results are merged at render time and never stored in `commands`.

Opening is `gio open -- <path>`. That is the whole MIME integration: the
desktop's `mimeapps.list` decides, so `image/png` went to Omaroll on this
machine without Spotlight knowing what a PNG is.

Verified with a real file:

```text
query "spotlight-file-test" → 1 row: spotlight-file-test.png
Enter → active window class io.github.tsouth89.omaroll
```

Paths are not recorded as usage. Recording them would turn the event log into a
document history, which is a different privacy promise.

### The actions lens was seven hand-written rows

A fair question after 0.5.0: Lock screen, Theme menu, Night light — why were
those still dead? Because they were the last survivors of the original wireframe.
When the shortcut lens was replaced with the live keybinding catalog, the actions
list was left alone: seven labels with chords, no commands.

Omarchy had the answer on disk the whole time:

```text
/usr/share/omarchy/default/omarchy/omarchy-menu.jsonc   425 items, 353 actions
~/.config/omarchy/extensions/omarchy-menu.jsonc         user additions
```

Each item carries the exact command the stock menu runs:

```jsonc
"system.lock":      {"label":"Lock","action":"omarchy-system-lock"}
"appearance.theme": {"label":"Theme","aliases":["theme"],"action":"omarchy-shell shell summon omarchy.image-picker '{\"source\":\"themes\"}'"}
```

`Model.parseMenu()` strips the JSONC comments and trailing commas, merges the
user file over the defaults by id, and `menuActionRows()` keeps only items with
an `action`. Dotted ids give the breadcrumb that makes four rows called "Theme"
distinguishable (*Appearance*, *Install*, *Remove*, *Appearance › Windows ›
Window Corners*).

Two details were worth the effort:

- **Guards.** `when`, `checked` and `disabled` are shell conditions. Running 200
  of them one process at a time would stall the lens, so one generated bash
  script evaluates them in eight background buckets and prints `id:w:1` lines.
  Measured: 0.8 s for the whole tree, once at startup and again on open so a
  toggle's label is current. Result: 353 actions → 267 visible, 86 hidden by
  `when`, 6 install rows marked ✓.
- **Order.** Alphabetical made the empty lens start with ".NET" and "1-Window
  Ratio On". Each row now carries its index in the menu file as
  `sortHeuristic`, which the ranker uses as a tie-break, so the empty lens
  follows Omarchy's own order.

Enter on an action runs `bash -lc "<action>"`. That is the same string the stock
menu would run; `disabled` rows refuse. Verified by running *Theme*: the
`omarchy-image-selector` layer appeared, and Escape closed it.

One self-inflicted bug on the way: adding a second `omarchyPath` property made
the loader abort with `Duplicate property name`, which surfaced as
`ReferenceError: errorString is not defined` in the shell's own loader. The
entry above it was the real error. Lesson: read one line before the panic.

### Still not done

Pin/dismiss UI, `pacman.log` installs, transitions, compaction/retention and
dwell time are still ahead. There is still no `spotlight reset` command. The
`SUPER+K` shortcut row now actually runs its binding, so it toggles the surface
instead of logging. Actions are no longer on this list: 0.6.0 indexes Omarchy's
menu tree instead of seven hand-written rows.

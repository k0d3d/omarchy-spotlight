# Spotlight (`k0d3d.spotlight`)

A first-principles command surface for the Omarchy shell: one input, five lenses,
chords printed on every row, focused windows instead of duplicate launches, and
a small append-only usage log that feeds a "For you" block with real launches
and focus changes.

Standalone plugin. It does **not** fork, wrap, or extend the stock `omarchy.menu`.
It reuses the shell's public pieces — `OverlayWindow`, `BorderSurface`,
`FilterInput`, `AppLibrary`, the menu theme tokens — and adds its own model,
storage and capture layer.

```
┌──────────────────────────────────────────────────────────┐
│ Search apps, actions, shortcuts…          [Everything]   │
│                                                          │
│ FOR YOU                                                  │
│ ▸ Discord                                    used 5×     │
│   Helium                                    used 16×     │
│ RECENT                                                   │
│   Brave                                      4m ago      │
│   Files                                  yesterday       │
│                                                          │
│ ↵ Open  ⇥ Lens  ? Shortcuts  esc Close          6 results  │
└──────────────────────────────────────────────────────────┘
```

Version `0.6.1`, manifest schema 1. Phase 0 (usage capture, live shortcut
catalog, Raycast-style ranking, executable actions and shortcuts, window
focusing and a file lens) is live.

## What works right now

| Area | Status |
|---|---|
| Five lenses: Everything / Apps / Actions / Shortcuts / Files | working |
| `Tab` / `Shift+Tab` lens cycling | working |
| Sigils `?`, `@`, `>` | working |
| Fuzzy ranking (Raycast's algorithm, ported via omacast) | working |
| Word-initial shortcuts (`fs` → Full screen, `mw` → Move window) | working |
| Typo/abbreviation search (`fullscren`, `mv win`, `brv`) | working |
| Natural order (`workspace 9` before `workspace 10`) | working |
| Chord typeahead (`super shift f` → File manager) | working |
| Full Omarchy keybinding catalog (249 rows on this machine) | working |
| App launch through `AppLibrary` | working |
| Enter focuses an open window instead of launching a second one | working |
| `Shift+Enter` always launches a new window | working |
| Actions come from Omarchy's own menu tree (353 rows, guards applied) | working |
| Executable menu actions (Lock, Theme, Night light…) | working |
| Shortcut rows execute their real binding (`Calculator` → `omacalc`) | working |
| Files lens: recent files, then `fd` search | working |
| Opening a file uses the desktop MIME handler (`gio open`) | working |
| For you / Recent from real launches + focus | working |
| Frecency (10-day half-life) drives result order and For you | working |
| Learned terms (`brv` launches Brave once → `brv` finds it) | working |
| Append-only event log + snapshot | working |
| Live app catalog while open (`appsChanged`) | working |
| CLI + IPC bridge, CLI-triggered snapshot refresh | working |
| Kill switch (`capture`, `captureFocus`, `learnTerms`), UI + CLI | working |
| Pin / dismiss UI, dwell time, log compaction | not yet |
| Packaged install history (`pacman.log`) | Phase 2, not implemented |

The exact limits are tracked in [`docs/07-roadmap.md`](docs/07-roadmap.md).
The matcher has node tests: `node --test tests/` from the plugin directory.

## Install

The plugin is a normal user plugin: one directory, one `manifest.json`, no
build step.

```bash
mkdir -p ~/.config/omarchy/plugins
cp -r k0d3d.spotlight ~/.config/omarchy/plugins/
omarchy plugin validate ~/.config/omarchy/plugins/k0d3d.spotlight
```

Then make the shell load it. There are two ways, and they mean different things:

**With the bar button** (this machine's setup; Spotlight sits beside the clock in
`center`, while the stock menu keeps the left launcher slot).
Add the id to a bar section in `~/.config/omarchy/shell.json`:

```json
{
  "bar": {
    "layout": {
      "center": [
        { "id": "k0d3d.spotlight" },
        { "id": "omarchy.clock" }
      ]
    }
  }
}
```

**Without a bar button.** Reference it from `plugins[]` instead:

```json
{
  "plugins": [
    { "id": "k0d3d.spotlight" }
  ]
}
```

Either reference makes the menu loader available. For a plugin that is also a
bar widget, only the bar entry places a button; `plugins[]` keeps the component
loadable without adding one. `omarchy plugin list` reports a bar-widget by its
bar placement, so a plugin kept alive through `plugins[]` can still read as
"disabled" there while its menu component loads.

The manifest has `keepLoaded: true`, so the menu component (and therefore
`Capture.qml`, which lives inside `Spotlight.qml`) is mounted at shell startup,
not on first open. That is what makes focus capture continuous.

Restart deterministically after changing `shell.json`:

```bash
omarchy-restart-shell
```

Plugin source edits are picked up by the shell's plugin watch, but a restart is
the least surprising way to verify a fresh install.

### Keybindings

`SUPER+SPACE` and `SUPER+K` are rebound, not newly invented. Put this in
`~/.config/hypr/bindings.lua`:

```lua
o.rebind("SUPER + SPACE", "Spotlight", "omarchy-shell shell toggle k0d3d.spotlight '{\"menu\":\"root\"}'")
o.rebind("SUPER + K", "Spotlight shortcuts", "omarchy-shell shell toggle k0d3d.spotlight '{\"lens\":\"shortcuts\"}'")
```

These replace the defaults from `default/hypr/bindings/utilities.lua`:

- `SUPER+SPACE` → stock `omarchy.menu` at the root route
- `SUPER+K` → `omarchy-menu-keybindings`

The stock menu keeps the left launcher slot, so its theme, background and power
routes stay one click away. Spotlight's magnifier sits beside the clock in
`center`. The `omarchy.menu` plugin stays enabled because it is in the bar
layout; taking that entry out makes `omarchy plugin list` report it as disabled
and can break those routes. See
[`docs/04-omarchy-integration.md`](docs/04-omarchy-integration.md) for the
coexistence details.

Inside the surface:

| Key | Action |
|---|---|
| `↑` / `↓` | move selection (wraps) |
| `Tab` / `Shift+Tab` | next / previous lens |
| `Enter` / `→` | activate selected row |
| `Shift+Enter` | launch a new app window, even if one is open |
| `Esc` | clear filter → reset lens to Everything → close |
| `Backspace` on an empty filter | reset lens to Everything |
| `?` at the start of the input | jump to Shortcuts |
| `@` at the start of the input | jump to Apps |
| `>` at the start of the input | jump to Actions |

`SUPER+SPACE` always opens at Everything: `Spotlight.open()` resets the lens
unless the payload names one. `SUPER+K` sends `{"lens":"shortcuts"}` and still
opens Shortcuts. The surface is reachable from the centered bar button as well.

Enter is context-aware:

- **App with an open window** — focus it, switching workspace and raising it if
  needed. A minimized window is restored first. Nothing new is launched.
- **App with no window** — launch it through `AppLibrary`.
- **Shortcut row** — run the binding it describes, by asking
  `~/.local/bin/spotlight run`. This is what makes `Calculator` launch
  `omacalc` instead of doing nothing.
- **File row** — `gio open`, so the desktop's MIME handler decides. A PNG opens
  in your image viewer, a PDF in your PDF reader.
- **Action row** — runs the shell command from Omarchy's own menu definition
  (`omarchy-menu.jsonc`): Lock, Theme, Night light, the install/update routes.
  Rows Omarchy marks as already set up carry a ✓ and refuse to run.

The Shortcuts lens is not a hand-written cheat sheet. Spotlight runs
`omarchy menu keybindings --print` at startup and refreshes the list when it
opens (30 s throttle), so shipped bindings, user overrides and app-level binds
all participate. On this machine that is 249 rows, including `SUPER CTRL + PRINT`
→ "Extract text (OCR) from screenshot" and the window/workspace move bindings.

## File map

| File | Responsibility |
|---|---|
| `manifest.json` | id, version, `kinds: ["menu","bar-widget"]`, entry points, `keepLoaded` |
| `Spotlight.qml` | overlay, five lenses, keyboard, theme tokens, IPC bridge, activation (focus/launch/run/open) |
| `Model.js` | Omarchy menu parsing + guards, actions, live keybinding parsing, Raycast-style ranker, grouping, file rows |
| `Storage.js` | event schema, normalization, relative time, `smartPicks` scoring helpers |
| `Capture.qml` | JSONL writer, snapshot loader, focus tracking, debounce, kill switch |
| `BarWidget.qml` | bar button that toggles the surface (right-click opens a terminal) |
| `tests/` | node tests for the matcher, ranking, grouping and smart picks |
| `LICENSES/` | MIT notice for the omacast-derived ranking code |
| `docs/` | build notes, architecture, bridge reference, video script |

Related files outside the plugin:

| Path | Role |
|---|---|
| `~/.local/bin/spotlight` | bash + jq bridge CLI (`record`, `snapshot`, `recent`, `run`, `files`, `stats`, `capture`, `path`) |
| `~/.config/hypr/bindings.lua` | the two `o.rebind` lines |
| `~/.config/omarchy/shell.json` | Spotlight centered; stock menu in `left` |
| `~/.config/omarchy/spotlight.json` | optional `{ "capture": bool, "captureFocus": bool, "learnTerms": bool }` |
| `~/.local/state/omarchy/spotlight/events.jsonl` | append-only event log |
| `~/.local/state/omarchy/spotlight/snapshot.json` | aggregated usage map the UI reads |

## Quick bridge example

Record a launch, rebuild the snapshot, and read the result:

```bash
spotlight record --type launch --id app:Discord --label Discord --source my-tool
spotlight recent 5
spotlight stats
```

The UI does not read `events.jsonl`; it reads `snapshot.json`. `spotlight record`
rebuilds the snapshot automatically after appending, and `recent`/`stats`
rebuild when the log is newer than the snapshot. If a producer writes a burst,
pass `--no-snapshot` and run `spotlight snapshot` once at the end.

Same thing over IPC, without touching the file API:

```bash
omarchy-shell k0d3d.spotlight record '{"type":"launch","id":"app:Discord","label":"Discord","source":"my-tool"}'
omarchy-shell k0d3d.spotlight recent 5
omarchy-shell k0d3d.spotlight state
```

Full schema, privacy notes, integration recipes and the exact refresh rules:
[`docs/05-usage-bridge.md`](docs/05-usage-bridge.md).

The CLI also powers the surface itself:

```bash
spotlight run --chord "SUPER SHIFT + Q / XF86Calculator" --label Calculator
spotlight files --query backup --limit 5
spotlight files            # files modified in the last 30 days, newest first
```

`run` resolves against Omarchy's keybinding cache — the same records the
keybindings menu uses — so bindings that Hyprland only reports as a Lua
dispatcher still run. `files` prints JSON; the UI never opens the file index
itself.

## Documentation

Start at [`docs/00-index.md`](docs/00-index.md). The short version:

1. [Origin story](docs/01-origin-story.md) — why a standalone surface instead of a fork
2. [Architecture](docs/02-architecture.md) — data flow, event schema, snapshot, smart picks
3. [UX decisions](docs/03-ux-decisions.md) — lenses, sigils, chords, Esc, the card
4. [Omarchy integration](docs/04-omarchy-integration.md) — manifest, menu lifecycle, tokens, `clonedFrom`
5. [Usage bridge](docs/05-usage-bridge.md) — CLI, IPC, files, privacy, security
6. [Dev log](docs/06-dev-log.md) — what broke, in order, with commands
7. [Roadmap](docs/07-roadmap.md) — Phase 0 → 3 and the review findings
8. [YouTube demo](docs/08-youtube-demo.md) — scene-by-scene script, plus a 60-second cut

## Attribution

The ranking section of `Model.js` is adapted from
[omacast](https://github.com/typecraft-dev/oma-cast), MIT licensed. omacast
describes its ranker as a clean-room port of Raycast's root-search algorithm;
Spotlight follows that port, with the local changes listed in
[`LICENSES/omacast-MIT.txt`](LICENSES/omacast-MIT.txt). No Raycast code or
assets are involved.

## Uninstall

Remove the `k0d3d.spotlight` entry from `shell.json` (bar layout or `plugins[]`),
remove the two `o.rebind` lines, then delete the plugin directory. Runtime state
lives under `~/.local/state/omarchy/spotlight/`; delete it if you want a clean
history. Nothing outside those paths is written.

If you want the stock menu back on the bar, add `omarchy.menu` to a bar section
again; its plugin is still loadable even when it has no bar placement.

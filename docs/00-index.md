# Spotlight build documentation

**One-paragraph summary.** `k0d3d.spotlight` is a standalone Omarchy shell plugin
that replaces the *interaction* of the stock menu with a Spotlight-style surface:
one input, five lenses (Everything, Apps, Actions, Shortcuts, Files), chord text
shown on every row, and a usage log that turns real launches and window focus
into a "For you" and "Recent" block. Apps come from the shell's `AppLibrary`;
actions come from Omarchy's own `omarchy-menu.jsonc` tree, so they carry the same
shell commands, `when` conditions and disabled state as the stock menu, and
shortcuts come from the live `omarchy menu keybindings --print` catalog, so they
include the user's own overrides; queries are ranked by a port of Raycast's
root-search algorithm, weighted by a decayed frecency per id, and the empty-query
view is scored
by `Storage.smartPicks` from `snapshot.json`, which is aggregated by a bash + jq
CLI from an append-only `events.jsonl`. The plugin is a normal `menu` +
`bar-widget` plugin with `keepLoaded: true`, so its capture layer is live from
shell startup. It deliberately does not fork `omarchy.menu`, does not execute
anything found in event data, and does not store window titles.

## Reading order

The docs are written in the order the project was built, not the order the files
happen to sit in.

| # | Doc | Read it for |
|---|---|---|
| 1 | [01-origin-story.md](01-origin-story.md) | the goal, the constraints, and why a fork was the wrong shape |
| 2 | [02-architecture.md](02-architecture.md) | the data flow, every component, the schema, the scoring |
| 3 | [03-ux-decisions.md](03-ux-decisions.md) | why one input and five lenses, why sigils, why Esc has two stages |
| 4 | [04-omarchy-integration.md](04-omarchy-integration.md) | manifest rules, `menu` lifecycle, `OverlayWindow`, tokens, `o.rebind`, the `clonedFrom` trap |
| 5 | [05-usage-bridge.md](05-usage-bridge.md) | CLI/IPC reference, files, concurrency, kill switch, privacy, security |
| 6 | [06-dev-log.md](06-dev-log.md) | the build in first person, including the failures and the commands that found them |
| 7 | [07-roadmap.md](07-roadmap.md) | what Phase 0 actually shipped, and the next three phases |
| 8 | [08-youtube-demo.md](08-youtube-demo.md) | a scene-by-scene video script with exact commands |

Back to the [README](../README.md).

## If you only have five minutes

1. Read the diagram at the top of [02-architecture.md](02-architecture.md).
2. Read the "Why not a fork" section of [01-origin-story.md](01-origin-story.md).
3. Read the `clonedFrom` failure in [04-omarchy-integration.md](04-omarchy-integration.md).
4. Skim the CLI/IPC tables in [05-usage-bridge.md](05-usage-bridge.md).

## Conventions used here

- Commands are shown for this machine. `~` is `/home/k0d3d`; the plugin is at
  `~/.config/omarchy/plugins/k0d3d.spotlight/`.
- Paths under `/usr/share/omarchy/` are **read-only** in this project. They are
  quoted as reference, never as files to edit.
- "Verify" means the claim comes from reading the shell source but was not
  exercised on this running session while writing. Everything else was checked
  against the plugin files or the live shell.
- Relative links are used between docs; the README is one level up.

## Source of truth

When prose and code disagree, the code wins:

- UI and bridge: `Spotlight.qml`
- catalog and ranking: `Model.js`
- schema and scoring: `Storage.js`
- capture and snapshot loading: `Capture.qml`
- bar entry: `BarWidget.qml`
- CLI: `~/.local/bin/spotlight`
- shell host behavior: `/usr/share/omarchy/shell/shell.qml`,
  `/usr/share/omarchy/shell/services/PluginRegistry.qml`

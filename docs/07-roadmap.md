# 7. Roadmap

Phase 0 is what exists today. The later phases are proposals, not hidden code.
Nothing is implemented unless it is in the Phase 0 table below.

## Phase 0 — done

| Item | Evidence |
|---|---|
| Four lenses with `Tab` / `Shift+Tab` | `Model.LENS_ORDER`, `Spotlight.cycleLens` |
| `SUPER+SPACE` resets to Everything | `Spotlight.open` third branch |
| Sigils `?`, `@`, `>` | `Spotlight.setFilter` |
| Chord typeahead | `Model.toCandidate` + `Ranker` keyword matching |
| Fuzzy ranking (Raycast algorithm via omacast) | `Model.fuzzyMatch`, `rankCandidates`, `compareMatched` |
| Short-query floors and title-only mode | `Model.shortFloor`, `buildRecord` |
| Natural numeric order | `Model.collate` |
| Frecency (10-day half-life) | `spotlight snapshot` (jq) + `Model.toCandidate` |
| Learned terms from launches | `Spotlight.activate` (`data.query`) + snapshot `terms` |
| Shortcut rows execute their binding | `spotlight run` + Omarchy keybinding cache |
| Actions come from Omarchy's menu tree | `Model.parseMenu` / `mergeMenu` + `FileView` |
| `when` / `disabled` guards | `Model.guardScript` + `parseGuards` (one bash pass) |
| Enter focuses an open window | `Spotlight.windowsFor` + `bringForward` |
| `Shift+Enter` launches a new window | `Keys.onPressed` + `activate(index, true)` |
| Files lens + recent files | `spotlight files`, `Model.toFileRow` |
| Opening a file uses the MIME handler | `gio open` on activation |
| Live keybinding catalog | `Process` + `omarchy menu keybindings --print` + `Model.parseShortcutLine` |
| App rows from `AppLibrary` | `Spotlight.prepare` |
| App launch + launch event | `Spotlight.activate` |
| JSONL writer | `Capture.qml` `Process` + `cat >>` |
| Focus capture with dedupe | `Capture.captureFocus`, `record` |
| Debounced snapshot | `statsDebounce` (1200 ms), `snapshotProcess` |
| Snapshot read/watch | `FileView` + `loadSnapshot` |
| For you / Recent | `Storage.smartPicks` |
| Filtered frequency (no pin/dismiss inflation) | `Storage.usageCount` |
| Unknown-id filtering | `smartPicks` + `Model.findById` |
| Cold-start fallback | `FOR_YOU` / `RECENT` + app fill |
| CLI + IPC bridge, auto snapshot on `record` | `~/.local/bin/spotlight`, `IpcHandler` |
| Kill switch (file + CLI + IPC) | `spotlight.json`, `spotlight capture`, `record` |
| Live app catalog while open | `AppLibrary.appsChanged` connection |
| Spotlight centered in the bar | `shell.json` (`center`) + `BarWidget.qml` |
| Stock menu keeps the left launcher slot | `shell.json` (`left`), no `clonedFrom` |

Known Phase 0 gaps and sharp edges, in priority order:

1. Pin/dismiss are schema-only.
2. No dwell time, compaction or retention.
3. A shell restart records the currently focused app as one focus event.
4. Bookkeeping timestamps (`pin`/`unpin`/`dismiss`) are excluded from frequency
   but still feed `last`, so they can affect Recent ordering.
5. There is no `spotlight reset` command.
6. `custom` events for an existing `app:` id count toward that app; only ids
   with no command row are ignored.
7. A learned term is only as good as the id it was stored against; an external
   producer that guesses a different id for the same app gets its own row.
8. Files are name matches only: no content search, no ranking against apps, and
   no usage learning for paths.
9. Menu guards run at startup and on each open; a change made outside Spotlight is
   reflected the next time the overlay opens, not live while it is open.

## Phase 1 — make the surface feel learned

### 1a. Ranking — shipped in 0.4.0

The planned `buildBoost` map was superseded by porting a real ranker. Instead of
bolting a usage multiplier onto a 0..4 substring score, `Model.js` now carries
Raycast's root-search algorithm (via omacast) and the snapshot carries a decayed
`frecency` per id. Ranking, not just the empty view, is usage-aware.

0.5.0 added the rest of the "learned surface" pass that was not ranking:

- shortcut rows execute their binding through `spotlight run`;
- Enter focuses an open window, `Shift+Enter` forces a new one;
- a files lens backed by `spotlight files`, opened with `gio open`.

What shipped:

- `fuzzyMatch` dynamic programme with word-boundary bonuses;
- bucketed comparison (pinned+text, pinned, text, rest);
- exact alias > exact search term > exact title > prefix ordering;
- frecency with a ten-day half-life, derived from the log at snapshot time;
- learned terms with a 17-day window, which can recall a row;
- natural numeric collation.

What is deliberately not done:

- no configurable `rootSearchSensitivity` yet — the floors are constants in
  `Model.shortFloor`;
- no 10k-id performance fixture; the catalog is ~316 rows and the matcher runs
  per keystroke without a visible delay;
- no pin priority yet, though `Model` already reads `pinPriority` and
  `compareMatched` already has the pinned buckets.

### 1b. Pins and dismiss

Schema already has `pin`, `unpin`, `dismiss`. The frequency side is already
implemented: `Storage.usageCount()` excludes those three, so a pin cannot inflate
`used N×`. The missing parts are storage semantics, UI and `last` isolation.

Proposal:

- `pin` / `unpin` events with `id`, `source`, optional `label`.
- `dismiss` with `id` and `data.until` (ms) or a default cooldown (7 days).
- Snapshot gains additive fields:

  ```json
  {
    "v": 1,
    "generatedAt": 1795171414493,
    "events": 32,
    "items": {
      "app:chromium": { "count": 16, "last": 1795171294030, "types": { "focus": 15, "launch": 1 } }
    },
    "pins": ["app:chromium"],
    "dismissed": { "app:slack": 1795172000000 }
  }
  ```

  `v` can stay 1 if consumers treat the new fields as optional; otherwise bump
  to 2 and keep a reader for 1. Verify the choice before shipping.
- A **Pinned** section above For you, always visible, regardless of query?
  Probably only for the empty All view; a query should still search pins in
  place.
- Dismiss removes a row from the smart block until the cooldown, not from
  search. Dismissing an app you searched for would be surprising.
- Keys: `Ctrl+P` toggles pin, `Ctrl+D` dismisses. Both act on the selected row
  and write an event through `Capture.record`, so the same bridge sees them.
- Visual: a small pin glyph on pinned rows, not a new column.

Security: pin/dismiss are data. They must not carry commands. A pinned id still
resolves through the catalog; if the app is uninstalled, the pin is ignored.

### 1c. Kill switch UI

The file and CLI already work. A UI toggle needs a safe path that does not
introduce event-driven execution.

Proposal:

- Add `capture(on: string): string` or `setCapture(enabled: string): string` to
  the `IpcHandler`, which sets `Capture.enabled` and writes the config file
  atomically.
- Add a row for it to Omarchy's menu extension file
  (`~/.config/omarchy/extensions/omarchy-menu.jsonc`) with a dedicated
  `spotlight:` route that Spotlight handles explicitly, not a shell string.
- Show the state in the row's `detail` ("On" / "Off").
- Or put the toggle in the bar widget's context menu if the shell exposes one.

Do not implement this by having a row run `spotlight capture off` as an
unreviewed shell string. The action catalog is trusted because it is Omarchy's
own file; a kill switch that disables recording should not depend on a command
string that a query can reach.

## Phase 2 — installs from `pacman.log`

Goal: after `pacman -S`, the new app is visible and marked, without rescanning
the world on every open.

What is in the log (this machine):

```
[2026-11-15T08:54:00+0000] [ALPM] installed linux-api-headers (7.3-1)
[2026-11-15T08:54:01+0000] [ALPM] installed tzdata (2026e-1)
```

Rules:

- Parse only `installed` and `reinstalled`. Ignore `upgraded`, `removed`,
  `downgraded` and dependency noise unless you explicitly want it.
- That means a package upgrade does **not** count as a new app. Good.
- A reinstall of an existing app bumps its last-seen install time but does not
  duplicate the row.

Incremental offset:

- State file: `~/.local/state/omarchy/spotlight/pacman.offset`.
- Store `{ inode, size, offset, lastTs }`.
- On read: `stat` the log; if inode changed or size < offset, treat it as
  rotated/truncated and start at 0 (or at EOF, see below); otherwise seek to
  `offset` and read the new bytes.
- Advance the offset only after the parsed batch is committed.
- Never write, rotate or truncate `/var/log/pacman.log`. It is read-only input.

First run:

- Importing the entire log would mark hundreds of packages as "new". Start at
  EOF and only react to future installs, or import the last N days behind a
  config flag. Pick one and document it.
- The log may contain the base install from image build time; those are not
  "new to the user". Verify on a fresh machine.

Map package → desktop id:

- `pacman -Ql <pkg>` lists files but spawns pacman per package. Acceptable for
  a batch of new installs, not for a full scan.
- Alternative: read `/var/lib/pacman/local/<pkg>-<version>/files` and filter
  `/usr/share/applications/*.desktop`. Verify permissions on this machine;
  pacman's local DB is normally world-readable.
- Then parse the `.desktop` `Name`/`Icon`/`NoDisplay` or, better, let
  `AppLibrary` resolve the id. You only need the id; the catalog already has
  the row.
- Flatpak installs do not appear in `pacman.log`. They need a separate provider
  later.

Output:

- A `recentInstalls` map in the snapshot or a separate
  `~/.local/state/omarchy/spotlight/installs.json` cache:
  `id -> installedAt`.
- A "New" section in the Apps lens (last 14 days), or a small dot on the row.
  Do not reorder the entire catalog by install time.

Acceptance:

- Install a package in a VM: if Spotlight is open, the app appears live; if it
  is closed, the next open shows it.
- Restart the shell, the offset is not reprocessed.
- Rotate/truncate the log, the parser does not crash and does not duplicate.
- No full-log parse on a normal open.
- `pacman.log` mtime is unchanged by Spotlight.

Privacy note: package names reveal installed software. The cache stays in the
user's state dir with the same permissions as `events.jsonl`. Do not upload it.

## Phase 3 — transitions

The surface currently appears via `OverlayWindow`'s scale-ready reveal, with no
custom motion. Phase 3:

- 120–160 ms opacity + slight scale on the card; no bounce.
- Do not animate before `contentRevealed` is true, or the first frame will be
  stretched.
- Respect the theme's animation setting if the shell exposes one; verify the
  token rather than hard-coding.
- Avoid animating list layout (height changes on filter) — it fights the
  `ListView` and can cause loops.
- A short fade for section headers is enough; rows should not cascade.

Acceptance: opening and closing at 60 Hz feels immediate; no missing first
frame; no layout warnings.

## Later

| Item | Notes |
|---|---|
| Executable actions tree | Static, reviewed table; confirmation for destructive actions; never derive a command from `id`/`data` |
| Per-app providers | A registry keyed by appId; a plugin can contribute rows without forking Spotlight; needs a host capability and a security review |
| Compaction / retention | Rewrite the log into a snapshot + archive; atomic; keep pins; document that counts survive but raw history does not |
| Dwell time | Record focus start/end and aggregate duration; new event type or `data.dwellMs`; useful for ranking, risky for privacy |
| Search ranking | Phase 1 boost; later fuzzy matching and aliases |
| i18n | Lens labels, empty states, footer; `Commons.I18n` exists; strings are currently English |
| Flatpak/webapp ids | Normalize ids and match against `AppLibrary`; verify actual ids before claiming support |
| Menu route compatibility | Not a goal; the stock menu keeps its tree |

## Non-goals

- Cloud sync, telemetry, accounts.
- Executing anything found in `events.jsonl`.
- Reimplementing the stock menu's JSONC route engine.
- Replacing `omarchy.menu` for theme/background/power. Those remain the stock
  menu's job.

## Risks

| Risk | Mitigation |
|---|---|
| Usage makes search feel unpredictable | Frecency reorders inside a bucket; it cannot lift a weak match over a strong one |
| Running a shortcut becomes a command execution path | The command comes from the user's own Hyprland config through Omarchy's cache; event data is never interpreted |
| Running an action becomes a command execution path | The command comes from Omarchy's read-only menu definition; `disabled` rows refuse; event data is never interpreted |
| File search leaks document names | Paths are searched locally and never recorded; hidden paths are skipped |
| Pin/dismiss data becomes a command channel | Store ids only; resolve through the catalog; no command strings |
| `pacman.log` parsing is slow or fragile | Incremental offset, read-only, first-run policy, truncation handling |
| Per-keystroke cost grows with history | Ranking is O(catalog); history is one number per id from the snapshot, never parsed in the UI |
| Shell update changes tokens/APIs | Re-run `omarchy plugin validate`, smoke-test the overlay, keep docs current |
| Privacy drift | No titles, no window contents; query text is opt-out via `learnTerms`; no network |

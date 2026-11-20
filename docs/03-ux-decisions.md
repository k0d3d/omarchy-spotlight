# 3. UX decisions

The surface is deliberately small: a search field, a list, a lens chip, and a
footer. Everything below is a decision about what to leave out.

## One surface, five lenses

There is no home screen, no submenu, no tabs row. The lens is a filter over one
flat catalog:

| Lens | How you get there | Empty-query contents |
|---|---|---|
| Everything | default; `Tab`; `Esc` from another lens | For you / Recent (smart or cold-start) |
| Apps | `@`; `Tab` | first 16 app rows, one section |
| Actions | `>`; `Tab` | first 16 rows of Omarchy's menu tree, in menu order, one section |
| Shortcuts | `?`; `SUPER+K`; `Tab` | first 16 rows of the live keybinding catalog, one section |
| Files | `Tab` (last) | files modified in the last 30 days under `$HOME`, newest first |

Everything also appends a **Files** section after the ranked groups when the
query is at least three characters, so a file can be reached without switching
lenses. Files never appear in the empty view; that stays the usage block.

The lens name lives in a small chip on the right of the input:

```qml
Text { text: Model.lensLabel(root.lens) }   // "Everything", "Apps", …
```

The chip is also a button: clicking it cycles forward. There is no dropdown and
no tab bar. A tab bar would cost a row of vertical space and would suggest that
the four views are separate places rather than four filters over the same data.

**Tradeoff:** discoverability. A first-time user sees only "Everything" and the
footer hint `⇥ Lens`. The alternatives were a permanent four-tab header (noisy,
and it fights the single-input idea) or a help overlay (another surface). The
chip plus `Tab` plus the `?` hint is the compromise.

## Sigils instead of modes

The first character of the input can switch the lens:

| Type | Lens | Input after the sigil |
|---|---|---|
| `?` | Shortcuts | everything after `?` |
| `@` | Apps | everything after `@` |
| `>` | Actions | everything after `>` |

Implementation, in `Spotlight.setFilter()`:

```js
if (next.charAt(0) === "?") { nextLens = "shortcuts"; next = next.slice(1) }
else if (next.charAt(0) === ">") { nextLens = "actions"; next = next.slice(1) }
else if (next.charAt(0) === "@") { nextLens = "apps"; next = next.slice(1) }
```

The sigil is consumed: `?` alone switches to Shortcuts and leaves an empty
filter, and the `?` disappears from the field when `filterText` is synced back.
Typing `?sup` switches to Shortcuts and searches `sup`.

**Tradeoff:** sigils are invisible unless you know them. They also only work at
position 0 — a `?` in the middle of a query is literal. There is no escape for a
literal leading `?`; if you need one, the sigil behavior wins. This is a
power-user shortcut, not the primary path. `Tab` and the chip are the
discoverable paths.

The alternative was vim-style modes (`/`, `:`, `@`) with a mode indicator. That
adds state to the input and makes every keystroke conditional. A leading sigil
keeps the field a plain text input.

## Chords are searchable text

The row for File manager stores:

```js
{ label: "File manager", chord: "SUPER + SHIFT + F" }
```

`normalize()` lower-cases and replaces non-alphanumerics with spaces:

```
"SUPER + SHIFT + F"  →  "super shift f"
```

So typing `super shift f` in the **Everything** lens matches the chord even
though the label is "File manager". `Ranker` scores the label first, then falls
through to the chord when the query starts with a modifier:

```js
// toCandidate + buildRecord
chord: chordKeyword(command.chord)          // "SUPER + SHIFT + F" -> "SUPER SHIFT F"
if (!titleOnly && c.chord && /^(super|sup|ctrl|alt|shift|print|fn)\b/.test(q)) {
  keywords.push(String(c.chord))
}
```

The modifier gate is deliberate. Without it a chord is just another keyword, and
`calc` matched "SUPER CTRL ALT C" on Screenshot. With it, typing `super`,
`ctrl`, `alt`, `shift` or `print` searches the bindings; typing a word searches
names.

That is the "typeahead chord" moment: the user does not need to know that a
Shortcuts lens exists, or press `SUPER+K` first. They type the chord they half
remember, and the row appears with the chord printed on the right.

**Tradeoff:** chord text is keyboard-layout dependent. `SUPER + SHIFT + F` is
the label this desktop uses; a user with a different layout sees the same text
but may type different physical keys. The camera-facing benefit is bigger than
the edge case: it teaches the binding.

Also note that the chord is a *string*, not a live key capture. Pressing the
actual chord while the overlay is open is intercepted by the compositor and
usually does something else (or nothing). The overlay owns the keyboard
exclusively; chords are content, not shortcuts.

## Chords on every row

Shortcut and action rows print `chord` on the right. App rows print nothing,
because a launched app usually has no global chord.

Row anatomy:

```
[icon 20px] [label ............] [detail 110px] [chord]
```

- The label elides before it collides with the detail column.
- The detail column is a fixed `Style.space(110)` and elides. It holds the app
  subtext (often a version), "System"/"Appearance" for actions, or "used 16×" /
  "4m ago" for smart rows.
- The chord is right-aligned and only takes its natural width when non-empty.

The fixed detail width replaced a `Math.min(implicitWidth, …)` binding that
caused a layout loop (see the dev log). A stable column is less clever and more
predictable; long app subtitles elide instead of resizing the row.

### Selected rows hide their detail

```qml
text: rowItem.selected ? "" : (modelData.detail || "")
visible: text.length > 0
width: visible ? Style.space(110) : 0
```

When the row is selected, the detail disappears and the label gets the space.
The rationale is that the selected row is the one you are about to act on; the
secondary text is noise at that moment. It also gives the selection a visible
change beyond the background tint.

**Tradeoff:** on a smart row, selecting it hides the very number that explains
why it is there (`used 16×`, `4m ago`). It is a deliberate calm-over-density
choice, but it is the first thing to revisit if the list starts to feel
information-poor.

## Two-stage Esc

`Esc` is a small state machine:

```js
if (event.key === Qt.Key_Escape) {
  if (root.filterText) root.setFilter("")
  else if (root.lens !== "all") root.setLens("all")
  else root.close()
  event.accepted = true
}
```

1. If there is a filter, clear it.
2. Else if the lens is not Everything, reset to Everything.
3. Else close.

`Backspace` on an empty filter is a second way to reset the lens without
closing. That is useful when the input already has focus and the user's hand is
on the keyboard.

**Tradeoff:** closing from an Apps/Shortcuts lens takes two `Esc` presses. That
is intentional — one `Esc` should undo the most recent narrowing, not throw away
the surface. It can feel slow if you opened `SUPER+K` and only wanted to dismiss
it. The alternative (always close) loses the "undo my filter" behavior, which is
used far more often.

## The card

The surface is an `OverlayWindow` with a centered `BorderSurface`:

- width: `min(Style.space(600), overlay.width - Style.gapsOut * 2)`
- height: content height + border/padding insets, capped by the screen
- radius: `max(0, Style.cornerRadius)` — exact theme value, so a square theme
  stays square
- padding: `Style.spacing.panelPadding` (18 px in the default theme)
- row height: `Style.space(38)`
- list cap: `Style.space(420)`

The card sits on a full-screen scrim (`Color.menu.scrim`). A click on the scrim
closes; a click inside the card is swallowed by an empty `MouseArea` so it does
not close. That is the expected modal behavior and it costs two lines.

The overlay opens on the **focused monitor**. `OverlayWindow` resolves
`Hyprland.focusedMonitor` to a `Quickshell.screens` entry on every show, so on a
multi-monitor setup it appears where the user is looking, not on the primary.

The overlay takes exclusive keyboard focus. That is why the input gets
`forceActiveFocus()` on the next tick, and why `wtype` can type into it once it
is open but cannot trigger the global bind that opens it.

## Bottom fade

When the list overflows its 420 px cap, a 26 px gradient fades the last row into
the card background instead of cutting it off:

```qml
visible: resultList.contentHeight > resultList.height
gradient: Gradient {
  GradientStop { position: 0; color: Util.alpha(root.background, 0) }
  GradientStop { position: 1; color: root.background }
}
```

It is a cheap affordance: "there is more below". Without it, a clipped row looks
like a rendering bug. The fade is drawn over the list, not part of it, so it
never intercepts clicks.

## Section headers and grouping

A query in the Everything lens groups results in a fixed order: **Apps**,
**Actions**, **Shortcuts**. Each group gets a 24 px header with uppercase,
letter-spaced caption text at 40% opacity. The grouping is stable and
predictable; an app never appears below an action just because its score is
slightly lower.

An empty query in a specific lens shows one section named after the lens, capped
at 16 rows. This is not ranked; it is a browse view. The smart block is only for
Everything, because "For you" inside "Actions" would be a different product.

**Tradeoff:** grouping by kind can bury a perfect shortcut match below a weak
app match. The alternative — one flat ranked list — makes the top result better
but makes the list harder to scan. The current choice favors predictability and
teaches the three kinds.

## Keyboard first, mouse allowed

- `↑` / `↓` wrap. `onSelectedIndexChanged` calls
  `positionViewAtIndex(index, ListView.Contain)` so the selection is always
  visible.
- Hovering a row selects it (`onEntered: root.selectedIndex = index`). There is
  no separate hover highlight; hover and keyboard share one selection.
- Clicking a row activates it immediately (no double-click, no confirm).
- `Enter` and `→` both activate. `→` is there because the input caret is pinned
  to the end, so the key would otherwise do nothing useful.
- Clicking the scrim closes.

**Tradeoff:** hover-to-select can move the selection when the mouse happens to
rest over the list. The alternative is a separate pointer highlight, which adds
a second visual state to a surface that is trying to stay quiet.

## Empty states and microcopy

- No filter, empty list: `Nothing here yet`.
- Filter with no matches: `No matches for "…"` with curly quotes.
- Placeholder: `Search apps, actions, shortcuts, files…`.
- Footer: `↵ Open`, `⇧↵ New`, `⇥ Lens`, `? Shortcuts`, `esc Close`.
- Result count on the right: `N results`.

`↵ Open` is the only verb now, and it is honest for every row: an app opens or
focuses, a shortcut runs its binding, an action runs Omarchy's menu command, a
file opens in its default handler. `⇧↵ New` is the one exception worth spelling
out, because apps are the only rows where "open a second one" means anything.

## The bar button

`BarWidget.qml` reuses the stock `BarIconButton` but not its identity:

- magnifier glyph (`\uf002` in `JetBrainsMono Nerd Font`), so the button says
  "search" instead of repeating the Omarchy logo,
- left-click runs
  `omarchy-shell shell toggle k0d3d.spotlight '{"menu":"root"}'`,
- right-click runs `xdg-terminal-exec`.

Spotlight sits beside the clock in the bar's `center` section. The stock menu
keeps the left launcher slot for theme, background and power, because a
bar-widget is only enabled while it has a bar placement. That split keeps the
old system-menu muscle memory on the left and puts the search surface where the
eye already goes for the clock.

## What is deliberately absent

- **No preview pane.** A preview would halve the list width and turn a launcher
  into a file browser. Apps already have icons and subtext.
- **No animations yet.** The overlay uses `OverlayWindow`'s scale-ready reveal,
  but there is no custom open/close transition. Phase 3 territory.
- **No favorites/pins UI.** The event types exist in the schema, but nothing
  emits or renders them.
- **No accessibility story.** Quickshell gives keyboard navigation but there is
  no screen-reader layer here; this needs verification against the host, not a
  claim.
- **No theme-specific art.** Every color comes from `Color.menu.*`; the surface
  should follow a theme change without edits.

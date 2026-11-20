# 1. Origin story

## The goal

I wanted one surface that answers "what do I want to do?" without making me
choose a menu tree first. Apps, yes, but also the menu actions I actually use
(lock, bar, background, theme, screenshot) and the keybindings I can never
remember. One input, one ranked list, and the chord printed on every row so the
surface teaches the keyboard instead of hiding it.

The concrete target was:

- `SUPER+SPACE` opens the surface with the input focused and resets to the
  Everything lens.
- Typing `super shift f` finds **File manager** even though the row is a
  shortcut, not an app, and even though the user never opened a shortcuts view.
- `SUPER+K` opens the same surface already filtered to Shortcuts.
- The top of the list is fed by what I actually launch and focus, not by a
  hard-coded demo list.

The last point is what turned this from a UI experiment into a small data
project. A launcher that shows fake recents is a mockup. A launcher that shows
the app you were just in is a tool.

## The constraints

These constraints shaped almost every decision:

1. **`/usr/share/omarchy` is read-only.** The shell, the stock menu and the
   theme tokens belong to the distribution. I can read them, import them, and
   learn from them, but I cannot patch them. Anything I build has to survive an
   `omarchy` update.
2. **No second shell process.** Omarchy runs one long-lived Quickshell process
   that hosts the bar, panels, overlays, menus and services. A plugin is loaded
   into that process. Launching another Quickshell instance would duplicate the
   bar, lose the shared `AppLibrary`, and fight the layer-shell surfaces.
3. **The plugin contract is small.** A directory under
   `~/.config/omarchy/plugins/`, a `manifest.json`, and an entry point per kind.
   No build step, no private API. The host injects `omarchyPath`, `shell` and
   `manifest`; a `menu` plugin also gets an `AppLibrary` facade.
4. **The desktop is Lua-configured.** Hyprland bindings are declared with
   `o.bind` / `o.rebind` in `~/.config/hypr/bindings.lua`, not with
   `bind = ..., exec, ...` lines. Rebinding a default is a supported operation,
   which matters later.
5. **No new daemon.** Events have to be written by something already running.
   The shell process is already running and already knows which toplevel has
   focus. Use it.

## Why not a fork

The obvious shortcut is to copy `omarchy.menu` and edit it. I read it first.
`/usr/share/omarchy/shell/plugins/menu/Menu.qml` is about 65 KB and
`MenuModel.js` is about 29 KB. It contains:

- a JSONC menu definition loader (`omarchy-menu.jsonc` plus a user extension
  file), with `when:` / `checked:` shell expressions evaluated in batches;
- route navigation (`openRoute`, aliases, `initialMenu`, dmenu mode);
- i18n catalog application;
- action execution through `Quickshell.execDetached`;
- the full visual language of the stock menu.

Forking that means inheriting all of it and merging it on every upstream change.
It also means the fork's identity is "the stock menu, but different", which is
exactly the shape that caused the `clonedFrom` problem described below.

More importantly, the interaction model is different. The stock menu is a tree:
you open a route, then a submenu, then an item. Spotlight is a flat, ranked
projection of a catalog with four filters. Sharing the renderer would have meant
carrying a tree engine I do not use.

So the decision was:

> Build a standalone `menu` plugin from first principles. Borrow the host's
> surface primitives and theme tokens, not its menu model.

That is also why the plugin id is `k0d3d.spotlight` and the manifest has no
`omarchy.clonedFrom` metadata. It is not a clone.

## The thesis: rows are a projection

The single most useful idea in the codebase is that the visible list is a pure
function of four inputs:

```
rows = Model.group(commands, lens, filterText, smart)
```

- `commands` is a flat array: Omarchy menu actions + live keybinding rows + live apps.
- `lens` is one of `all`, `apps`, `actions`, `shortcuts`.
- `filterText` is the input after the leading sigil has been consumed.
- `smart` is `{ forYou, recent }`, derived from usage signals.

No row owns state. No delegate mutates the model. Reopening the surface rebuilds
`commands` from `AppLibrary`, re-reads the snapshot into `smart`, and the list
falls out. That is why the "For you" block can be swapped from curated demo data
to real usage without touching the renderer, and why the whole grouping and
scoring layer is testable in plain Node.

The same idea applies to storage: the UI never parses `events.jsonl` on a
keystroke. A separate process aggregates the log into `snapshot.json`, and the UI
only ever sees a small `id -> { count, last, types }` map.

## What was deliberately cut

Two decisions are worth calling out because they are easy to add and hard to
take back:

1. **No execution from event data.** Events can name an id and carry a free-form
   `data` object, but nothing in the UI turns an event into a command. The only
   executable path is a row whose `kind` is `app`, launched through
   `AppLibrary.launch(appId)`. Actions and shortcuts currently just log. This
   keeps the shared log a *record*, not a remote-control channel.
2. **No window titles.** Focus capture stores `appId`, the namespaced id, the
   source and the timestamp. Titles are useful for debugging and terrible for a
   log that other tools can read. The privacy boundary is: which app, when, how
   often — not what was in the window.

## Timeline in one paragraph

The first version was a wireframe: a centered card, a `FilterInput`, static rows,
and hard-coded `FOR_YOU` / `RECENT` arrays in `Model.js`. That proved the layout
and the keyboard model. The second version merged `AppLibrary` so apps were real.
The third added `Capture.qml` and the `spotlight` CLI: focus and launch events,
a debounced snapshot, and `smartPicks` replacing the curated arrays when history
exists. The fourth exposed the same data over IPC and documented it. The fifth
ported Raycast's ranker, added frecency and learned terms. The sixth made Enter
real: shortcuts run their bindings, apps focus instead of duplicating, files
open through the desktop's MIME handler, and the actions lens is Omarchy's own
menu tree. The current state is Phase 0 complete: the surface is usable and the
data is real.

## What I would tell someone starting today

- Read the stock menu for its *host integration*, not for its data model.
- Keep the row model pure. If you can run it in Node, you can debug it without
  restarting the shell.
- Treat the event log as a public file from day one. It forces a schema, a
  version field and a normalization step.
- Do not use `clonedFrom` unless you actually want to replace the source plugin.
  It is a routing declaration, not a "based on" note. (See
  [04-omarchy-integration.md](04-omarchy-integration.md).)
- Rebuild the aggregate, not the UI. The UI should never grow a JSONL parser.

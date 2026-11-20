# 4. Omarchy integration

This is the part that is easy to get wrong: the plugin does not own its
lifecycle. The shell does. This doc follows the host contract from
`/usr/share/omarchy/shell/shell.qml` and
`/usr/share/omarchy/shell/services/PluginRegistry.qml`, and then explains the
`clonedFrom` failure.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "k0d3d.spotlight",
  "name": "Spotlight",
  "version": "0.4.0",
  "author": "k0d3d",
  "description": "First-principles command center: apps, actions and shortcuts in one surface, with a shared usage bridge",
  "kinds": ["menu", "bar-widget"],
  "keepLoaded": true,
  "entryPoints": {
    "menu": "Spotlight.qml",
    "barWidget": "BarWidget.qml"
  },
  "barWidget": {
    "displayName": "Spotlight",
    "description": "Opens the Spotlight command center",
    "category": "Compositor",
    "allowMultiple": false
  }
}
```

Validate it with the same checks the shell uses:

```bash
omarchy plugin validate /home/k0d3d/.config/omarchy/plugins/k0d3d.spotlight
```

The validator enforces `schemaVersion === 1`, required fields, a safe id that
does not use the reserved `omarchy.*` namespace, safe relative entry points that
exist, no symlinks, and an entry point for each kind that needs one.

### `kinds`

- `menu` — the component is a full-screen surface driven by `open()` / `close()`.
  It also makes the shell inject an `AppLibrary` facade.
- `bar-widget` — the component is mounted inside the bar. It gets the bar API,
  not the menu loader.

A manifest can have both. Each kind has its own entry point and its own loading
path:

| Kind | Entry point key | Host loader |
|---|---|---|
| `menu` | `entryPoints.menu` | panel `Loader` with `keepLoaded`/`openPanelIds` |
| `bar-widget` | `entryPoints.barWidget` | `BarWidgetRegistry`, one instance per bar slot |

### `keepLoaded`

`keepLoaded: true` is why `Capture.qml` runs before the first open:

```qml
// shell.qml, panel loader delegate
active: panelEntry.sourceUrl !== "" &&
        (panelEntry.keepLoaded || shell.openPanelIds[panelEntry.pluginId] === true)
```

Without it, the menu component would be constructed on first summon and
destroyed on hide, and focus capture would only exist while the overlay was
open — useless for "what did I use today". The bar widget is mounted separately
by the bar's widget registry; `keepLoaded` is about the menu/panel loader, and
the capture layer lives in `Spotlight.qml`, so the `menu` entry is the one that
matters here.

### Enablement

`PluginRegistry.isEnabled()` decides whether a plugin is loaded at all:

- For a manifest with kind `bar`, the plugin is the selected bar option.
- Otherwise, if the id is listed in `disabledPlugins`, it is off.
- First-party non-bar plugins are on by default.
- Every other plugin must be referenced somewhere in `shell.json`: a bar layout
  entry, a `plugins[]` entry, or the active `bar.id`.

This plugin is third-party, so it needs one of those references. This machine
uses a bar layout entry in `center`; `plugins` is empty. Both work:

```json
{ "bar": { "layout": { "center": [ { "id": "k0d3d.spotlight" }, { "id": "omarchy.clock" } ] } } }
```

```json
{ "plugins": [ { "id": "k0d3d.spotlight" } ] }
```

The first gives a button; the second only makes the menu summonable. In both
cases `keepLoaded` mounts the menu component at startup. `omarchy plugin list`
judges a `bar-widget` by its bar placement, so the `plugins[]` form can still
read as "disabled" there even though the menu component loads.

## The `menu` lifecycle

The shell treats `menu` as one of the panel kinds. `computePanelEntries()` scans
for `panel`, `overlay`, `menu` and picks one kind per plugin:

```js
var kind = m.kinds.indexOf("panel") !== -1 ? "panel"
  : (m.kinds.indexOf("overlay") !== -1 ? "overlay" : "menu")
```

Spotlight has `menu` + `bar-widget`, so it gets a panel entry of kind `menu`
plus a separate bar widget component. The panel entry is instantiated by an
`Instantiator` with a `Loader`; the loader injects:

```js
item.omarchyPath = shell.omarchyPath
item.shell = shell.pluginShellFor(panelEntry.manifest)
item.manifest = shell.publicPluginManifest(panelEntry.manifest)
```

`Spotlight.qml` declares the first two and uses `shell.appLibrary`. The
`appLibrary` property is only non-null when the manifest has kind `menu`:

```js
appLibrary: shell.manifestHasKind(manifest, "menu")
  ? shell.pluginAppLibraryFor(cacheKey, key) : null
```

That is the reason this plugin is a `menu` and not an `overlay`: an overlay
would not get the app catalog.

### summon / hide / toggle

The public commands are thin wrappers over shell functions:

```bash
omarchy-shell shell summon k0d3d.spotlight '{"lens":"apps"}'
omarchy-shell shell hide   k0d3d.spotlight
omarchy-shell shell toggle k0d3d.spotlight '{"menu":"root"}'
```

- `summon(id, payloadJson)` resolves the enabled id, checks `isEnabled`, adds the
  id to `openPanelIds`, queues the payload, and calls `open()` immediately if
  the loader already has an item.
- `hide(id)` calls `close()` on the loaded item and removes the id from
  `openPanelIds`.
- `toggle(id, payloadJson)` calls `isPluginOpen(id)` first. Open → `hide`;
  closed → `summon`.
- `isPluginOpen(id)` prefers the plugin's own `opened` property:

```js
var loader = panelLoaders[id]
if (loader && loader.item && loader.item.opened !== undefined)
  return loader.item.opened === true
return openPanelIds[id] === true
```

So the plugin owns the truth about whether it is visible, but the shell owns the
loader and the payload queue. `opened` must be a property, and `open()`/`close()`
must be functions with those exact names.

The shell does not call `close()` on a plugin that is not loaded, and it drops a
payload if the plugin is disabled. A disabled plugin has no loader, so
`openPanelIds` would otherwise create an invisible "open" state.

### Payload convention

The payload is a JSON **string**. The shell keeps it as a string and hands it to
`open()`; the plugin parses it. Spotlight accepts:

| Payload | Effect |
|---|---|
| `{"lens":"shortcuts"}` | open at Shortcuts |
| `{"lens":"apps"}` | open at Apps |
| `{"menu":"shortcuts"}` | open at Shortcuts (compatibility form) |
| `{"menu":"root"}` | open at Everything (lens reset) |
| `{}` / invalid | open at Everything (lens reset) |

The `{"menu":"root"}` case is what the bar button and the `SUPER+SPACE` rebind
send. It intentionally mirrors the stock menu's payload shape. With no lens
payload, `open()` sets `lens = "all"`, so `SUPER+SPACE` always lands on
Everything.

## `OverlayWindow`

`Spotlight.qml` does not create a raw `PanelWindow`. It uses the shell's
`OverlayWindow`:

```qml
OverlayWindow {
  id: overlay
  shown: root.opened
  WlrLayershell.namespace: "k0d3d-spotlight"
  // …
}
```

What that buys:

- **Focused monitor.** On `shown`, `OverlayWindow` sets `targetScreen` to
  `Hyprland.focusedMonitor` resolved against `Quickshell.screens`. On a
  multi-monitor desk, the surface appears where the pointer/keyboard focus is.
- **Exclusive keyboard.** `shownKeyboardFocus: WlrKeyboardFocus.Exclusive` by
  default, so the input receives keystrokes and the compositor does not pass
  them to the app underneath.
- **Scale-safe reveal.** It keeps the surface transparent until Qt has the
  output scale and full-screen geometry, then reveals on the next event-loop
  turn. That avoids a smaller opening frame being stretched across the output.
- **Monitor changes.** If the target screen disappears while open, it closes the
  old surface and maps a replacement on the next tick.
- **RTL.** It mirrors content when `I18n.rightToLeft`.

The namespace `k0d3d-spotlight` is what a Hyprland *layer* rule or a
screenshot/screencast selector would match (a normal window rule matches
toplevel class/title, not a layer surface). Verify the exact app id your
compositor reports if you write rules against the toplevel; the layer namespace
and the toplevel appId are not the same thing.

## Theme tokens

The surface uses the menu's tokens rather than hard-coded colors:

| Token | Use |
|---|---|
| `Commons.Color.menu.background` | card fill |
| `Commons.Color.menu.text` | primary text |
| `Commons.Color.menu.border` | card border |
| `Commons.Color.menu.scrim` | full-screen scrim |
| `Commons.Color.menu.selectedBackground` | selected row + lens chip |
| `Commons.Color.menu.selectedText` | selected row text, chip text |

Geometry and type come from `Style`:

| Token | Use |
|---|---|
| `Style.cornerRadius` | card radius, used exactly (`max(0, …)`) |
| `Style.spacing.panelPadding` | card padding |
| `Style.space(n)` | row height 38, list cap 420, icon slot 20, detail 110 |
| `Style.gapsOut` | card width/height margin from the screen edge |
| `Style.spacing.md` / `xs` | column and list spacing |
| `Style.font.menuFamily` | all text and glyphs |
| `Style.font.heading` / `body` / `bodySmall` / `caption` / `iconLarge` | type scale |

The border is a spec, not a color:

```qml
readonly property var borderSpec:
  Border.surfaceSpec("menu", "border", root.border, Math.max(1, Style.space(2)))

BorderSurface {
  borderSpec: root.borderSpec
  padding: root.contentMargin
  // …
}
```

`BorderSurface` is `Rectangle`-compatible but understands per-side widths,
gradients and alpha. It exposes `contentTopInset` / `contentLeftInset` etc., so
the content column is laid out against the border + padding rather than guessing.

The fade uses `Util.alpha(root.background, 0)` to make a transparent endpoint
that still follows the theme.

**Corner behavior:** `corner` is `Math.max(0, Style.cornerRadius)`. There is no
fallback radius, so a theme that sets `decoration:rounding = 0` gets a square
card. The old `cornerRadius` override property and the unused `accent` token
were removed in the post-review pass.

## `AppLibrary`

The shell injects `PluginAppLibraryApi`, a detached facade. It does not expose
the `AppLibrary` item or its parent, only these methods:

| Method | Use in Spotlight |
|---|---|
| `sortedEntries("")` | the full visible app catalog |
| `entryName(entry)` | row label |
| `entrySubtext(entry)` | detail text (often a version) |
| `iconSource(icon)` | resolved icon path (file URL or themed fallback) |
| `launch(desktopId, name)` | start the app |
| `refreshIcons()` | not called; the host refreshes on app changes |
| `remove(desktopId, name)` | not used |
| `appsChanged` signal | connected; `prepare()` runs while open |

`prepare()` rebuilds the app rows on every open. It also listens to
`AppLibrary.appsChanged` and calls `prepare()` when the overlay is open, so an
install appears live rather than on the next open. Installs that arrive while
the surface is closed are picked up by the next `open()`.

`launch()` is the only execution path in the plugin:

```js
capture.record({ type: "launch", id: row.id, appId: row.appId, label: row.label, source: "spotlight" })
root.appLibrary.launch(row.appId, row.label)
```

Note the order: record first, then launch. If the launch fails, the intent is
still logged and the error is caught and warned. If the record is rejected (for
example, capture is off), the launch still happens — `record()` returns false but
the return value is ignored on this path.

## The bar widget

`BarWidget.qml` extends the shell's `BarWidget` base, which injects:

- `bar` — the host `Bar` instance,
- `moduleName` — the canonical id (set here to `k0d3d.spotlight`),
- `settings` — the inline `shell.json` entry,
- `fixedEdge` — layout behavior.

The button uses `BarIconButton` and `root.bar.run(...)`, which is
`Util.execDetached`. The left click is the same command as the keybinding:

```qml
onPressed: function(button) {
  if (!root.bar) return
  if (button === Qt.RightButton) root.bar.run("xdg-terminal-exec")
  else root.bar.run("omarchy-shell shell toggle k0d3d.spotlight '{\"menu\":\"root\"}'")
}
```

Right-click parity with the stock menu is intentional. The bar surface exists
per monitor; the widget itself does not need to broadcast because it only
dispatches a shell command.

## Keybindings: `o.rebind`

Omarchy's Hyprland config is Lua. Defaults are declared in
`/usr/share/omarchy/default/hypr/bindings/utilities.lua`:

```lua
o.bind("SUPER + SPACE", "Omarchy menu", { menu = "root" })
o.bind("SUPER + K", "Keybindings", "omarchy-menu-keybindings")
```

`o.rebind` replaces the existing binding instead of adding a second one:

```lua
o.rebind("SUPER + SPACE", "Spotlight", "omarchy-shell shell toggle k0d3d.spotlight '{\"menu\":\"root\"}'")
o.rebind("SUPER + K", "Spotlight shortcuts", "omarchy-shell shell toggle k0d3d.spotlight '{\"lens\":\"shortcuts\"}'")
```

Consequences:

- `SUPER+SPACE` no longer opens the stock menu. The stock menu keeps the left
  launcher slot and still answers `omarchy menu …` routes, so
  theme/background/power stay reachable; Spotlight sits beside the clock in
  `center`.
- `SUPER+K` no longer runs `omarchy-menu-keybindings`. If you want the old
  keybindings TUI, run `omarchy-menu-keybindings` from a terminal or bind another
  key.
- The shortcut row labeled "Keybindings" with chord `SUPER + K` is now
  self-referential: `SUPER+K` opens this lens. Activating the row runs that
  binding, which toggles the surface.

This is the whole integration. There is no patching of the stock menu, no
`clonedFrom`, and no `disabledPlugins` entry for either menu.

## Stock-menu coexistence on this machine

The relevant `~/.config/omarchy/shell.json` state after the post-review cleanup:

```json
{
  "bar": {
    "layout": {
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
      ]
    }
  },
  "cloneSourceRestores": ["custom.media"],
  "disabledPlugins": ["omarchy.media"],
  "plugins": []
}
```

- `omarchy.menu` keeps the left launcher slot. That placement is what
  enables the plugin; Spotlight is the centered search launcher.
- The stock plugin still answers its routes:

  ```bash
  omarchy-shell shell call omarchy.menu ping '{}'
  # ok
  ```

  `omarchy menu theme`, `omarchy menu background` and the rest keep working
  through the button and their commands.
- `plugins` is empty; the bar entries are what enable both plugins.
- `disabledPlugins` only contains `omarchy.media`, unrelated to this work.
- `cloneSourceRestores` now contains only `custom.media`. The stale
  `k0d3d.spotlight` entry from the `clonedFrom` experiment is gone.

`omarchy plugin list` shows both bar widgets by their placement:

```
omarchy.menu       enabled   first-party  menu,bar-widget  Omarchy menu
k0d3d.spotlight    enabled   third-party  menu,bar-widget  Spotlight
```

Removing `omarchy.menu` from the bar is what makes the shell report it as
disabled; a `plugins[]` entry alone does not count for a `bar-widget`. That is
why the stock button stays even though `SUPER+SPACE` points at Spotlight.

For a `bar-widget`, that column means "is it in the bar?", not "is the
component loadable?" Removing the stock button is therefore not a safe way to
hide it: the list flips to disabled and its routes can stop opening even though
the stock directory is still installed. Keep the placement if those routes
matter.

## The `clonedFrom` trap

This is the most important integration lesson in the project.

### What `clonedFrom` is for

A manifest can carry metadata:

```json
{
  "omarchy": {
    "clonedFrom": "omarchy.menu"
  }
}
```

It is not a "based on" credit. It tells the registry: *this plugin is the
replacement implementation of that source plugin*. The registry uses it in
several places:

1. **Routing.** `resolveEnabledId(id)` scans installed plugins for a manifest
   whose `omarchy.clonedFrom` equals the requested id and which is enabled. If
   found, every shell call for the source id is redirected to the clone:

   ```js
   function resolveEnabledId(id) {
     var key = Util.canonicalWidgetId(String(id || ""))
     for (var candidate in installedPlugins) {
       var manifest = installedPlugins[candidate]
       var metadata = manifest && Util.isPlainObject(manifest.omarchy) ? manifest.omarchy : null
       if (metadata && String(metadata.clonedFrom || "") === key && isEnabled(candidate))
         return candidate
     }
     return key
   }
   ```

   Note that `isEnabled(candidate)` is checked, but the source's own state is
   not part of the decision. If the clone is on, the source id resolves to the
   clone.

2. **Bar replacement.** When a clone is enabled, the registry looks for the
   source's bar entry and puts the clone id in its place, carrying the source's
   inline settings. That is how a cloned widget "takes over" the button.

3. **Disabling the source.** When a clone is enabled and has any non-widget kind
   (`menu`, `panel`, `service`, …), the registry adds the source to
   `disabledPlugins`:

   ```js
   if (clonedFrom && hasNonWidgetKind && !isDisabled(config, clonedFrom)) {
     addDisabled(config, clonedFrom)
     setCloneShouldRestoreSource(config, key, true)
   }
   ```

4. **Restore on disable.** Disabling the clone restores the source's bar entry
   and (if it was marked) re-enables the source.

### What I did

Early on, I added `"omarchy": {"clonedFrom": "omarchy.menu"}` to Spotlight's
manifest. The reasoning was superficial: both are `menu` + `bar-widget`, both
open a centered surface, and the metadata looked like a provenance note. It also
made the bar replacement automatic, which was convenient.

### What broke

- The stock `omarchy.menu` was added to `disabledPlugins`. Its component stopped
  loading.
- Every shell call for `omarchy.menu` was redirected to Spotlight, including
  `omarchy menu theme`, `omarchy menu background`, `omarchy menu power`, and any
  tool that calls `omarchy-shell shell toggle omarchy.menu ...`.
- Spotlight's `open()` does not implement menu routes. A payload like
  `{"menu":"theme"}` fell through to "open and keep the current lens". So the
  theme/background/power routes appeared to do nothing (or opened Spotlight
  instead).
- The stock menu's own bar button, if still placed, resolved to the clone or was
  disabled depending on the config state. The bar and the IPC surface disagreed
  about what "omarchy.menu" meant.

The failure is subtle because nothing crashes. The symptom is "my theme menu
stopped working", not "the plugin is misconfigured". `resolveEnabledId` is
central (summon, hide, toggle, isOpen, service lookup, plugin ownership checks),
so the hijack is broad.

### The fix

1. Remove the entire `"omarchy": { "clonedFrom": ... }` block from the manifest.
2. Re-enable the stock menu:
   `omarchy plugin enable omarchy.menu` (or remove it from `disabledPlugins`).
3. Put the stock menu back in the bar if the clone had replaced it.
4. Bind `SUPER+SPACE` and `SUPER+K` with `o.rebind` instead of taking over the
   ids.
5. Remove the stale `cloneSourceRestores` entry if it was written. In this
   config it is done; only `custom.media` remains.

This is why the final architecture has two independent plugins that happen to
share a surface style, not a clone relationship. The stock menu keeps its tree,
its routes and its execution engine; Spotlight keeps its flat catalog and its
usage log. They coexist because neither claims the other's id.

### When `clonedFrom` is the right tool

Use it when you genuinely are replacing a plugin and want the old id to keep
working — for example, a themed audio widget that should inherit every existing
`omarchy.audio` call and bar placement. Do not use it to mean "inspired by" or
"same shape as". The registry will believe you.

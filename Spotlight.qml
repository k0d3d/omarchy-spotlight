import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model
import "Storage.js" as Storage

// Spotlight — a first-principles command center.
//
// Apps come from AppLibrary, actions and shortcuts are static for now, and
// Capture.qml records launches + focus changes so the smart block is fed by
// real usage instead of demo rows. The point of the surface stays the same:
// one input, one ranked list, chords on every row, lenses for everything.
Item {
  id: root

  // Injected by the shell when this plugin is summoned.
  property string omarchyPath: Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy"
  property var shell: null
  property var manifest: null
  readonly property var appLibrary: root.shell ? root.shell.appLibrary : null

  // Lifecycle: the host calls open(payloadJson) / close().
  property bool opened: false
  property string lens: "all"
  property string filterText: ""
  property int selectedIndex: 0
  property var commands: []
  // Derived, not assigned: a handler that writes `smart` while `rows` is being
  // evaluated is what QML reports as a binding loop on `rows`.
  readonly property var smart: Storage.smartPicks(capture.usage, root.commands, Date.now())

  // Live keybinding catalog from `omarchy menu keybindings --print`, which
  // already merges the shipped bindings with the user's overrides.
  property var shortcuts: []
  property double shortcutsAt: 0
  property var pendingShortcuts: []
  property var pendingShortcutIds: ({})

  // Omarchy's own menu tree: the source of the actions lens. `menuActions` is
  // rebuilt when the JSONC files load or the guard script returns.
  property string menuDefaultText: ""
  property string menuUserText: ""
  property var menuItems: []
  property var menuActions: []
  property var guards: ({ when: {}, disabled: {} })
  property double guardsAt: 0

  // File results come from the bridge, already filtered. They are merged at
  // render time because they change with every query.
  property var fileResults: []
  property string fileQuery: ""
  readonly property string bridge: Quickshell.env("HOME") + "/.local/bin/spotlight"

  readonly property var rows: Model.group(root.commands, root.lens, root.filterText, root.smart, capture.usage, root.fileResults)

  // Usage capture and the cross-app bridge (see Capture.qml / docs/bridge.md).
  Capture {
    id: capture
  }

  // A package install while the overlay is open changes the app catalog.
  Connections {
    target: root.appLibrary
    function onAppsChanged() { if (root.opened) root.prepare() }
  }

  // Full shortcut catalog. The print mode already merges shipped bindings,
  // user overrides and app-level binds, so this stays correct after a reload.
  Process {
    id: shortcutScan
    command: ["omarchy", "menu", "keybindings", "--print"]
    stdout: SplitParser {
      onRead: function(line) { root.ingestShortcut(line) }
    }
    onStarted: {
      root.pendingShortcuts = []
      root.pendingShortcutIds = ({})
    }
    onExited: {
      if (root.pendingShortcuts.length === 0) return
      root.shortcuts = root.pendingShortcuts
      root.shortcutsAt = Date.now()
      if (root.opened) root.prepare()
    }
  }

  // ------------------------------------------------ Omarchy menu (actions)

  FileView {
    id: menuDefaultView
    path: root.omarchyPath + "/default/omarchy/omarchy-menu.jsonc"
    watchChanges: true
    printErrors: false
    onLoaded: root.setMenuText("default", text())
    onFileChanged: root.setMenuText("default", text())
    onLoadFailed: root.setMenuText("default", "")
  }

  FileView {
    id: menuUserView
    path: Quickshell.env("HOME") + "/.config/omarchy/extensions/omarchy-menu.jsonc"
    watchChanges: true
    printErrors: false
    onLoaded: root.setMenuText("user", text())
    onFileChanged: root.setMenuText("user", text())
    onLoadFailed: root.setMenuText("user", "")
  }

  // One bash pass for every `when` / `disabled` condition in the tree. It runs
  // in parallel buckets and reports `id:w:1` lines, so the cost is one process
  // group per guard refresh rather than one per row.
  Process {
    id: guardProc
    stdout: StdioCollector {
      onStreamFinished: {
        root.guards = Model.parseGuards(text)
        root.guardsAt = Date.now()
        root.menuActions = Model.menuActionRows(root.menuItems, root.guards)
        if (root.opened) root.prepare()
      }
    }
  }

  // File search. Debounced, and only when it can matter: the files lens, or
  // Everything with at least three characters. `fd` and `find` run in the
  // bridge CLI so the QML process never blocks on disk.
  Process {
    id: fileScan
    stdout: StdioCollector {
      onStreamFinished: {
        var parsed = []
        try { parsed = JSON.parse(text) } catch (e) { parsed = [] }
        root.fileResults = Array.isArray(parsed) ? parsed : []
      }
    }
    onExited: {
      if (root.fileResults.length === 0 && root.fileQuery !== "") {
        // Nothing to show; leave the empty array so no stale rows linger.
        root.fileResults = []
      }
    }
  }

  Timer {
    id: fileTimer
    interval: 220
    repeat: false
    onTriggered: {
      var q = root.fileQuery
      var args = [root.bridge, "files", "--limit", "20"]
      if (q !== "") args = [root.bridge, "files", "--query", q, "--limit", "20"]
      fileScan.command = args
      fileScan.running = false
      fileScan.running = true
    }
  }

  Component.onCompleted: root.refreshShortcuts(true)

  // Theme: reuse the menu surface tokens so Spotlight feels native.
  property color background: Commons.Color.menu.background
  property color foreground: Commons.Color.menu.text
  property color border: Commons.Color.menu.border
  property color scrim: Commons.Color.menu.scrim
  property color selectedBackground: Commons.Color.menu.selectedBackground
  property color selectedText: Commons.Color.menu.selectedText

  readonly property int corner: Math.max(0, Style.cornerRadius)
  readonly property int contentMargin: Style.spacing.panelPadding
  readonly property int rowHeight: Style.space(38)
  readonly property int maxListHeight: Style.space(420)
  readonly property int cardWidth: Math.min(Style.space(600), overlay.width - Style.gapsOut * 2)
  readonly property var borderSpec: Border.surfaceSpec("menu", "border", root.border, Math.max(1, Style.space(2)))

  // ------------------------------------------------------------- lifecycle

  function open(payloadJson) {
    var payload = ({})
    try { payload = JSON.parse(payloadJson || "{}") } catch (e) { payload = ({}) }

    if (payload.lens) root.lens = String(payload.lens)
    else if (payload.menu === "shortcuts") root.lens = "shortcuts"
    else root.lens = "all"

    root.filterText = ""
    root.selectedIndex = 0
    root.prepare()
    root.refreshShortcuts(false)
    root.refreshFiles()
    root.refreshGuards(true)
    capture.beginSession()
    capture.rebuild()
    root.opened = true
    Qt.callLater(function() { filterInput.forceActiveFocus() })
  }

  function close() {
    root.opened = false
    root.filterText = ""
    capture.endSession()
  }

  function refreshShortcuts(force) {
    if (shortcutScan.running) return
    if (!force && root.shortcutsAt > 0 && (Date.now() - root.shortcutsAt) < 30000) return
    shortcutScan.running = true
  }

  function refreshFiles() {
    var want = root.lens === "files"
      || (root.lens === "all" && root.filterText.trim().length >= 3)
    if (!want) {
      root.fileQuery = ""
      root.fileResults = []
      return
    }
    var q = root.filterText.trim()
    if (q === root.fileQuery && root.fileResults.length > 0) return
    root.fileQuery = q
    fileTimer.restart()
  }

  function setMenuText(which, text) {
    if (which === "user") root.menuUserText = String(text || "")
    else root.menuDefaultText = String(text || "")
    root.rebuildMenu()
  }

  function rebuildMenu() {
    var items = Model.mergeMenu(
      Model.parseMenu(root.menuDefaultText),
      Model.parseMenu(root.menuUserText)
    )
    root.menuItems = items
    root.menuActions = Model.menuActionRows(items, root.guards)
    if (items.length > 0) root.refreshGuards(false)
    if (root.opened) root.prepare()
  }

  // Guard state is live, like the stock menu's checkmarks: refresh on open, and
  // once at startup so the first frame is already close to right.
  function refreshGuards(force) {
    if (guardProc.running) return
    if (!force && root.guardsAt > 0 && (Date.now() - root.guardsAt) < 300000) return
    var script = Model.guardScript(root.menuItems, 8)
    if (script === "") return
    guardProc.command = ["bash", "-lc", script]
    guardProc.running = false
    guardProc.running = true
  }

  function ingestShortcut(line) {
    var command = Model.parseShortcutLine(line)
    if (!command) return
    if (root.pendingShortcutIds[command.id]) return
    root.pendingShortcutIds[command.id] = true
    root.pendingShortcuts.push(command)
  }

  // Merge the live app catalog with actions and the live keybinding catalog.
  function prepare() {
    // Cold start: the seven static rows only cover the first frame, before the
    // JSONC files load. The real list comes from Omarchy's menu tree.
    var list = (root.menuActions.length > 0 ? root.menuActions : Model.actionsOnly()).slice()
    var shortcuts = root.shortcuts.length > 0 ? root.shortcuts : Model.fallbackShortcuts()
    for (var s = 0; s < shortcuts.length; s++) list.push(shortcuts[s])

    var lib = root.appLibrary
    if (lib) {
      try {
        var entries = lib.sortedEntries("")
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i].entry
          var id = String(entry.id || "")
          if (!id) continue
          var iconName = String(entry.icon || "")
          var iconPath = ""
          try { iconPath = lib.iconSource(iconName) } catch (e) { iconPath = "" }
          list.push({
            id: "app:" + id,
            kind: "app",
            label: lib.entryName(entry),
            appId: id,
            appIcon: iconName,
            appIconPath: iconPath,
            icon: "",
            chord: "",
            detail: lib.entrySubtext(entry) || "",
            aliases: []
          })
        }
      } catch (err) {
        console.warn("spotlight: app catalog failed:", err)
      }
    }
    root.commands = list
  }

  // --------------------------------------------------------------- filters

  function setFilter(text) {
    var next = String(text || "")
    var nextLens = root.lens
    if (next.charAt(0) === "?") { nextLens = "shortcuts"; next = next.slice(1) }
    else if (next.charAt(0) === ">") { nextLens = "actions"; next = next.slice(1) }
    else if (next.charAt(0) === "@") { nextLens = "apps"; next = next.slice(1) }

    if (nextLens !== root.lens) root.lens = nextLens
    if (next !== root.filterText) {
      root.filterText = next
      root.selectedIndex = 0
    }
  }

  function setLens(value) {
    root.lens = value
    root.selectedIndex = 0
  }

  function cycleLens(direction) {
    root.setLens(Model.nextLens(root.lens, direction))
  }

  // --------------------------------------------------------------- actions

  function move(delta) {
    if (root.rows.length === 0) return
    var next = root.selectedIndex + delta
    if (next < 0) next = root.rows.length - 1
    if (next >= root.rows.length) next = 0
    root.selectedIndex = next
  }

  // ------------------------------------------------------------ activation

  // Record once per activation. The query that led here is what teaches "brv"
  // to mean Brave: only on a real activation, only when learnTerms is on, and
  // only the query text — never a window title or anything an app shows.
  function recordPick(row, type) {
    capture.record({
      type: type,
      id: row.id,
      appId: row.appId,
      label: row.label,
      source: "spotlight",
      data: (capture.learnTerms && root.filterText !== "") ? { query: root.filterText } : undefined
    })
  }

  function launchApp(row) {
    root.recordPick(row, "launch")
    try { root.appLibrary.launch(row.appId, row.label) }
    catch (e) { console.warn("spotlight: launch failed:", e) }
  }

  // The desktop entry that claims a Hyprland app id. Same rule the dock uses:
  // class, StartupWMClass and web-app names all resolve through
  // DesktopEntries.heuristicLookup().
  function entryForAppId(appId) {
    var id = String(appId || "")
    if (!id) return null
    var entry = null
    try { entry = DesktopEntries.heuristicLookup(id) } catch (e) { entry = null }
    return entry || null
  }

  // Windows belonging to one app, most useful first: focused, then on the
  // active workspace, then the rest; minimized sinks.
  function windowsFor(appId) {
    var wanted = String(appId || "")
    var out = []
    if (!wanted) return out
    var list = []
    try { list = Hyprland.toplevels.values || [] } catch (e) { return out }
    var active = -1
    try {
      var monitor = Hyprland.focusedMonitor
      if (monitor && monitor.activeWorkspace) active = monitor.activeWorkspace.id
    } catch (e) { active = -1 }

    for (var i = 0; i < list.length; i++) {
      var top = list[i]
      var wayland = top && top.wayland
      if (!wayland || !wayland.appId || wayland.parent) continue
      var entry = root.entryForAppId(wayland.appId)
      if (!entry || String(entry.id) !== wanted) continue
      out.push({
        address: String(top.address || ""),
        focused: !!wayland.activated,
        onActive: !!(top.workspace && top.workspace.id === active),
        minimized: !!(top.workspace && top.workspace.name === "special:minimized"),
        toplevel: wayland
      })
    }

    out.sort(function(a, b) {
      if (a.focused !== b.focused) return a.focused ? -1 : 1
      if (a.minimized !== b.minimized) return a.minimized ? 1 : -1
      if (a.onActive !== b.onActive) return a.onActive ? -1 : 1
      return 0
    })
    return out
  }

  // Focus an existing window, restoring a minimized one first. The overlay's
  // layer holds keyboard focus, so Hyprland refuses the dispatch until it is
  // gone; wait for the namespace to disappear, then dispatch with a short
  // retry. This mirrors what omarchy's dock does for its window buttons.
  function bringForward(win) {
    if (!win) return
    if (!win.address) {
      if (win.toplevel && win.toplevel.activate) win.toplevel.activate()
      return
    }
    var script = [
      "for _ in $(seq 20); do",
      "  hyprctl layers -j 2>/dev/null | grep -q '\"namespace\": *\"k0d3d-spotlight\"' || break",
      "  sleep 0.05",
      "done",
      "if [[ $2 == 1 ]]; then",
      "  ws=$(hyprctl activeworkspace -j | jq -r .id)",
      "  hyprctl dispatch \"hl.dsp.window.set_prop({ prop = \\\"no_anim\\\", value = \\\"1\\\", window = \\\"address:$1\\\" })\" >/dev/null 2>&1",
      "  hyprctl dispatch \"hl.dsp.window.move({ workspace = \\\"$ws\\\", window = \\\"address:$1\\\" })\" >/dev/null 2>&1",
      "fi",
      "for _ in 1 2 3 4 5 6 7 8 9 10; do",
      "  hyprctl dispatch \"hl.dsp.focus({ window = \\\"address:$1\\\" })\" >/dev/null 2>&1",
      "  if [[ $(hyprctl activewindow -j | jq -r .address) == \"$1\" ]]; then",
      "    hyprctl dispatch \"hl.dsp.window.alter_zorder({ mode = \\\"top\\\", window = \\\"address:$1\\\" })\" >/dev/null 2>&1",
      "    [[ $2 == 1 ]] && hyprctl dispatch \"hl.dsp.window.set_prop({ prop = \\\"no_anim\\\", value = \\\"unset\\\", window = \\\"address:$1\\\" })\" >/dev/null 2>&1",
      "    exit 0",
      "  fi",
      "  sleep 0.05",
      "done"
    ].join("\n")
    Quickshell.execDetached(["bash", "-c", script, "spotlight-focus", win.address, win.minimized ? "1" : "0"])
  }

  // Enter on an app: focus its window if it has one, launch otherwise.
  // Shift+Enter always launches a new instance.
  function openApp(row, forceNew) {
    var windows = forceNew ? [] : root.windowsFor(row.appId)
    if (windows.length > 0) {
      root.recordPick(row, "launch")
      root.close()
      root.bringForward(windows[0])
      return
    }
    root.launchApp(row)
    root.close()
  }

  // Enter on a shortcut row runs the binding it describes. Resolution lives in
  // the CLI because Omarchy's keybinding cache knows what a Lua dispatcher
  // really is; this stays a shell-out, never an eval.
  function runShortcut(row) {
    root.recordPick(row, "action")
    root.close()
    Quickshell.execDetached([root.bridge, "run", "--chord", row.chord, "--label", row.label])
  }

  // Omarchy menu actions are shell commands from the menu definition, not event
  // data. `bash -lc` matches how the stock menu runs them (some use [[ ]],
  // pipes and command substitution).
  function runAction(row) {
    if (row.disabled) {
      console.log("spotlight: action is already set up:", row.id)
      root.close()
      return
    }
    root.recordPick(row, "action")
    root.close()
    if (!row.action) return
    Quickshell.execDetached(["bash", "-lc", row.action])
  }

  function activate(index, forceNew) {
    var row = root.rows[index]
    if (!row) return
    if (row.kind === "file" && row.path) {
      // Default handler, via the desktop's MIME database. Never exec.
      root.close()
      Quickshell.execDetached(["gio", "open", "--", row.path])
      return
    }
    if (row.kind === "app" && root.appLibrary && row.appId) {
      root.openApp(row, forceNew === true)
    } else if (row.kind === "shortcut" && row.chord) {
      root.runShortcut(row)
    } else if (row.kind === "action" && row.action) {
      root.runAction(row)
    } else {
      console.log("spotlight: no route for", row.id, row.chord || "")
      root.close()
    }
  }

  // Bridge for other plugins and tools. Same schema as the CLI:
  //   omarchy-shell k0d3d.spotlight record '{"type":"focus","id":"app:foot"}'
  //   omarchy-shell k0d3d.spotlight recent 10
  //   omarchy-shell k0d3d.spotlight stats
  IpcHandler {
    target: "k0d3d.spotlight"

    function record(payloadJson: string): string { return capture.recordJson(payloadJson) }
    function recent(limit: string): string { return capture.recentJson(parseInt(limit) || 10) }
    function stats(): string { return capture.statsJson() }
    function state(): string { return capture.debugState() }
    function focusNow(): string { capture.captureFocus(); return capture.debugState() }
    function openedState(): string {
      return JSON.stringify({
        opened: root.opened,
        lens: root.lens,
        filter: root.filterText,
        rows: root.rows.length,
        commands: root.commands.length,
        actions: root.menuActions.length,
        files: root.fileResults.length,
        smart: root.smart,
        top: root.rows.slice(0, 5).map(function(r) {
          return r.label + (r.chord ? " [" + r.chord + "]" : "")
        })
      })
    }
  }

  onRowsChanged: {
    if (root.selectedIndex >= root.rows.length)
      root.selectedIndex = Math.max(0, root.rows.length - 1)
  }

  onLensChanged: {
    root.selectedIndex = 0
    root.refreshFiles()
  }

  onSelectedIndexChanged: {
    if (resultList) resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
  }

  onFilterTextChanged: {
    if (filterInput && filterInput.text !== root.filterText) filterInput.text = root.filterText
    root.refreshFiles()
  }

  // ---------------------------------------------------------------- surface

  OverlayWindow {
    id: overlay
    shown: root.opened
    WlrLayershell.namespace: "k0d3d-spotlight"

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.close()
    }

    BorderSurface {
      id: card
      width: root.cardWidth
      height: Math.min(content.implicitHeight + card.contentTopInset + card.contentBottomInset,
                       overlay.height - Style.gapsOut * 2)
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.verticalCenter: parent.verticalCenter
      radius: root.corner
      color: root.background
      borderSpec: root.borderSpec
      padding: root.contentMargin

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        id: keyCatcher
        anchors.fill: parent

        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Escape) {
            if (root.filterText) root.setFilter("")
            else if (root.lens !== "all") root.setLens("all")
            else root.close()
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            root.move(-1)
            event.accepted = true
          } else if (event.key === Qt.Key_Down) {
            root.move(1)
            event.accepted = true
          } else if (event.key === Qt.Key_Tab) {
            root.cycleLens((event.modifiers & Qt.ShiftModifier) ? -1 : 1)
            event.accepted = true
          } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            root.activate(root.selectedIndex, (event.modifiers & Qt.ShiftModifier) !== 0)
            event.accepted = true
          } else if (event.key === Qt.Key_Right) {
            root.activate(root.selectedIndex, false)
            event.accepted = true
          } else if (event.key === Qt.Key_Backspace && !root.filterText) {
            if (root.lens !== "all") {
              root.setLens("all")
              event.accepted = true
            }
          }
        }
      }

      Column {
        id: content
        x: card.contentLeftInset
        y: card.contentTopInset
        width: card.width - card.contentLeftInset - card.contentRightInset
        spacing: Style.spacing.md

        // ------------------------------------------------------------ header
        Item {
          width: parent.width
          height: Style.space(38)

          Text {
            id: searchGlyph
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "\uf002"
            color: root.foreground
            opacity: 0.55
            font.family: Style.font.menuFamily
            font.pixelSize: Style.font.title
          }

          FilterInput {
            id: filterInput
            anchors.left: searchGlyph.right
            anchors.leftMargin: Style.space(10)
            anchors.right: lensChip.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            keyHandler: keyCatcher
            color: root.foreground
            font.family: Style.font.menuFamily
            font.pixelSize: Style.font.heading
            onTextChanged: if (text !== root.filterText) root.setFilter(text)
          }

          Text {
            anchors.fill: filterInput
            verticalAlignment: Text.AlignVCenter
            visible: !root.filterText && !filterInput.preeditText
            text: "Search apps, actions, shortcuts, files…"
            color: root.foreground
            opacity: 0.45
            font.family: Style.font.menuFamily
            font.pixelSize: Style.font.heading
            elide: Text.ElideRight
          }

          Rectangle {
            id: lensChip
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            width: lensText.implicitWidth + Style.space(16)
            height: Style.space(24)
            radius: Math.min(root.corner, height / 2)
            color: root.selectedBackground

            Text {
              id: lensText
              anchors.centerIn: parent
              text: Model.lensLabel(root.lens)
              color: root.selectedText
              font.family: Style.font.menuFamily
              font.pixelSize: Style.font.bodySmall
            }

            MouseArea {
              anchors.fill: parent
              onClicked: root.cycleLens(1)
            }
          }
        }

        // -------------------------------------------------------------- list
        Item {
          width: parent.width
          height: Math.min(Math.max(resultList.contentHeight, root.rowHeight), root.maxListHeight)

          ListView {
            id: resultList
            anchors.fill: parent
            model: root.rows
            clip: true
            spacing: Style.spacing.xs
            boundsBehavior: Flickable.StopAtBounds

            section.property: "section"
            section.criteria: ViewSection.FullString
            section.delegate: Item {
              required property string section
              width: ListView.view ? ListView.view.width : 0
              height: Style.space(24)

              Text {
                anchors.left: parent.left
                anchors.bottom: parent.bottom
                anchors.bottomMargin: Style.space(2)
                text: (section || "").toUpperCase()
                color: root.foreground
                opacity: 0.4
                font.family: Style.font.menuFamily
                font.pixelSize: Style.font.caption
                font.letterSpacing: 1
              }
            }

            delegate: Item {
              id: rowItem
              required property var modelData
              required property int index
              readonly property bool selected: index === root.selectedIndex
              width: ListView.view ? ListView.view.width : 0
              height: root.rowHeight

              Rectangle {
                anchors.fill: parent
                radius: Math.min(root.corner, Style.space(8))
                color: rowItem.selected ? root.selectedBackground : "transparent"
              }

              Item {
                id: iconSlot
                anchors.left: parent.left
                anchors.leftMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(20)
                height: Style.space(20)

                Image {
                  anchors.fill: parent
                  visible: String(source).length > 0
                  source: modelData.appIconPath || ""
                  fillMode: Image.PreserveAspectFit
                  smooth: true
                }

                Text {
                  anchors.centerIn: parent
                  visible: !modelData.appIconPath
                  text: modelData.icon || "\uf059"
                  color: rowItem.selected ? root.selectedText : root.foreground
                  font.family: modelData.iconFont || Style.font.menuFamily
                  font.pixelSize: Style.font.iconLarge
                }
              }

              Text {
                id: labelText
                anchors.left: iconSlot.right
                anchors.leftMargin: Style.space(12)
                anchors.right: detailText.visible ? detailText.left : chordText.left
                anchors.rightMargin: Style.space(10)
                anchors.verticalCenter: parent.verticalCenter
                text: modelData.label || ""
                color: rowItem.selected ? root.selectedText : root.foreground
                font.family: Style.font.menuFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
              }

              Text {
                id: detailText
                anchors.right: chordText.left
                anchors.rightMargin: Style.space(12)
                anchors.verticalCenter: parent.verticalCenter
                text: rowItem.selected ? "" : (modelData.detail || "")
                visible: text.length > 0
                width: visible ? Style.space(110) : 0
                horizontalAlignment: Text.AlignRight
                color: root.foreground
                opacity: 0.45
                font.family: Style.font.menuFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }

              Text {
                id: chordText
                anchors.right: parent.right
                anchors.rightMargin: Style.space(12)
                anchors.verticalCenter: parent.verticalCenter
                text: modelData.chord || ""
                visible: text.length > 0
                width: visible ? implicitWidth : 0
                color: rowItem.selected ? root.selectedText : root.foreground
                opacity: rowItem.selected ? 0.9 : 0.5
                font.family: Style.font.menuFamily
                font.pixelSize: Style.font.bodySmall
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                onEntered: root.selectedIndex = index
                onClicked: root.activate(index)
              }
            }
          }

          Text {
            anchors.centerIn: parent
            visible: root.rows.length === 0
            text: root.filterText.length > 0
              ? "No matches for \u201c" + root.filterText + "\u201d"
              : "Nothing here yet"
            color: root.foreground
            opacity: 0.55
            font.family: Style.font.menuFamily
            font.pixelSize: Style.font.title
          }

          // Soft bottom fade when the list overflows, so a clipped last row
          // reads as "more below" instead of a hard cut.
          Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: Math.min(Style.space(26), parent.height / 2)
            visible: resultList.contentHeight > resultList.height
            gradient: Gradient {
              GradientStop { position: 0; color: Util.alpha(root.background, 0) }
              GradientStop { position: 1; color: root.background }
            }
          }
        }

        // ------------------------------------------------------------ footer
        Item {
          width: parent.width
          height: Style.space(24)

          Row {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(10)

            Repeater {
              model: ["\u21b5 Open", "\u21e7\u21b5 New", "\u21e5 Lens", "? Shortcuts", "esc Close"]

              Text {
                text: modelData
                color: root.foreground
                opacity: 0.4
                font.family: Style.font.menuFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          Text {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.rows.length + " results"
            color: root.foreground
            opacity: 0.35
            font.family: Style.font.menuFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "Storage.js" as Storage

// Capture — Phase 0 plumbing.
//
// Two jobs:
//   1. append events to ~/.local/state/omarchy/spotlight/events.jsonl
//   2. keep an aggregated snapshot.json warm so the UI never parses JSONL
//
// The events file is the public bridge: other plugins and plain shell tools
// append the same schema (see Storage.js / `spotlight record`). Nothing here
// is required for them to participate; it just makes the data useful.
Item {
  id: root

  // Kill switch, read from ~/.config/omarchy/spotlight.json.
  property bool enabled: true
  property bool focusEnabled: true
  // Whether the query that led to a launch may be stored as a learned term.
  // Separate from `enabled` because it is the one field that holds typed text.
  property bool learnTerms: true

  // True while the Spotlight overlay owns the keyboard. Focus changes caused
  // by opening/closing the overlay are not app usage and must not be counted.
  property bool suspended: false

  // snapshot.json -> id -> { count, last, types }
  property var usage: ({})
  property double snapshotAt: 0
  property int eventCount: 0
  property bool rebuildQueued: false

  property string lastLaunchId: ""
  property double lastLaunchAt: 0
  property string lastFocusId: ""
  property double lastFocusAt: 0

  // The app that was focused before Spotlight opened. When the overlay closes,
  // that app regains focus; counting it would make every launcher use look like
  // app usage. Suppress that one return event.
  property string preOpenFocusId: ""
  property string suppressFocusId: ""
  property double suppressFocusUntil: 0

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string stateDir: ((Quickshell.env("XDG_STATE_HOME") || (root.home + "/.local/state")) + "/omarchy/spotlight")
  readonly property string eventsPath: root.stateDir + "/events.jsonl"
  readonly property string snapshotPath: root.stateDir + "/snapshot.json"
  readonly property string settingsPath: ((Quickshell.env("XDG_CONFIG_HOME") || (root.home + "/.config")) + "/omarchy/spotlight.json")
  readonly property string helper: root.home + "/.local/bin/spotlight"

  // ------------------------------------------------------------- public API

  function record(raw) {
    if (!root.enabled) return false

    var event = Storage.normalize(raw, { source: "spotlight", ts: Date.now() })
    if (!event) return false

    // A launch is followed by a focus event for the same app a moment later.
    // Count the intent once, not twice.
    if (event.type === "focus" && event.id === root.lastLaunchId
        && (event.ts - root.lastLaunchAt) < 15000) return false

    if (event.type === "launch") {
      root.lastLaunchId = event.id
      root.lastLaunchAt = event.ts
      root.lastFocusId = String(event.appId || event.id.replace(/^app:/, ""))
      root.lastFocusAt = event.ts
    }

    root.append(Storage.serialize(event))
    statsDebounce.restart()
    return true
  }

  function recordJson(payloadJson) {
    var parsed = null
    try { parsed = JSON.parse(String(payloadJson || "")) } catch (e) { return "error: invalid json" }
    return root.record(parsed) ? "ok" : "error: rejected"
  }

  // Recent distinct ids, newest first. Used by `omarchy-shell k0d3d.spotlight
  // recent` and by other tools that want to mirror Spotlight's history.
  function recent(limit) {
    var items = []
    for (var id in root.usage) {
      var signal = root.usage[id]
      if (!signal) continue
      items.push({
        id: id,
        count: Number(signal.count) || 0,
        last: Number(signal.last) || 0,
        types: signal.types || ({})
      })
    }
    items.sort(function(a, b) { return b.last - a.last })
    var count = Number(limit) || 10
    return items.slice(0, count < 0 ? 0 : count)
  }

  function recentJson(limit) {
    return JSON.stringify(root.recent(limit))
  }

  function statsJson() {
    var ids = 0
    for (var id in root.usage) ids++
    return JSON.stringify({
      events: root.eventCount,
      ids: ids,
      generatedAt: root.snapshotAt,
      eventsPath: root.eventsPath,
      snapshotPath: root.snapshotPath,
      configPath: root.settingsPath,
      capture: root.enabled,
      focus: root.focusEnabled
    })
  }

  // Debug surface: enough to tell whether focus capture is live without
  // attaching a QML debugger. Exposed through the IPC bridge as `state`.
  function debugState() {
    var active = ""
    try {
      active = ToplevelManager.activeToplevel ? String(ToplevelManager.activeToplevel.appId || "") : ""
    } catch (e) {
      active = "error"
    }
    return JSON.stringify({
      enabled: root.enabled,
      focusEnabled: root.focusEnabled,
      learnTerms: root.learnTerms,
      suspended: root.suspended,
      writer: writer.running,
      activeAppId: active,
      lastFocusId: root.lastFocusId,
      lastFocusAt: root.lastFocusAt,
      ids: Object.keys(root.usage).length
    })
  }

  function currentAppId() {
    var toplevel = null
    try { toplevel = ToplevelManager.activeToplevel } catch (e) { return "" }
    return toplevel ? String(toplevel.appId || "") : ""
  }

  function beginSession() {
    root.suspended = true
    root.preOpenFocusId = root.currentAppId()
  }

  function endSession() {
    root.suspended = false
    // The next activation of the app underneath is the overlay yielding, not a
    // choice. Give the compositor enough time to report it.
    root.suppressFocusId = root.preOpenFocusId
    root.suppressFocusUntil = Date.now() + 4000
    root.markCurrentFocus()
  }

  // Called when the overlay closes: the app underneath regains focus, but the
  // user did not choose it, so remember it without recording an event.
  function markCurrentFocus() {
    var appId = root.currentAppId()
    if (!appId) return
    root.lastFocusId = appId
    root.lastFocusAt = Date.now()
  }

  function rebuild() {
    if (snapshotProcess.running) {
      root.rebuildQueued = true
      return
    }
    snapshotProcess.running = true
  }

  // ---------------------------------------------------------------- writers

  function append(line) {
    if (writer.running) {
      writer.write(line + "\n")
      return
    }
    root.pending.push(line)
    if (root.pending.length > 200) root.pending.shift()
    writer.running = true
  }

  function flush() {
    if (!writer.running) return
    while (root.pending.length > 0) writer.write(root.pending.shift() + "\n")
  }

  property var pending: []

  // One long-lived `cat` appending to the events file. Appending via a single
  // write per line keeps the file readable by tail -f and by the CLI at the
  // same time; no file is rewritten in place.
  Process {
    id: writer
    command: ["sh", "-c", "mkdir -p \"$1\" && exec cat >> \"$2\"", "sh", root.stateDir, root.eventsPath]
    stdinEnabled: true
    running: true
    onStarted: root.flush()
    onExited: writerRestart.restart()
  }

  Timer {
    id: writerRestart
    interval: 1000
    onTriggered: if (!writer.running) writer.running = true
  }

  // Aggregate after a short quiet period so a launch plus its focus event only
  // pays for one rebuild.
  Timer {
    id: statsDebounce
    interval: 1200
    onTriggered: root.rebuild()
  }

  Process {
    id: snapshotProcess
    command: [root.helper, "snapshot"]
    onExited: {
      snapshotView.reload()
      if (root.rebuildQueued) {
        root.rebuildQueued = false
        root.rebuild()
      }
    }
  }

  FileView {
    id: snapshotView
    path: root.snapshotPath
    watchChanges: true
    printErrors: false
    onLoaded: root.loadSnapshot(text())
    onFileChanged: root.loadSnapshot(text())
    onLoadFailed: root.loadSnapshot("")
  }

  FileView {
    id: settingsView
    path: root.settingsPath
    watchChanges: true
    printErrors: false
    onLoaded: root.applySettings(text())
    onFileChanged: root.applySettings(text())
    onLoadFailed: root.applySettings("")
  }

  function loadSnapshot(text) {
    var parsed = null
    try { parsed = JSON.parse(String(text || "")) } catch (e) { parsed = null }
    if (!parsed || !parsed.items || typeof parsed.items !== "object") {
      root.usage = ({})
      return
    }
    root.usage = parsed.items
    root.snapshotAt = Number(parsed.generatedAt) || 0
    root.eventCount = Number(parsed.events) || 0
  }

  function applySettings(text) {
    var parsed = null
    try { parsed = JSON.parse(String(text || "")) } catch (e) { parsed = null }
    if (!parsed) {
      // A deleted config means defaults, not "keep the last kill switch".
      root.enabled = true
      root.focusEnabled = true
      root.learnTerms = true
      return
    }
    if (parsed.capture !== undefined) root.enabled = parsed.capture !== false
    if (parsed.captureFocus !== undefined) root.focusEnabled = parsed.captureFocus !== false
    if (parsed.learnTerms !== undefined) root.learnTerms = parsed.learnTerms !== false
  }

  // ---------------------------------------------------------- focus capture

  function captureFocus() {
    if (!root.enabled || !root.focusEnabled || root.suspended) return

    var appId = root.currentAppId()
    if (!appId) return
    if (appId === "k0d3d.spotlight" || appId === "org.quickshell") return

    var now = Date.now()

    // The return from closing the overlay is not usage.
    if (appId === root.suppressFocusId && now <= root.suppressFocusUntil) {
      root.suppressFocusId = ""
      root.lastFocusId = appId
      root.lastFocusAt = now
      return
    }

    // Alt-tabbing between two windows of the same app is still one session.
    if (appId === root.lastFocusId && (now - root.lastFocusAt) < 1500) return

    root.lastFocusId = appId
    root.lastFocusAt = now
    root.record({
      type: "focus",
      id: "app:" + appId,
      appId: appId,
      source: "toplevel"
    })
  }

  Connections {
    target: ToplevelManager
    function onActiveToplevelChanged() { root.captureFocus() }
  }

  Component.onCompleted: {
    root.rebuild()
    root.captureFocus()
  }
}

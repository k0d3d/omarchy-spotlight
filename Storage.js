// Spotlight storage primitives.
//
// Pure JS on purpose: no QML imports, so this can be exercised with node.
// Everything that touches disk lives in Capture.qml or the `spotlight` CLI;
// this file owns the event schema, normalisation and the tiny scoring helpers
// the smart block uses.

var SCHEMA_VERSION = 1

// Events other tools may emit. `custom` is the escape hatch for plugins that
// want to record their own ids without teaching Spotlight about them yet.
var TYPES = ["launch", "focus", "open", "action", "custom", "pin", "unpin", "dismiss"]

function asString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

// normalize(raw, defaults) -> event | null
//
// Unknown keys are dropped on purpose: the events file is a shared bridge, so
// it only stores the fields every consumer agrees on. Anything else belongs
// under `data`.
function normalize(raw, defaults) {
  var input = asObject(raw)
  if (!input) return null

  var type = asString(input.type)
  if (TYPES.indexOf(type) === -1) return null

  var id = asString(input.id)
  if (!id) return null

  var ts = Number(input.ts)
  if (!isFinite(ts) || ts <= 0) ts = Number(defaults && defaults.ts) || Date.now()

  var event = {
    v: SCHEMA_VERSION,
    ts: Math.round(ts),
    type: type,
    id: id,
    source: asString(input.source) || asString(defaults && defaults.source) || "unknown"
  }

  var label = asString(input.label)
  if (label) event.label = label

  var appId = asString(input.appId)
  if (appId) event.appId = appId

  var data = asObject(input.data)
  if (data) event.data = data

  return event
}

function serialize(event) {
  return JSON.stringify(event)
}

function parseLine(line) {
  try {
    var value = JSON.parse(String(line || ""))
    return asObject(value)
  } catch (e) {
    return null
  }
}

// Compact, human recency label. Kept here so the CLI and the UI agree.
function relativeTime(ts, now) {
  var stamp = Number(ts) || 0
  if (stamp <= 0) return ""
  var delta = Math.max(0, (Number(now) || Date.now()) - stamp)
  if (delta < 60 * 1000) return "just now"

  var minutes = Math.floor(delta / (60 * 1000))
  if (minutes < 60) return minutes + "m ago"

  var hours = Math.floor(delta / (60 * 60 * 1000))
  if (hours < 24) return hours + "h ago"

  var days = Math.floor(delta / (24 * 60 * 60 * 1000))
  if (days === 1) return "yesterday"
  if (days < 7) return days + "d ago"

  var weeks = Math.floor(days / 7)
  if (weeks < 5) return weeks + "w ago"

  return Math.floor(days / 30) + "mo ago"
}

function formatCount(count) {
  var n = Number(count) || 0
  return n + "\u00d7"
}

// Usage counts ignore bookkeeping events. A future pin/dismiss should not make
// a row look more frequent than it is.
var USAGE_TYPES = ["launch", "focus", "open", "action", "custom"]

function usageCount(signal) {
  var types = asObject(signal && signal.types)
  if (!types) return Number(signal && signal.count) || 0
  var total = 0
  for (var i = 0; i < USAGE_TYPES.length; i++) {
    total += Number(types[USAGE_TYPES[i]]) || 0
  }
  return total
}

// smartPicks(signals, commands, now) -> { forYou: [...], recent: [...] }
//
// `signals` is the snapshot map: id -> { count, last, frecency, types }. Only
// ids that resolve to a real command row are candidates, so an event for an app
// that was uninstalled can never produce a dead row.
//
// For you is frecency-led: the snapshot's decayed score, which answers "what do
// I use" without letting a burst from a year ago outrank a habit from this
// week. Snapshots written before frecency existed fall back to the raw count.
// Recent is purely last-seen. The two lists never repeat an id.
function smartPicks(signals, commands, now) {
  var byId = {}
  var list = Array.isArray(commands) ? commands : []
  for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i]

  var candidates = []
  var map = asObject(signals) || {}
  for (var id in map) {
    var signal = map[id]
    var command = byId[id]
    if (!signal || !command) continue
    if (command.kind !== "app" && command.kind !== "action" && command.kind !== "shortcut") continue

    var count = usageCount(signal)
    var last = Number(signal.last) || 0
    if (count <= 0 || last <= 0) continue

    var frecency = Number(signal.frecency)
    candidates.push({
      id: id,
      count: count,
      last: last,
      weight: frecency > 0 ? frecency : count
    })
  }

  var nowMs = Number(now) || Date.now()

  var byWeight = candidates.slice().sort(function(a, b) {
    if (b.weight !== a.weight) return b.weight - a.weight
    return b.last - a.last
  })
  var byLast = candidates.slice().sort(function(a, b) { return b.last - a.last })

  var seen = {}
  var forYou = []
  for (var f = 0; f < byWeight.length && forYou.length < 3; f++) {
    var top = byWeight[f]
    seen[top.id] = true
    forYou.push({ id: top.id, detail: "used " + formatCount(top.count) })
  }

  var recent = []
  for (var r = 0; r < byLast.length && recent.length < 3; r++) {
    var pick = byLast[r]
    if (seen[pick.id]) continue
    recent.push({ id: pick.id, detail: relativeTime(pick.last, nowMs) })
  }

  return { forYou: forYou, recent: recent }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    TYPES: TYPES,
    normalize: normalize,
    serialize: serialize,
    parseLine: parseLine,
    relativeTime: relativeTime,
    formatCount: formatCount,
    usageCount: usageCount,
    smartPicks: smartPicks
  }
}

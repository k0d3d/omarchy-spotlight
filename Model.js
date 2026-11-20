// Spotlight catalog, ranking and selection logic.
//
// Pure JS on purpose: no QML imports, so this can be exercised with node.
// The live app catalog is merged in from QML (AppLibrary); this file owns the
// static actions, the live keybinding parser, the ranker and the lens rules.
//
// QML cannot import one .js file from another, so the ranking code lives here
// rather than in its own module. The section is marked and kept close to its
// upstream source so it stays diffable.

function clone(command) {
  var copy = {}
  for (var key in command) copy[key] = command[key]
  return copy
}

function row(command, section, detail) {
  var item = clone(command)
  item.section = section
  if (detail !== undefined && detail !== null && detail !== "") item.detail = detail
  return item
}

// Static catalog: menu actions and the keybinding cheat sheet. Apps arrive
// from AppLibrary at runtime.
function staticCommands() {
  return [
    // ---------------------------------------------------------- actions
    { id: "action:lock", kind: "action", label: "Lock screen", icon: "\uf023", chord: "", detail: "System" },
    { id: "action:bar", kind: "action", label: "Toggle top bar", icon: "\uf0c9", chord: "SUPER + SHIFT + SPACE", detail: "Appearance" },
    { id: "action:background", kind: "action", label: "Background switcher", icon: "\uf03e", chord: "SUPER + CTRL + SPACE", detail: "Appearance" },
    { id: "action:theme", kind: "action", label: "Theme menu", icon: "\uf1fc", chord: "SUPER + SHIFT + CTRL + SPACE", detail: "Appearance" },
    { id: "action:screenshot", kind: "action", label: "Screenshot", icon: "\uf030", chord: "", detail: "Capture" },
    { id: "action:nightlight", kind: "action", label: "Night light", icon: "\uf186", chord: "", detail: "Display" },
    { id: "action:display", kind: "action", label: "Display settings", icon: "\uf108", chord: "", detail: "Display" },

    // -------------------------------------------------------- shortcuts
    { id: "shortcut:terminal", kind: "shortcut", label: "Terminal", icon: "\uf120", chord: "SUPER + RETURN", detail: "Open" },
    { id: "shortcut:browser", kind: "shortcut", label: "Browser", icon: "\uf268", chord: "SUPER + SHIFT + RETURN", detail: "Open" },
    { id: "shortcut:files", kind: "shortcut", label: "File manager", icon: "\uf07b", chord: "SUPER + SHIFT + F", detail: "Open" },
    { id: "shortcut:editor", kind: "shortcut", label: "Editor", icon: "\uf121", chord: "SUPER + SHIFT + N", detail: "Open" },
    { id: "shortcut:music", kind: "shortcut", label: "Music", icon: "\uf001", chord: "SUPER + SHIFT + M", detail: "Open" },
    { id: "shortcut:calculator", kind: "shortcut", label: "Calculator", icon: "\uf1ec", chord: "SUPER + SHIFT + Q", detail: "Open" },
    { id: "shortcut:menu", kind: "shortcut", label: "Spotlight", icon: "\uf002", chord: "SUPER + SPACE", detail: "Open" },
    { id: "shortcut:keybindings", kind: "shortcut", label: "Keybindings", icon: "\uf11c", chord: "SUPER + K", detail: "Learn" },
    { id: "shortcut:workspace1", kind: "shortcut", label: "Workspace 1", icon: "\uf00a", chord: "SUPER + 1", detail: "Navigate" },
    { id: "shortcut:close", kind: "shortcut", label: "Close window", icon: "\uf00d", chord: "SUPER + Q", detail: "Window" },
    { id: "shortcut:fullscreen", kind: "shortcut", label: "Fullscreen", icon: "\uf065", chord: "SUPER + F", detail: "Window" }
  ]
}

function actionsOnly() {
  return staticCommands().filter(function(command) { return command.kind === "action" })
}

// ===========================================================================
// Omarchy menu (actions)
// ---------------------------------------------------------------------------
// Omarchy ships a declarative menu at
//   $OMARCHY_PATH/default/omarchy/omarchy-menu.jsonc
// with a user extension file at ~/.config/omarchy/extensions/omarchy-menu.jsonc.
// Every item that has an `action` is a command the menu itself runs; `when`,
// `checked` and `disabled` are shell conditions evaluated by the stock menu.
//
// Indexing that tree is what the actions lens should always have been. The
// seven rows in staticCommands() are only a cold-start fallback for the first
// frame, before the files load.
//
// JSONC is JSON with line comments and trailing commas, so both are stripped
// before JSON.parse. An unreadable file yields no items rather than throwing.
// ===========================================================================

function stripJsonc(raw) {
  return String(raw || "")
    .replace(/^\s*\/\/[^\n]*(\n|$)/gm, "")
    .replace(/,(\s*[}\]])/g, "$1")
}

function menuParent(id) {
  var dot = String(id).lastIndexOf(".")
  return dot < 0 ? "" : String(id).slice(0, dot)
}

function normalizeMenuItem(id, raw) {
  var item = raw || {}
  var aliases = Array.isArray(item.aliases)
    ? item.aliases.filter(function(a) { return typeof a === "string" && a })
    : (typeof item.aliases === "string" && item.aliases ? [item.aliases] : [])
  return {
    id: String(id),
    parent: typeof item.parent === "string" ? item.parent : menuParent(id),
    label: String(item.label || item.title || id),
    icon: String(item.icon || ""),
    iconFont: String(item.iconFont || ""),
    description: String(item.description || ""),
    action: String(item.action || ""),
    target: String(item.target || ""),
    aliases: aliases,
    when: String(item.when || ""),
    checked: String(item.checked || ""),
    disabled: String(item.disabled || "")
  }
}

function parseMenu(raw) {
  var text = stripJsonc(raw)
  if (!text.trim()) return []
  var parsed = null
  try { parsed = JSON.parse(text) } catch (e) { return [] }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []

  var source = parsed.items && typeof parsed.items === "object" && !Array.isArray(parsed.items)
    ? parsed.items
    : parsed

  var out = []
  for (var id in source) {
    if (id === "root") continue
    var entry = source[id]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    out.push(normalizeMenuItem(id, entry))
  }
  return out
}

// User extensions add ids or override fields. A blank field in the extension
// does not erase an inherited value, which matches the stock menu: setting only
// `label` keeps the default `action`.
function mergeMenu(defaults, user) {
  var byId = {}
  var order = []
  var sets = [defaults || [], user || []]

  for (var s = 0; s < sets.length; s++) {
    for (var i = 0; i < sets[s].length; i++) {
      var entry = sets[s][i]
      if (!byId[entry.id]) {
        order.push(entry.id)
        byId[entry.id] = entry
        continue
      }
      var merged = {}
      for (var k in byId[entry.id]) merged[k] = byId[entry.id][k]
      for (var f in entry) {
        var value = entry[f]
        if (value === "" || (Array.isArray(value) && value.length === 0)) continue
        merged[f] = value
      }
      byId[entry.id] = merged
    }
  }

  return order.map(function(id) { return byId[id] })
}

function menuBreadcrumb(byId, id) {
  var parts = []
  var parent = byId[id] ? byId[id].parent : menuParent(id)
  for (var guard = 0; guard < 8 && parent; guard++) {
    var node = byId[parent]
    if (!node) break
    parts.unshift(node.label)
    parent = node.parent
  }
  return parts.join(" \u203a ")
}

// menuActionRows(items, guards) -> command rows for the actions lens.
//
// `guards` is { when: {id: bool}, disabled: {id: bool} } produced by
// guardScript()/parseGuards(). Missing guards mean "not evaluated yet": show
// the row rather than hiding it, so the lens works before the script returns.
function menuActionRows(items, guards) {
  var list = Array.isArray(items) ? items : []
  var when = (guards && guards.when) || {}
  var disabled = (guards && guards.disabled) || {}
  var byId = {}
  for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i]

  var out = []
  for (var j = 0; j < list.length; j++) {
    var item = list[j]
    if (!item.action) continue
    if (item.when && when[item.id] === false) continue

    var aliases = item.aliases.slice()
    if (item.description) aliases.push(item.description)
    var crumb = menuBreadcrumb(byId, item.id)
    var isDisabled = disabled[item.id] === true

    out.push({
      id: "action:" + item.id,
      kind: "action",
      label: item.label,
      icon: item.icon || "\uf013",
      iconFont: item.iconFont,
      chord: "",
      detail: isDisabled ? (crumb ? crumb + "  \u2713" : "\u2713 set up") : crumb,
      aliases: aliases,
      action: item.action,
      disabled: isDisabled,
      // Keep Omarchy's own menu order as the tie-break, so an empty Actions
      // lens reads System → Appearance → … instead of alphabetically.
      sortHeuristic: j
    })
  }
  return out
}

// ---------------------------------------------------------------- guards

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function guardLine(id, kind, condition) {
  return "{ if { " + condition + " ; } >/dev/null 2>&1; then echo " +
    shellQuote(id + ":" + kind + ":1") + "; else echo " +
    shellQuote(id + ":" + kind + ":0") + "; fi; }\n"
}

// One bash script evaluating every condition, in parallel buckets. The output
// is one `id:w:1` / `id:w:0` line per condition, which parseGuards() reads.
// Only ids matching the line format are emitted, so an odd id cannot inject
// shell syntax into the script.
function guardScript(items, groups) {
  var list = Array.isArray(items) ? items : []
  var lines = []

  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    if (!item.action) continue
    if (!/^[A-Za-z0-9._-]+$/.test(item.id)) continue
    if (item.when) lines.push(guardLine(item.id, "w", item.when))
    if (item.disabled) lines.push(guardLine(item.id, "d", item.disabled))
  }
  if (lines.length === 0) return ""

  var count = Math.max(1, Math.min(16, Number(groups) || 8))
  var buckets = []
  for (var b = 0; b < count; b++) buckets.push("")
  for (var j = 0; j < lines.length; j++) buckets[j % count] += lines[j]

  var script = ""
  for (var k = 0; k < count; k++) {
    if (buckets[k] === "") continue
    script += "{\n" + buckets[k] + "} &\n"
  }
  return script + "wait\n"
}

function parseGuards(text) {
  var guards = { when: {}, disabled: {} }
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = /^([A-Za-z0-9._-]+):([wd]):([01])$/.exec(lines[i].trim())
    if (!match) continue
    var value = match[3] === "1"
    if (match[2] === "w") guards.when[match[1]] = value
    else guards.disabled[match[1]] = value
  }
  return guards
}

// Only used until the live `omarchy menu keybindings --print` scan lands, or
// when that command is unavailable. The full catalog replaces this list.
function fallbackShortcuts() {
  return staticCommands().filter(function(command) { return command.kind === "shortcut" })
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// Keep the row scannable without changing the chord the user sees in the
// keybindings menu. Icons are keyword-based: the full catalog has no icon
// metadata of its own.
function shortcutIcon(text) {
  var value = String(text || "").toLowerCase()
  if (/move window|full ?screen|float|tiling|split|close window|pop window/.test(value)) return "\uf2d0"
  if (/workspace|monitor/.test(value)) return "\uf00a"
  if (/terminal|tmux|herdr|shell|foot/.test(value)) return "\uf120"
  if (/browser|web|internet/.test(value)) return "\uf0ac"
  if (/file manager|folder|files/.test(value)) return "\uf07b"
  if (/editor|code|zed|nvim|vim/.test(value)) return "\uf121"
  if (/screenshot|screenrecording|record|color picker|capture|ocr|qr/.test(value)) return "\uf030"
  if (/clipboard|copy|paste|cut/.test(value)) return "\uf0c5"
  if (/emoji/.test(value)) return "\uf118"
  if (/lock|system menu|logout|reboot|power/.test(value)) return "\uf023"
  if (/theme|appearance|background|wallpaper/.test(value)) return "\uf1fc"
  if (/brightness|light/.test(value)) return "\uf185"
  if (/volume|audio|mute|microphone|track|media|music|play|pause/.test(value)) return "\uf028"
  if (/calculator/.test(value)) return "\uf1ec"
  return "\uf11c"
}

// parseShortcutLine("SUPER + SHIFT + F → File manager") -> command | null
//
// `omarchy menu keybindings --print` is the source of truth: it already merges
// the shipped bindings with the user's overrides and leaves out internal binds
// that have no description.
function parseShortcutLine(line) {
  var raw = String(line || "").trim()
  if (!raw) return null
  var arrow = raw.indexOf("\u2192")
  if (arrow < 0) return null

  var chord = raw.slice(0, arrow).replace(/\s+/g, " ").trim()
  var label = raw.slice(arrow + 1).replace(/\s+/g, " ").trim()
  if (!chord || !label) return null

  var chordSlug = slug(chord)
  var labelSlug = slug(label)
  return {
    id: "shortcut:" + (labelSlug || "row") + ":" + (chordSlug || "none"),
    kind: "shortcut",
    label: label,
    icon: shortcutIcon(label),
    chord: chord,
    detail: "",
    aliases: []
  }
}

// ===========================================================================
// Ranking
// ---------------------------------------------------------------------------
// Adapted from omacast (https://github.com/typecraft-dev/oma-cast), itself a
// clean-room port of Raycast's root-search ranking. MIT licensed; the notice
// is kept in LICENSES/omacast-MIT.txt. Local changes: candidates are built
// from Spotlight rows, the optional flea-search branch is dropped (the
// catalog is ~330 rows), and no contact/menu-bar types are produced.
//
// The shape of the algorithm matters more than any single score:
//   * fuzzyMatch is a dynamic programme over the query, not a substring test,
//     so "mv win" and "fullscren" still find their rows;
//   * a cell scores 4 at index 0, 3 at a word boundary, 2 mid-word and 1 on a
//     separator, minus 1 for every skipped character;
//   * results are bucketed (pinned+text, pinned, text, rest) before the
//     comparator runs, so frecency can never drag a weak match over a strong
//     one;
//   * the final tie-break is natural collation, which is what keeps
//     "workspace 10" after "workspace 9".
// ===========================================================================

var SEPARATORS = "\t\n -./()[]"
var MAX_SCORE = Number.MAX_SAFE_INTEGER
var SEARCH_TERM_WINDOW_MS = 1468800000

var TYPE_PRIORITY = {
  application: 5,
  command: 4,
  quicklink: 3,
  preference: 1,
  file: 1
}

function isSeparator(ch) {
  return ch !== "" && SEPARATORS.indexOf(ch) !== -1
}

function normalize(value) {
  var text = String(value === undefined || value === null ? "" : value)
  var boundaries = []
  for (var i = 0; i < text.length; i++) {
    boundaries.push(i > 0 && /[a-z0-9]/.test(text.charAt(i - 1)) && /[A-Z]/.test(text.charAt(i)))
  }
  return { normalizedText: text.toLowerCase(), wordBoundaries: boundaries }
}

var TRANSLIT = {
  "\u00df": "ss", "\u00e6": "ae", "\u00c6": "AE", "\u00f8": "o", "\u00d8": "O",
  "\u0111": "d", "\u0110": "D", "\u0142": "l", "\u0141": "L", "\u0153": "oe",
  "\u0152": "OE", "\u00fe": "th", "\u00de": "Th", "\u00f0": "d", "\u00d0": "D",
  "\u0131": "i", "\u0127": "h", "\u0126": "H"
}

function transliterate(value) {
  var text = String(value === undefined || value === null ? "" : value)
  if (typeof text.normalize === "function") text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  var out = ""
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i)
    out += TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch
  }
  return out
}

// fuzzyMatch(target, query) -> "exact" | "unmatched" | { score, skipped }
function fuzzyMatch(target, query, options) {
  var literalDots = !!(options && options.literalQueryDots)
  var tn = normalize(target)
  var t = tn.normalizedText
  var bounds = tn.wordBoundaries
  var q = String(query === undefined || query === null ? "" : query).toLowerCase()

  function querySep(ch) {
    if (literalDots && ch === ".") return false
    return isSeparator(ch)
  }

  if (q.length === 0) return "unmatched"
  if (t === q) return "exact"

  var sepCount = 0
  for (var i = 0; i < q.length; i++) if (querySep(q.charAt(i))) sepCount++
  var u = q.length - sepCount
  if (u > t.length) return "unmatched"

  // Cheap pre-check for real queries: the letters must appear in order before
  // the DP runs. Two-letter queries skip it; the threshold below is stricter
  // for them instead.
  if (u > 2) {
    var ti = 0
    for (var qi = 0; qi < q.length; qi++) {
      var qc = q.charAt(qi)
      if (querySep(qc)) {
        for (var s = ti; s < t.length; s++) {
          if (isSeparator(t.charAt(s))) { ti = s + 1; break }
        }
        continue
      }
      var found = t.indexOf(qc, ti)
      if (found < 0) return "unmatched"
      ti = found + 1
    }
  }

  var n = t.length
  var NEG = -Infinity
  var prev = null
  var d = -1
  var p = 0
  var skipped = 0

  for (var row = 0; row < q.length; row++) {
    var ch = q.charAt(row)
    var chSep = querySep(ch)
    var cur = []
    for (var z = 0; z < n; z++) cur.push(NEG)
    var firstCol = -1
    var end = Math.min(n, n - (u - 1 - p))

    for (var e = d + 1; e < end; e++) {
      var tc = t.charAt(e)
      var sepMatch = chSep && isSeparator(tc)
      if (!(tc === ch || sepMatch)) continue

      var cellScore
      if (sepMatch) cellScore = 1
      else if (p === 0 && e === 0) cellScore = 4
      else {
        var wordStart = bounds[e] || (e > 0 && isSeparator(t.charAt(e - 1)))
        cellScore = (wordStart && !isSeparator(tc)) ? 3 : 2
      }

      var cell = NEG
      if (p === 0) {
        cell = cellScore
      } else {
        for (var r = d; r < e; r++) {
          if (prev[r] === NEG) continue
          var v = prev[r] + cellScore - (r === e - 1 ? 0 : 1)
          if (v > cell) cell = v
        }
      }
      if (cell === NEG) continue
      cur[e] = cell
      if (firstCol < 0) firstCol = e
    }

    if (firstCol >= 0) {
      d = firstCol
      p++
      prev = cur
    } else if (chSep) {
      skipped++
    } else {
      return "unmatched"
    }
  }

  if (!prev) return "unmatched"
  var best = NEG
  for (var k = 0; k < prev.length; k++) if (prev[k] > best) best = prev[k]
  if (best === NEG) return "unmatched"
  return { score: best, skipped: skipped }
}

function matchScore(match) {
  if (match === "exact") return MAX_SCORE
  if (!match || match === "unmatched") return -MAX_SCORE
  return match.score
}

// `high` is used for one- and two-letter queries: without it a pair of any
// two word-initial letters matches half the catalog.
//
// `short` is the same idea made explicit. The medium threshold is calibrated
// for real words; at three letters it lets a mid-word letter pair through
// ("ocr" used to hit "Move grou-p-ed window focus r-ight" at 6). A short
// query therefore has to clear a fixed floor instead, and a digits-only query
// gets a lower one so "10" still finds workspace 10.
function shortFloor(query) {
  var q = String(query || "").trim()
  if (!q) return null
  if (/^[0-9]+$/.test(q)) return 4
  if (q.length === 1) return 3
  if (q.length === 2) return 6
  if (q.length === 3) return 7
  return null
}

function passesThreshold(match, queryLength, sensitivity, minScore) {
  if (match === "exact") return true
  if (!match || match === "unmatched") return false
  if (typeof minScore === "number") return match.score >= minScore
  var mode = sensitivity || "medium"
  var len = queryLength - match.skipped
  if (mode === "low") return true
  if (mode === "high") return match.score > 2 * len
  // Four- and five-letter queries get a stricter bar than upstream's curve.
  // Upstream charges a flat 1 for any gap, so "calc" scored 8 against "Cycle
  // workspace layout back" and cleared the medium threshold (7). Requiring
  // more than 2 per letter keeps the tight matches and drops the scattered
  // ones. Six letters and up keep the original curve, where a late whole-word
  // hit ("screenshot" at the end of a long title) still qualifies.
  if (len === 4 || len === 5) return match.score >= 2 * len + 0.5
  return match.score >= 1.5 * (len - 2) + 4
}

function aliasMatch(alias, query) {
  var a = String(alias || "").toLowerCase()
  var q = String(query || "").toLowerCase()
  if (!a || !q) return "unmatched"
  if (a === q) return "exact"
  if (a.length > q.length && a.indexOf(q) === 0) return "prefix"
  return "unmatched"
}

// Learned terms: the queries that previously led to this row. They expire, so
// an alias you stop using falls away instead of sticking forever.
function searchTermMatch(terms, query, frecency, openedAtMs, nowMs) {
  var none = { kind: "none", count: 0 }
  if (!Array.isArray(terms) || terms.length === 0) return none
  if (!(Number(frecency) > 1)) return none
  if (typeof openedAtMs !== "number" || !isFinite(openedAtMs)) return none
  if (nowMs - openedAtMs > SEARCH_TERM_WINDOW_MS) return none
  var q = String(query || "").toLowerCase()
  if (!q) return none

  var best = none
  for (var i = 0; i < terms.length; i++) {
    var raw = terms[i]
    var s = String(raw && typeof raw === "object" ? raw.term : raw || "").toLowerCase()
    if (!s) continue
    var m = none
    if (s === q) m = { kind: "exact", count: 0 }
    else if (s.length > q.length && s.indexOf(q) === 0) m = { kind: "prefix", count: 0 }
    else if (q.indexOf(s) === 0) {
      var leftover = q.length - s.length
      if (leftover >= 1 && leftover <= 3) m = { kind: "overbounds", count: leftover }
    }
    if (searchTermRank(m) > searchTermRank(best)) best = m
  }
  return best
}

function searchTermClass(m) {
  if (!m) return 0
  if (m.kind === "exact") return 3
  if (m.kind === "prefix") return 2
  if (m.kind === "overbounds") return 1
  return 0
}

function searchTermRank(m) {
  return searchTermClass(m) * 10 + (m && m.kind === "overbounds" ? m.count : 0)
}

function wholeWordIn(title, q) {
  var tn = normalize(title)
  var t = tn.normalizedText
  var b = tn.wordBoundaries
  var from = 0
  while (true) {
    var at = t.indexOf(q, from)
    if (at < 0) return false
    var endAt = at + q.length
    var startOk = at === 0 || isSeparator(t.charAt(at - 1)) || b[at]
    var endOk = endAt === t.length || isSeparator(t.charAt(endAt)) || b[endAt]
    if (startOk && endOk) return true
    from = at + 1
  }
}

function buildRecord(candidate, query, options) {
  var opts = options || {}
  var sensitivity = opts.sensitivity || "medium"
  var nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now()
  var literalDots = !!opts.literalQueryDots
  var c = candidate || {}
  var q = String(query || "").trim().toLowerCase()
  var tq = transliterate(q)
  var minScore = typeof opts.minScore === "number" ? opts.minScore : null
  // One- to three-letter queries are title-only. Descriptions, desktop-file
  // keywords and chords are long strings, and the matcher charges a flat 1 for
  // any gap, so "ff" would otherwise land on any keyword with two f's
  // ("folder manager … filesystem"). Aliases still apply: an exact or prefix
  // alias is an explicit promise, not a coincidence.
  var titleOnly = minScore !== null
  var frecency = typeof c.frecency === "number" && isFinite(c.frecency) ? c.frecency : 1

  var record = {
    candidate: c,
    query: q,
    type: c.type,
    typePriority: TYPE_PRIORITY[c.type] !== undefined ? TYPE_PRIORITY[c.type] : 0,
    frecency: frecency,
    hasAlias: !!c.alias,
    alias: aliasMatch(c.alias, q),
    isBoostedSearchTerm: false,
    title: "unmatched",
    titleMatch: "none",
    titleScore: -MAX_SCORE,
    alternates: [],
    subtitle: null,
    subtitleExact: false,
    subtitleScore: -MAX_SCORE,
    keywords: [],
    keywordScore: -MAX_SCORE,
    searchTerm: { kind: "none", count: 0 },
    textMatched: false,
    isMatching: !!c.alwaysMatching
  }
  if (!q) return record

  record.isBoostedSearchTerm = Array.isArray(c.boostedTerms) && c.boostedTerms.some(function(term) {
    return String(term || "").toLowerCase() === q
  })

  var title = transliterate(String(c.title || ""))
  if (tq.charAt(0) === "/") title = title.replace("/", " ")
  var titleLower = title.toLowerCase()
  var alternates = Array.isArray(c.alternateTitles) ? c.alternateTitles.map(function(a) { return String(a || "") }) : []
  record.title = fuzzyMatch(title, tq, { literalQueryDots: literalDots })
  if (record.title === "exact") record.titleMatch = "exact"
  else if (titleLower.indexOf(q) === 0 || alternates.some(function(a) { return a.toLowerCase().indexOf(q) === 0 }))
    record.titleMatch = "prefix"
  record.titleScore = matchScore(record.title)

  record.alternates = alternates.map(function(a) { return fuzzyMatch(a, q, { literalQueryDots: literalDots }) })

  var subtitle = String(c.subtitle || "")
  if (!titleOnly && subtitle && subtitle.toLowerCase() !== String(c.title || "").toLowerCase()) {
    record.subtitle = fuzzyMatch(subtitle, q, { literalQueryDots: literalDots })
    record.subtitleExact = record.subtitle === "exact"
    record.subtitleScore = matchScore(record.subtitle)
  }

  // For short queries only the title counts; see titleOnly above.
  var keywords = Array.isArray(c.keywords) ? c.keywords.slice() : []
  if (!titleOnly && subtitle) {
    keywords.push(String(c.title || "") + " " + subtitle)
    keywords.push(subtitle + " " + String(c.title || ""))
  }
  if (!titleOnly && c.bundleId && q.indexOf(".") !== -1) keywords.push(String(c.bundleId))
  // A chord is only searched when the query looks like one. Otherwise every
  // modifier-heavy binding matches every four-letter word.
  if (!titleOnly && c.chord && /^(super|sup|ctrl|alt|shift|print|fn)\b/.test(q)) {
    keywords.push(String(c.chord))
  }
  record.keywords = titleOnly
    ? []
    : keywords.map(function(k) { return fuzzyMatch(String(k || ""), q, { literalQueryDots: literalDots }) })

  // Upstream throws keyword scores away, so two rows that only match on a
  // keyword fall back to alphabetical order. Keeping the best keyword score
  // makes "files" put "Files" (exact title) then the closest keyword hit, not
  // whichever name sorts first.
  for (var kw = 0; kw < record.keywords.length; kw++) {
    var kwScore = matchScore(record.keywords[kw])
    if (kwScore > record.keywordScore) record.keywordScore = kwScore
  }

  record.searchTerm = searchTermMatch(c.searchTerms, q, frecency, c.openedAt, nowMs)

  if (q.length >= 3 && !/\s/.test(q)) {
    // A whole-word hit elsewhere in the title is a strong signal, but a title
    // that *starts* with the query is at least as strong: without this guard
    // "calc" ranked "LibreOffice Calc" (whole word, 10.5) over "Calculator"
    // (prefix at index 0, 10).
    if (record.title !== "exact" && titleLower.indexOf(q) !== 0 && wholeWordIn(title, tq)) {
      var floor = 4 + (q.length - 1) * 2 + 0.5
      if (record.titleScore < floor) record.titleScore = floor
    }
    var exactAlternate = record.alternates.some(function(m) { return m === "exact" })
    if (exactAlternate) {
      record.titleMatch = "exact"
    } else {
      for (var i = 0; i < record.alternates.length; i++) {
        var s = matchScore(record.alternates[i])
        if (s > record.titleScore) record.titleScore = s
      }
    }
  }

  var len = q.length
  record.textMatched = record.alias !== "unmatched"
    || passesThreshold(record.title, len, sensitivity, minScore)
    || record.alternates.some(function(m) { return passesThreshold(m, len, sensitivity, minScore) })
    || (!titleOnly && passesThreshold(record.subtitle, len, sensitivity, minScore))
    || (!titleOnly && record.keywords.some(function(m) { return passesThreshold(m, len, sensitivity, minScore) }))
    // A learned term is an explicit association: "ff" was typed when this row
    // was picked. Upstream only lets it break ties; here it also recalls the
    // row, because otherwise the term is recorded and never used. Exact and
    // prefix only, so a one-letter habit cannot leak into longer queries.
    || record.searchTerm.kind === "exact"
    || record.searchTerm.kind === "prefix"
  record.isMatching = !!c.alwaysMatching || record.textMatched
  return record
}

// Natural collation: "workspace 9" before "workspace 10".
//
// Written out rather than delegated to localeCompare({numeric:true}) because
// Qt's JS engine is not guaranteed to honour the options object, and this is
// the one comparison the workspace rows depend on.
function collate(a, b) {
  var left = String(a || "")
  var right = String(b || "")
  if (left === right) return 0
  var l = left.toLowerCase()
  var r = right.toLowerCase()
  var li = 0
  var ri = 0

  while (li < l.length && ri < r.length) {
    var lc = l.charAt(li)
    var rc = r.charAt(ri)
    var lDigit = lc >= "0" && lc <= "9"
    var rDigit = rc >= "0" && rc <= "9"

    if (lDigit && rDigit) {
      var ln = ""
      var rn = ""
      while (li < l.length && l.charAt(li) >= "0" && l.charAt(li) <= "9") ln += l.charAt(li++)
      while (ri < r.length && r.charAt(ri) >= "0" && r.charAt(ri) <= "9") rn += r.charAt(ri++)
      var diff = Number(ln) - Number(rn)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }

    if (lc !== rc) return lc < rc ? -1 : 1
    li++
    ri++
  }

  if (l.length !== r.length) return l.length < r.length ? -1 : 1
  return l < r ? -1 : (l > r ? 1 : 0)
}

function heuristic(record) {
  var h = record.candidate.sortHeuristic
  return typeof h === "number" && isFinite(h) ? h : 0
}

function comparePlain(a, b) {
  if (a.frecency !== b.frecency) return b.frecency - a.frecency
  if (a.hasAlias !== b.hasAlias) return a.hasAlias ? -1 : 1
  if (a.typePriority !== b.typePriority) return b.typePriority - a.typePriority
  var h = heuristic(a) - heuristic(b)
  if (h !== 0) return h
  var ext = collate(a.candidate.extensionTitle, b.candidate.extensionTitle)
  if (ext !== 0) return ext
  return collate(a.candidate.title, b.candidate.title)
}

function hasStrongMatch(r) {
  return r.alias === "exact" || r.alias === "prefix"
    || r.titleMatch === "exact" || r.titleMatch === "prefix"
    || r.subtitleExact
    || r.searchTerm.kind === "exact" || r.searchTerm.kind === "prefix"
}

function overboundsCount(r) {
  return r.searchTerm.kind === "overbounds" ? r.searchTerm.count : 0
}

function compareMatched(a, b, ctx) {
  var context = ctx || {}
  var aExactAlias = a.alias === "exact", bExactAlias = b.alias === "exact"
  if (aExactAlias !== bExactAlias) return aExactAlias ? -1 : 1

  var aTermExact = a.searchTerm.kind === "exact", bTermExact = b.searchTerm.kind === "exact"
  if (context.hasExactTitle && context.hasExactSearchTerm) {
    if (aTermExact !== bTermExact) return aTermExact ? -1 : 1
    if (aTermExact && bTermExact && a.frecency !== b.frecency) return b.frecency - a.frecency
  }

  if (a.isBoostedSearchTerm !== b.isBoostedSearchTerm) {
    var boosted = a.isBoostedSearchTerm ? a : b
    var other = a.isBoostedSearchTerm ? b : a
    if (!(other.frecency > 1 && other.frecency > boosted.frecency)) return a.isBoostedSearchTerm ? -1 : 1
  }

  if (context.hasExactTitle) {
    var aExactTitle = a.titleMatch === "exact", bExactTitle = b.titleMatch === "exact"
    if (aExactTitle && bExactTitle) {
      var classDiff = searchTermRank(b.searchTerm) - searchTermRank(a.searchTerm)
      if (classDiff !== 0) return classDiff
      if (a.frecency !== b.frecency) return b.frecency - a.frecency
      return comparePlain(a, b)
    }
    if (aExactTitle !== bExactTitle) return aExactTitle ? -1 : 1
  }

  if (aTermExact !== bTermExact) return aTermExact ? -1 : 1
  if (aTermExact && bTermExact) {
    if (a.frecency !== b.frecency) return b.frecency - a.frecency
    return comparePlain(a, b)
  }

  if (a.subtitleExact !== b.subtitleExact) return a.subtitleExact ? -1 : 1
  if (a.subtitleExact && b.subtitleExact) {
    if (a.frecency !== b.frecency) return b.frecency - a.frecency
    if (a.titleScore !== b.titleScore) return b.titleScore - a.titleScore
    return comparePlain(a, b)
  }

  var aAliasPrefix = a.alias === "prefix", bAliasPrefix = b.alias === "prefix"
  if (aAliasPrefix !== bAliasPrefix) return aAliasPrefix ? -1 : 1
  var aTermPrefix = a.searchTerm.kind === "prefix", bTermPrefix = b.searchTerm.kind === "prefix"
  if (aTermPrefix !== bTermPrefix) return aTermPrefix ? -1 : 1
  if ((aAliasPrefix && bAliasPrefix) || (aTermPrefix && bTermPrefix)) {
    if (a.frecency !== b.frecency) return b.frecency - a.frecency
  }

  // A title that starts with the query beats a whole-word hit further along.
  // Upstream's whole-word boost is 0.5 above the start-of-title score, which
  // made "calc" put "LibreOffice Calc" first; this restores the intuitive
  // order without touching the match scores themselves.
  var aTitlePrefix = a.titleMatch === "prefix"
  var bTitlePrefix = b.titleMatch === "prefix"
  if (aTitlePrefix !== bTitlePrefix) return aTitlePrefix ? -1 : 1

  var ao = overboundsCount(a), bo = overboundsCount(b)
  if ((ao >= 3 || bo >= 3) && ao !== bo) return bo - ao

  var aBest = Math.max(a.titleScore, a.subtitleScore)
  var bBest = Math.max(b.titleScore, b.subtitleScore)
  if (aBest !== bBest) return bBest - aBest

  // Both rows only matched a keyword, so the title scores are equal and
  // meaningless. Rank them by how well the keyword matched.
  if (aBest === -MAX_SCORE && a.keywordScore !== b.keywordScore) {
    return b.keywordScore - a.keywordScore
  }

  if (a.frecency !== b.frecency) return b.frecency - a.frecency

  // With scores tied, the tighter match is the shorter title. Without this,
  // "mw" ranked "Make webcam overlay larger" above "Move window" purely
  // because of alphabetical order.
  var aLen = String(a.candidate.title || "").length
  var bLen = String(b.candidate.title || "").length
  if (aLen !== bLen) return aLen - bLen

  if (a.titleScore !== b.titleScore) return b.titleScore - a.titleScore
  if (a.typePriority !== b.typePriority) return b.typePriority - a.typePriority
  var h = heuristic(a) - heuristic(b)
  if (h !== 0) return h
  return collate(a.candidate.title, b.candidate.title)
}

function sign(x) {
  return x < 0 ? -1 : (x > 0 ? 1 : 0)
}

function stableSort(records, compare) {
  var indexed = records.map(function(r, i) { return { r: r, i: i } })
  indexed.sort(function(x, y) {
    var c = sign(compare(x.r, y.r))
    return c !== 0 ? c : x.i - y.i
  })
  return indexed.map(function(x) { return x.r })
}

function pinOf(record) {
  var p = record.candidate.pinPriority
  return typeof p === "number" && isFinite(p) ? p : null
}

function bucketContext(records) {
  return {
    hasExactTitle: records.some(function(r) { return r.titleMatch === "exact" }),
    hasExactSearchTerm: records.some(function(r) { return r.searchTerm.kind === "exact" })
  }
}

function byPinThen(then) {
  return function(a, b) {
    var d = pinOf(a) - pinOf(b)
    return d !== 0 ? d : then(a, b)
  }
}

// rankCandidates(candidates, query, options) -> [{ candidate, record }]
function rankCandidates(candidates, query, options) {
  var list = Array.isArray(candidates) ? candidates : []
  var q = String(query || "").trim()
  var records = list.map(function(c) { return buildRecord(c, q, options) })
  var ordered

  if (!q) {
    var pinned = records.filter(function(r) { return pinOf(r) !== null })
    var rest = records.filter(function(r) { return pinOf(r) === null })
    ordered = stableSort(pinned, byPinThen(comparePlain)).concat(stableSort(rest, comparePlain))
  } else {
    var b1 = [], b2 = [], b3 = [], b4 = []
    for (var i = 0; i < records.length; i++) {
      var r = records[i]
      if (!r.isMatching) continue
      var isPinned = pinOf(r) !== null
      if (isPinned && r.textMatched) b1.push(r)
      else if (isPinned) b2.push(r)
      else if (r.textMatched) b3.push(r)
      else b4.push(r)
    }
    var c1 = bucketContext(b1), c3 = bucketContext(b3)
    ordered = stableSort(b1, byPinThen(function(a, b) { return compareMatched(a, b, c1) }))
      .concat(stableSort(b2, byPinThen(comparePlain)))
      .concat(stableSort(b3, function(a, b) { return compareMatched(a, b, c3) }))
      .concat(stableSort(b4, comparePlain))
  }

  return ordered.map(function(r) { return { candidate: r.candidate, record: r } })
}

// --------------------------------------------------------------- adapters

// Chords are searched without the plus signs: "super shift f" should read as
// words, and a stray "+" would otherwise have to be skipped by the matcher.
function chordKeyword(chord) {
  return String(chord || "").replace(/\s*\+\s*/g, " ").replace(/\s+/g, " ").trim()
}

// toCandidate(command, usage) -> the ranker's input shape.
//
// `usage` is the snapshot map (id -> { count, last, frecency, openedAt, terms,
// alias }). Missing history is fine: frecency 1 means "no signal" and the row
// is ranked on text alone.
function toCandidate(command, usage) {
  var signal = usage && usage[command.id]
  var keywords = []
  if (command.detail) keywords.push(command.detail)
  var aliases = Array.isArray(command.aliases) ? command.aliases : []
  for (var i = 0; i < aliases.length; i++) if (aliases[i]) keywords.push(aliases[i])

  var frecency = signal && Number(signal.frecency)
  return {
    id: command.id,
    type: command.kind === "app" ? "application" : "command",
    title: command.label || "",
    subtitle: command.detail || "",
    keywords: keywords,
    // Kept apart from `keywords` so buildRecord can decide whether the query
    // is chord-like. Chords match almost anything: "calc" used to hit
    // "SUPER CTRL ALT C".
    chord: chordKeyword(command.chord),
    alias: signal && signal.alias ? String(signal.alias) : "",
    frecency: frecency > 0 ? frecency : 1,
    openedAt: signal && Number(signal.openedAt) ? Number(signal.openedAt) : 0,
    searchTerms: signal && Array.isArray(signal.terms) ? signal.terms : [],
    sortHeuristic: typeof command.sortHeuristic === "number" ? command.sortHeuristic : 0
  }
}

// Rank a pool of commands and return the surviving commands in rank order.
// Short queries use an explicit score floor: the medium threshold lets any
// two word-initial letters match, which is noise before there is history.
function rankPool(pool, needle, usage, nowMs) {
  var candidates = []
  for (var i = 0; i < pool.length; i++) candidates.push(toCandidate(pool[i], usage))

  var floor = shortFloor(needle)
  var options = { nowMs: nowMs, sensitivity: floor === null ? "medium" : "short" }
  if (floor !== null) options.minScore = floor
  var ranked = rankCandidates(candidates, needle, options)

  var byId = {}
  for (var j = 0; j < pool.length; j++) byId[pool[j].id] = pool[j]

  var out = []
  for (var k = 0; k < ranked.length; k++) {
    var command = byId[ranked[k].candidate.id]
    if (command) out.push(command)
  }
  return out
}

// ===========================================================================
// Lenses
// ===========================================================================

function lensKind(lens) {
  if (lens === "apps") return "app"
  if (lens === "actions") return "action"
  if (lens === "shortcuts") return "shortcut"
  if (lens === "files") return "file"
  return "all"
}

function kindTitle(kind) {
  if (kind === "app") return "Apps"
  if (kind === "action") return "Actions"
  if (kind === "shortcut") return "Shortcuts"
  if (kind === "file") return "Files"
  return "Results"
}

function lensTitle(lens) {
  if (lens === "apps") return "Apps"
  if (lens === "actions") return "Actions"
  if (lens === "shortcuts") return "Shortcuts"
  if (lens === "files") return "Files"
  return "Everything"
}

function lensLabel(lens) {
  return lensTitle(lens)
}

var LENS_ORDER = ["all", "apps", "actions", "shortcuts", "files"]

function nextLens(lens, direction) {
  var index = LENS_ORDER.indexOf(lens)
  if (index < 0) index = 0
  var step = direction < 0 ? -1 : 1
  return LENS_ORDER[(index + step + LENS_ORDER.length) % LENS_ORDER.length]
}

function findById(commands, id) {
  for (var i = 0; i < commands.length; i++) {
    if (commands[i].id === id) return commands[i]
  }
  return null
}

// Curated wireframe suggestions. These are only shown when the command exists
// in the live catalog, so a missing app never produces a dead row.
var FOR_YOU = [
  { id: "app:foot", detail: "recently" },
  { id: "app:brave-browser", detail: "used 14\u00d7" },
  { id: "action:screenshot", detail: "2 min ago" }
]

var RECENT = [
  { id: "app:dev.zed.Zed", detail: "1h ago" },
  { id: "app:org.gnome.Nautilus", detail: "yesterday" },
  { id: "app:Discord", detail: "yesterday" }
]

function curated(commands, picks, section, out, seen) {
  for (var i = 0; i < picks.length; i++) {
    var command = findById(commands, picks[i].id)
    if (!command || seen[command.id]) continue
    seen[command.id] = true
    out.push(row(command, section, picks[i].detail))
  }
}

// File rows come from the bridge CLI (`spotlight files`), not from the app
// catalog: they change with every query, so they are merged at render time.
// Opening one is `gio open`, which is what makes the desktop's default handler
// apply without Spotlight knowing any MIME types.
function fileIcon(name) {
  var ext = String(name || "").toLowerCase().split(".").pop()
  if (/^(png|jpe?g|gif|webp|bmp|svg|heic|avif|tiff?|ico)$/.test(ext)) return "\uf1c5"
  if (/^(mp4|mkv|webm|mov|avi|m4v)$/.test(ext)) return "\uf008"
  if (/^(mp3|flac|wav|ogg|m4a|opus)$/.test(ext)) return "\uf001"
  if (ext === "pdf") return "\uf1c1"
  if (/^(zip|tar|gz|xz|zst|7z|rar|bz2)$/.test(ext)) return "\uf1c6"
  if (/^(js|ts|tsx|jsx|qml|py|rs|go|c|h|cpp|lua|sh|json|toml|yaml|yml|md|txt|log|conf)$/.test(ext)) return "\uf15c"
  if (/^(appimage|exe|bin|run|deb|rpm|pkg)$/.test(ext)) return "\uf085"
  return "\uf016"
}

function toFileRow(file) {
  var path = String((file && file.path) || "")
  return {
    id: "file:" + path,
    kind: "file",
    label: String((file && file.name) || path.split("/").pop() || path),
    icon: fileIcon((file && file.name) || path),
    chord: "",
    detail: String((file && file.dir) || ""),
    aliases: [],
    path: path
  }
}

// group(commands, lens, query, smart, usage, files) -> flat array of rows carrying a
// `section`. An empty query yields the smart view; a typed query yields ranked
// groups. `smart` is { forYou, recent } computed from real usage signals; when
// it has no history at all the curated demo picks keep the surface warm.
// `usage` is the snapshot map the ranker reads for frecency and learned terms.
function group(commands, lens, query, smart, usage, files) {
  var list = Array.isArray(commands) ? commands : []
  var kind = lensKind(lens)
  var pool = list.filter(function(command) {
    return kind === "all" || command.kind === kind
  })
  var needle = String(query || "").trim()
  var nowMs = Date.now()
  var fileRows = (Array.isArray(files) ? files : []).map(toFileRow)

  // The files lens is fed by the bridge, already filtered. Everything appends
  // a Files section after the ranked groups; the empty view does not, so For
  // you / Recent stay a usage block.
  if (lens === "files") {
    return fileRows.map(function(file) {
      return row(file, "Files", file.detail)
    })
  }

  if (needle === "") {
    if (lens !== "all") {
      // Most-used first rather than catalog order; catalog order is whatever
      // the app library or the keybinding scan happened to emit.
      return rankPool(pool, "", usage, nowMs).slice(0, 16).map(function(command) {
        return row(command, lensTitle(lens), "")
      })
    }

    var out = []
    var seen = {}
    var smartForYou = smart && Array.isArray(smart.forYou) ? smart.forYou : []
    var smartRecent = smart && Array.isArray(smart.recent) ? smart.recent : []
    var hasHistory = smartForYou.length + smartRecent.length > 0

    curated(list, hasHistory ? smartForYou : FOR_YOU, "For you", out, seen)
    curated(list, hasHistory ? smartRecent : RECENT, "Recent", out, seen)

    // Cold start: if the curated ids are not installed, fill the stage with
    // real apps rather than leaving it nearly empty.
    if (out.length < 3) {
      var apps = pool.filter(function(command) { return command.kind === "app" })
      for (var i = 0; i < apps.length && out.length < 6; i++) {
        if (seen[apps[i].id]) continue
        seen[apps[i].id] = true
        out.push(row(apps[i], out.length < 3 ? "For you" : "Recent", ""))
      }
    }
    return out
  }

  var ranked = rankPool(pool, needle, usage, nowMs)

  if (lens !== "all") {
    return ranked.map(function(command) {
      return row(command, lensTitle(lens), command.detail || "")
    })
  }

  // Keep the Apps / Actions / Shortcuts sections, but order them by their best
  // match instead of a fixed kind order. If the strongest hit is a shortcut,
  // the Shortcuts section is what the eye lands on first.
  var buckets = []
  var byKind = {}
  for (var r = 0; r < ranked.length; r++) {
    var command = ranked[r]
    if (!byKind[command.kind]) {
      byKind[command.kind] = { title: kindTitle(command.kind), rows: [] }
      buckets.push(byKind[command.kind])
    }
    byKind[command.kind].rows.push(row(command, byKind[command.kind].title, command.detail || ""))
  }

  var grouped = []
  for (var b = 0; b < buckets.length; b++) grouped = grouped.concat(buckets[b].rows)

  for (var f = 0; f < fileRows.length && f < 6; f++) {
    grouped.push(row(fileRows[f], "Files", fileRows[f].detail))
  }
  return grouped
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    staticCommands: staticCommands,
    actionsOnly: actionsOnly,
    parseMenu: parseMenu,
    mergeMenu: mergeMenu,
    menuActionRows: menuActionRows,
    guardScript: guardScript,
    parseGuards: parseGuards,
    shellQuote: shellQuote,
    fallbackShortcuts: fallbackShortcuts,
    parseShortcutLine: parseShortcutLine,
    shortcutIcon: shortcutIcon,
    slug: slug,
    // ranking (portable, so the matcher can be tested without QML)
    fuzzyMatch: fuzzyMatch,
    passesThreshold: passesThreshold,
    shortFloor: shortFloor,
    toCandidate: toCandidate,
    rankCandidates: rankCandidates,
    rankPool: rankPool,
    collate: collate,
    fileIcon: fileIcon,
    toFileRow: toFileRow,
    group: group,
    nextLens: nextLens,
    lensLabel: lensLabel,
    lensTitle: lensTitle,
    kindTitle: kindTitle
  }
}

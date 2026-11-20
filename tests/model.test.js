// Ranking tests for k0d3d.spotlight.
//
//   node --test tests/
//
// Model.js and Storage.js are plain JS on purpose, so the matcher can be
// exercised without a running shell. Pure functions only: no filesystem, no
// QML, no clock except the `nowMs` passed in.

const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const Model = require(path.join(__dirname, "..", "Model.js"))
const Storage = require(path.join(__dirname, "..", "Storage.js"))

const NOW = 1_800_000_000_000
const DAY = 86_400_000

const app = (title, extra = {}) => ({
  id: extra.id || "app:" + title,
  kind: "app",
  label: title,
  chord: "",
  detail: "",
  aliases: [],
  ...extra
})

const shortcut = (label, chord) => ({
  id: "shortcut:" + Model.slug(label) + ":" + Model.slug(chord),
  kind: "shortcut",
  label,
  chord,
  detail: "",
  aliases: []
})

// ------------------------------------------------------------------ matching

test("fuzzyMatch: exact, prefix and word-initial matches", () => {
  assert.equal(Model.fuzzyMatch("Files", "files"), "exact")
  assert.equal(Model.fuzzyMatch("Firefox", "fir").score, 8)      // 4 + 2 + 2
  assert.equal(Model.fuzzyMatch("Firefox", "fx").score, 5)       // 4 + 2 - 1
  assert.equal(Model.fuzzyMatch("Full screen", "fs").score, 6)   // 4 + 3 - 1
  assert.equal(Model.fuzzyMatch("LibreOffice Writer", "lo").score, 6)
  assert.equal(Model.fuzzyMatch("abc", "cba"), "unmatched")
  assert.equal(Model.fuzzyMatch("Files", "first"), "unmatched")
})

test("fuzzyMatch: transposed/missing letters still match a title", () => {
  // These are the cases the old substring matcher returned nothing for.
  assert.notEqual(Model.fuzzyMatch("Full screen", "fullscren"), "unmatched")
  assert.notEqual(Model.fuzzyMatch("Move window", "mv win"), "unmatched")
  assert.notEqual(Model.fuzzyMatch("Brave", "brv"), "unmatched")
})

test("short queries have a floor and do not use long keyword strings", () => {
  assert.equal(Model.shortFloor("f"), 3)
  assert.equal(Model.shortFloor("ff"), 6)
  assert.equal(Model.shortFloor("ocr"), 7)
  assert.equal(Model.shortFloor("10"), 4)
  assert.equal(Model.shortFloor("files"), null)

  // "ff" must not match a desktop file that merely lists "files … filesystem".
  const files = app("Files", { aliases: ["folder manager explore disk filesystem nautilus"] })
  assert.deepEqual(Model.group([files], "all", "ff", null, null), [])
})

test("natural collation orders workspace 9 before workspace 10", () => {
  assert.ok(Model.collate("workspace 9", "workspace 10") < 0)
  assert.ok(Model.collate("workspace 10", "workspace 2") > 0)
  assert.ok(Model.collate("Workspace 1", "workspace 1") === 0)
})

// ------------------------------------------------------------------ ranking

test("rankPool: exact title first, prefix before scattered matches", () => {
  const pool = [
    shortcut("Calculator", "SUPER SHIFT + Q"),
    app("LibreOffice Calc"),
    app("Omacalc"),
    app("Cycle workspace layout back")
  ]
  const ranked = Model.rankPool(pool, "calc", null, NOW)
  assert.equal(ranked[0].label, "Calculator")
  assert.equal(ranked[1].label, "LibreOffice Calc")
  assert.ok(!ranked.some((c) => c.label === "Cycle workspace layout back"))
})

test("rankPool: workspace moves keep numeric order", () => {
  const pool = [1, 2, 9, 10].map((n) => shortcut("Move window to workspace " + n, "SUPER SHIFT + " + n))
  const ranked = Model.rankPool(pool, "move window", null, NOW)
  assert.deepEqual(ranked.map((c) => c.label), [
    "Move window to workspace 1",
    "Move window to workspace 2",
    "Move window to workspace 9",
    "Move window to workspace 10"
  ])
})

test("rankPool: frecency lifts a used row above a colder twin", () => {
  const pool = [
    app("Files", { id: "app:files" }),
    app("Flea", { id: "app:flea" })
  ]
  const usage = {
    "app:flea": { count: 9, last: NOW, frecency: 500, openedAt: NOW, terms: [] }
  }
  const ranked = Model.rankPool(pool, "f", usage, NOW)
  assert.equal(ranked[0].label, "Flea")
})

test("learned terms recall a row and expire after 17 days", () => {
  const pool = [app("Files", { id: "app:files" })]
  const usage = {
    "app:files": {
      count: 2, last: NOW, frecency: 190, openedAt: NOW,
      terms: [{ term: "ff", at: NOW }]
    }
  }
  assert.equal(Model.rankPool(pool, "ff", usage, NOW).length, 1)

  const stale = {
    "app:files": {
      count: 2, last: NOW, frecency: 190,
      openedAt: NOW - 18 * DAY,
      terms: [{ term: "ff", at: NOW - 18 * DAY }]
    }
  }
  assert.equal(Model.rankPool(pool, "ff", stale, NOW).length, 0)
})

test("learned terms do not recall without frecency", () => {
  const pool = [app("Files", { id: "app:files" })]
  const usage = {
    "app:files": { count: 1, last: NOW, frecency: 1, openedAt: NOW, terms: [{ term: "ff", at: NOW }] }
  }
  assert.equal(Model.rankPool(pool, "ff", usage, NOW).length, 0)
})

// ------------------------------------------------------------------ grouping

test("group: Everything orders sections by their best match", () => {
  const pool = [
    app("Chrome"),
    shortcut("Extract text (OCR) from screenshot", "SUPER CTRL + PRINT")
  ]
  const rows = Model.group(pool, "all", "ocr", null, null)
  assert.equal(rows[0].kind, "shortcut")
  assert.equal(rows[0].section, "Shortcuts")
})

test("group: lens filters to one kind", () => {
  const pool = [app("Chrome"), shortcut("Terminal", "SUPER + RETURN")]
  const rows = Model.group(pool, "apps", "chr", null, null)
  assert.deepEqual(rows.map((r) => r.kind), ["app"])
})

test("group: empty query in a lens is usage-ordered, not catalog-ordered", () => {
  const pool = [app("Alpha"), app("Beta", { id: "app:beta" })]
  const usage = { "app:beta": { count: 4, last: NOW, frecency: 300, openedAt: NOW, terms: [] } }
  assert.equal(Model.group(pool, "apps", "", null, usage)[0].label, "Beta")
})

test("group: smart block only shows rows that exist in the catalog", () => {
  const pool = [app("Chrome")]
  const smart = { forYou: [{ id: "app:gone", detail: "used 9×" }], recent: [] }
  const rows = Model.group(pool, "all", "", smart, null)
  assert.ok(!rows.some((r) => r.id === "app:gone"))
  assert.equal(rows[0].label, "Chrome")
})

// --------------------------------------------------------------------- files

const FILES = [
  { path: "/home/u/Pictures/sunset.png", name: "sunset.png", dir: "~/Pictures" },
  { path: "/home/u/Work/notes.md", name: "notes.md", dir: "~/Work" }
]

test("group: files lens returns file rows", () => {
  const rows = Model.group([], "files", "", null, null, FILES)
  assert.deepEqual(rows.map((r) => r.kind), ["file", "file"])
  assert.equal(rows[0].section, "Files")
  assert.equal(rows[0].label, "sunset.png")
  assert.equal(rows[0].detail, "~/Pictures")
})

test("group: Everything appends files after ranked groups", () => {
  const rows = Model.group([app("Chrome")], "all", "chr", null, null, FILES)
  assert.equal(rows[0].kind, "app")
  assert.equal(rows[rows.length - 1].kind, "file")
})

test("group: the empty view never shows files", () => {
  const rows = Model.group([app("Chrome")], "all", "", null, null, FILES)
  assert.ok(!rows.some((r) => r.kind === "file"))
})

test("files have useful icons and a stable namespaced id", () => {
  assert.equal(Model.fileIcon("sunset.png"), "\uf1c5")
  assert.equal(Model.fileIcon("notes.md"), "\uf15c")
  assert.equal(Model.fileIcon("song.flac"), "\uf001")
  assert.equal(Model.fileIcon("no-extension"), "\uf016")
  assert.equal(Model.toFileRow(FILES[0]).id, "file:/home/u/Pictures/sunset.png")
})

test("Tab reaches the files lens", () => {
  assert.equal(Model.nextLens("shortcuts", 1), "files")
  assert.equal(Model.nextLens("files", 1), "all")
  assert.equal(Model.nextLens("all", -1), "files")
})

// -------------------------------------------------------------------- actions

test("parseMenu strips comments and trailing commas", () => {
  const items = Model.parseMenu('{\n  // a comment\n  "a": {"label": "A", "action": "echo a",},\n  "a.b": {"label": "B"},\n}')
  assert.equal(items.length, 2)
  assert.equal(items.find((i) => i.id === "a").action, "echo a")
  assert.equal(items.find((i) => i.id === "a.b").parent, "a")
})

test("parseMenu returns nothing for unreadable input", () => {
  assert.deepEqual(Model.parseMenu("{not json"), [])
  assert.deepEqual(Model.parseMenu(""), [])
})

test("mergeMenu: user overrides a field without wiping the action", () => {
  const defs = Model.parseMenu('{"system.lock":{"label":"Lock","action":"omarchy-system-lock"}}')
  const user = Model.parseMenu('{"system.lock":{"label":"Lock screen"}}')
  const merged = Model.mergeMenu(defs, user)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].label, "Lock screen")
  assert.equal(merged[0].action, "omarchy-system-lock")
})

test("menuActionRows: menus are skipped, when=false hides, disabled is marked", () => {
  const items = Model.parseMenu(JSON.stringify({
    system: { label: "System" },
    "system.lock": { label: "Lock", action: "lock" },
    "system.suspend": { label: "Suspend", action: "suspend", when: "cond" },
    "install.x": { label: "X", action: "install x", disabled: "cond" }
  }))
  const rows = Model.menuActionRows(items, {
    when: { "system.suspend": false },
    disabled: { "install.x": true }
  })
  assert.deepEqual(rows.map((r) => r.label), ["Lock", "X"])
  assert.equal(rows[0].detail, "System")
  assert.equal(rows[0].kind, "action")
  assert.equal(rows[1].disabled, true)
})

test("guardScript emits conditioned lines and parseGuards reads them", () => {
  const script = Model.guardScript([
    { id: "a.b", action: "x", when: "true", disabled: "false" },
    { id: "menu.only" }
  ], 2)
  assert.match(script, /a\.b:w:/)
  assert.match(script, /a\.b:d:/)
  assert.ok(!script.includes("menu.only"))
  assert.deepEqual(Model.parseGuards("a.b:w:1\nc.d:d:0\njunk\n"), {
    when: { "a.b": true },
    disabled: { "c.d": false }
  })
})

test("guardScript declines ids that could break the shell line", () => {
  const script = Model.guardScript([{ id: "bad id;rm", action: "x", when: "true" }], 1)
  assert.equal(script, "")
})

// ------------------------------------------------------------------- storage

test("smartPicks: frecency beats raw count, Recent stays last-seen", () => {
  const commands = [
    app("Old favourite", { id: "app:old" }),
    app("Second", { id: "app:second" }),
    app("Third", { id: "app:third" }),
    app("New burst", { id: "app:new" })
  ]
  const signals = {
    "app:old": { count: 20, last: NOW - 40 * DAY, frecency: 400, types: { launch: 20 } },
    "app:second": { count: 9, last: NOW - 2 * DAY, frecency: 300, types: { launch: 9 } },
    "app:third": { count: 6, last: NOW - 3 * DAY, frecency: 200, types: { launch: 6 } },
    "app:new": { count: 3, last: NOW, frecency: 120, types: { launch: 3 } }
  }
  const picks = Storage.smartPicks(signals, commands, NOW)
  assert.equal(picks.forYou[0].id, "app:old")
  assert.equal(picks.forYou.length, 3)
  assert.equal(picks.recent[0].id, "app:new")
})

test("smartPicks: snapshots without frecency fall back to count", () => {
  const commands = [app("A", { id: "app:a" }), app("B", { id: "app:b" })]
  const signals = {
    "app:a": { count: 2, last: NOW, types: { launch: 2 } },
    "app:b": { count: 7, last: NOW - DAY, types: { launch: 7 } }
  }
  assert.equal(Storage.smartPicks(signals, commands, NOW).forYou[0].id, "app:b")
})

test("relativeTime stays human", () => {
  assert.equal(Storage.relativeTime(NOW - 30 * 1000, NOW), "just now")
  assert.equal(Storage.relativeTime(NOW - 5 * 60 * 1000, NOW), "5m ago")
  assert.equal(Storage.relativeTime(NOW - 3 * 60 * 60 * 1000, NOW), "3h ago")
  assert.equal(Storage.relativeTime(NOW - DAY, NOW), "yesterday")
})

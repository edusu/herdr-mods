// Platform seam: verifies that the pick* functions return the correct
// program/args for each platform, and that the macOS path is byte-for-byte
// unchanged from the original call.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const loadShell = () =>
  import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(root, "mods/better-config/shell.js"), "utf8"))}`);

const MODS_DIR = "/a/b/mods";
const KEPT_DIR = "/x/y";

// --- psQuote ---

test("psQuote wraps in single quotes and doubles embedded single quotes", async () => {
  const { psQuote } = await loadShell();
  assert.equal(psQuote("C:\\Users\\a"), "'C:\\Users\\a'");
  assert.equal(psQuote("it's"), "'it''s'");
});

// --- pickListMods ---

const GOLDEN_LIST = { program: "/bin/sh", args: ["-c", 'cd "$1" && ls -d */ 2>/dev/null', "sh", MODS_DIR] };

test("pickListMods macOS is byte-for-byte the original sh call", async () => {
  const { pickListMods } = await loadShell();
  assert.deepEqual(pickListMods(MODS_DIR, "macos"), GOLDEN_LIST);
});

test("pickListMods linux falls back to the /bin/sh call", async () => {
  const { pickListMods } = await loadShell();
  const picked = pickListMods(MODS_DIR, "linux");
  assert.equal(picked.program, "/bin/sh");
  assert.deepEqual(picked.args, GOLDEN_LIST.args);
});

test("pickListMods windows uses powershell.exe with & { } wrapper", async () => {
  const { pickListMods, psQuote } = await loadShell();
  const picked = pickListMods(MODS_DIR, "windows");
  assert.equal(picked.program, "powershell.exe");
  assert.deepEqual(picked.args.slice(0, 3), ["-NoProfile", "-NoLogo", "-Command"]);
  const cmd = picked.args[3];
  assert.ok(cmd.startsWith("& { "), "starts with & { wrapper");
  assert.ok(cmd.includes("[Console]::OutputEncoding=[Text.Encoding]::UTF8"), "forces UTF8 output");
  assert.ok(cmd.includes("Get-ChildItem -LiteralPath $args[0] -Directory"), "lists directories only");
  assert.ok(cmd.includes("-ErrorAction SilentlyContinue"), "lenient on missing folder");
  assert.ok(cmd.includes("[char]10"), "one name per LF line");
  assert.ok(cmd.endsWith(psQuote(MODS_DIR)), "ends with quoted dir");
  const quoted = pickListMods("/a/b'c/mods", "windows");
  assert.ok(quoted.args[3].endsWith("'/a/b''c/mods'"), "embedded single quote doubled");
});

// --- pickMkdir ---

test("pickMkdir macOS is byte-for-byte the original mkdir call", async () => {
  const { pickMkdir } = await loadShell();
  assert.deepEqual(pickMkdir(KEPT_DIR, "macos"), { program: "mkdir", args: ["-p", KEPT_DIR] });
});

test("pickMkdir windows uses & { } wrapper with New-Item -Force", async () => {
  const { pickMkdir, psQuote } = await loadShell();
  const picked = pickMkdir(KEPT_DIR, "windows");
  assert.equal(picked.program, "powershell.exe");
  assert.deepEqual(picked.args.slice(0, 3), ["-NoProfile", "-NoLogo", "-Command"]);
  const cmd = picked.args[3];
  assert.ok(cmd.startsWith("& { "), "starts with & { wrapper");
  assert.ok(cmd.includes("New-Item -ItemType Directory -Force -Path $args[0]"), "creates folder, no error if present");
  assert.ok(cmd.includes("-ErrorAction SilentlyContinue"), "lenient on missing parent paths");
  assert.ok(cmd.endsWith(psQuote(KEPT_DIR)), "ends with quoted dir");
});

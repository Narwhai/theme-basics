import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

import { bundlePlugin, createHarness } from "./harness.mjs";

const result = await build({
  entryPoints: ["src/utils.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  write: false,
});
const output = result.outputFiles[0];
if (!output) throw new Error("No CSS color safety test bundle was produced.");
const module = { exports: {} };
// Deliberately model CSS.supports accepting malformed values at EOF; the safety
// guard, rather than the browser's permissive parser, must reject those values.
runInNewContext(output.text, { module, exports: module.exports, CSS: { supports: () => true } });
const { hasClosedCssTokens, isValidCssColor, sanitizeCssValue } = module.exports;

const multiPassExploit = String.raw`red \;/* \;/* ; color:red; } body { display:none; /* */`;
const unterminated = [
  "red/*",
  "rgb(1, /* ) */ 2, /* unfinished",
  "var(--x, red",
  "var(--x, (red)",
  "var(--x, [red",
  'var(--x, "red',
  "var(--x, 'red",
  "var(--x, red\\)",
  "red\\",
  "var(--x, ([red)])",
];
const valid = [
  "#abc", "#12345680", "rgba(1, 2, 3, .5)", "oklch(60% 0.2 30 / .5)",
  "red /* closed */", "rgb(1, /* ) */ 2, 3)", 'var(--x, "/*")',
  "var(--x, '/*')", "var(--x, [value])", "var(--x, var(--y, red))",
  'var(--x, "quoted \\" text")',
];

test("unterminated CSS tokens are rejected even if CSS.supports accepts them", () => {
  for (const color of unterminated) assert.equal(isValidCssColor(color), false, color);
});

test("safe colors, closed comments, escapes and context-dependent values remain valid", () => {
  for (const color of valid) assert.equal(isValidCssColor(color), true, color);
});

test("CSS comments preserve punctuation without weakening outside-token or blocked-pattern checks", () => {
  const comments = [
    "red /*;*/",
    "red /* *;/ ' */",
    "red /* \n  {; } \t */",
    "rgba(1, /* ;{} */ 2, 3, .5)",
  ];
  for (const value of comments) {
    assert.equal(isValidCssColor(value), true, value);
    assert.equal(sanitizeCssValue(value), value, value);
  }

  for (const value of ["red; background: blue", "red } body {", 'var(--x, "/*;*/")', "red\\/*;*/"]) {
    assert.equal(isValidCssColor(value), false, value);
    assert.doesNotMatch(sanitizeCssValue(value), /[;{}]/, value);
  }
  assert.equal(isValidCssColor("red /* unclosed;"), false);
  for (const value of [
    "red /* u;rl( */", "red /* expre;ssion( */", "var(--x, url(https://example.test))",
    "var(--x, expression(alert(1)))", "@import red", "behavior: red", "\\000072ed",
  ]) {
    assert.equal(isValidCssColor(value), false, value);
    assert.equal(sanitizeCssValue(value), "", value);
  }
});

test("sanitization is fail-closed and idempotent when escapes meet comments", () => {
  const attacks = [
    multiPassExploit,
    String.raw`red \;/* ; color:red; } body { display:none; /* */`,
    String.raw`red \;/* \;/* ; u;rl(https://evil.test); } body { display:none; /* */`,
    String.raw`red \;/* \;/* ; expre;ssion(alert(1)); } body { display:none; /* */`,
  ];
  for (const value of attacks) {
    assert.equal(isValidCssColor(value), false, value);
    const sanitized = sanitizeCssValue(value);
    assert.equal(sanitized, "", value);
    assert.equal(sanitizeCssValue(sanitized), sanitized, value);
  }
  for (const value of ["red /*;*/", "red /* *;/ ' */", "oklch(60%  0.2 30)", "red/*", "  rgba(1, 2, 3, .5)  "]) {
    const sanitized = sanitizeCssValue(value);
    assert.equal(sanitizeCssValue(sanitized), sanitized, value);
  }

  // A deterministic adversarial corpus exercises escapes, quotes, comments,
  // whitespace, punctuation and brackets in different orders.
  let seed = 4831;
  const alphabet = "redu()[];{}/*\\\"' \n";
  for (let sample = 0; sample < 10000; sample++) {
    let input = "";
    for (let index = 0; index < 24; index++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      input += alphabet.charAt(seed % alphabet.length);
    }
    const sanitized = sanitizeCssValue(input);
    assert.equal(sanitizeCssValue(sanitized), sanitized, input);
  }
});

test("legacy import and repeated sanitization cannot inject declarations or rules", async () => {
  const harness = createHarness(await bundlePlugin());
  const plugin = new harness.Plugin({ isDarkMode: () => false, vault: { configDir: ".test-config" } });
  plugin.settings = structuredClone(harness.DEFAULT_SETTINGS);
  plugin.saveData = async () => {};
  await plugin.importSettings(JSON.stringify({ tagColor: multiPassExploit }));
  assert.equal(plugin.settings.profiles.light.tagColor, "");
  assert.equal(plugin.settings.profiles.dark.tagColor, "");
  let snippet = plugin.styleManager.generateSnippetCss();
  assert.ok(!snippet.includes("display:none"));
  assert.ok(!snippet.includes("color:red;"));

  // Existing on-disk legacy settings must not be mutated by CSS rendering either.
  plugin.settings.profiles.light.tagColor = multiPassExploit;
  const before = structuredClone(plugin.settings);
  const properties = plugin.styleManager.buildCssPropertiesForMode("light");
  assert.equal(properties["--tag-color"], undefined);
  snippet = plugin.styleManager.generateSnippetCss();
  assert.ok(!snippet.includes("display:none"));
  assert.deepEqual(plugin.settings, before);
  assert.equal(hasClosedCssTokens(sanitizeCssValue(multiPassExploit)), true);
});

test("comment punctuation survives palette assignment and CSS property/snippet generation", async () => {
  const harness = createHarness(await bundlePlugin());
  const plugin = new harness.Plugin({ isDarkMode: () => false, vault: { configDir: ".test-config" } });
  plugin.settings = structuredClone(harness.DEFAULT_SETTINGS);
  plugin.saveData = async () => {};

  const previousCss = global.CSS;
  global.CSS = { supports: () => true };
  try {
    for (const color of ["red /*;*/", "red /* *;/ ' */", "rgba(1, /* ;{} */ 2, 3, .5)"]) {
      await plugin.setPaletteColor("light", 0, color);
      await plugin.setColorAssignment("light", "h1Color", 0);
      assert.equal(plugin.settings.palettes.light[0], color);
      assert.equal(plugin.styleManager.buildCssPropertiesForMode("light")["--h1-color"], color);
      const snippet = plugin.styleManager.generateSnippetCss();
      assert.ok(snippet.includes(`--h1-color: ${color};`), color);
    }
  } finally {
    if (previousCss === undefined) delete global.CSS;
    else global.CSS = previousCss;
  }
});

test("CSV and JSON imports preserve safe punctuation inside CSS comments", async () => {
  const harness = createHarness(await bundlePlugin());
  const plugin = new harness.Plugin({ isDarkMode: () => false, vault: { configDir: ".test-config" } });
  plugin.settings = structuredClone(harness.DEFAULT_SETTINGS);
  plugin.saveData = async () => {};

  const previousCss = global.CSS;
  global.CSS = { supports: () => true };
  try {
    const colors = ["red /*;*/", "red /* *;/ ' */", "rgba(1, /* ;{} */ 2, 3, .5)"];
    for (const [format, input] of [["json", JSON.stringify(colors)], ["csv", colors.join(", ")]]) {
      await plugin.importPaletteColors("light", input, format, "replace");
      assert.deepEqual(plugin.settings.palettes.light.slice(0, colors.length), colors);
      for (let index = 0; index < colors.length; index++) {
        await plugin.setColorAssignment("light", "h1Color", index);
        assert.equal(plugin.styleManager.buildCssPropertiesForMode("light")["--h1-color"], colors[index]);
        assert.ok(plugin.styleManager.generateSnippetCss().includes(`--h1-color: ${colors[index]};`));
      }
    }
  } finally {
    if (previousCss === undefined) delete global.CSS;
    else global.CSS = previousCss;
  }
});

test("all palette input paths reject unsafe colors atomically", async () => {
  const harness = createHarness(await bundlePlugin());
  const plugin = new harness.Plugin({ isDarkMode: () => false, vault: { configDir: ".test-config" } });
  plugin.settings = structuredClone(harness.DEFAULT_SETTINGS);
  const original = structuredClone(plugin.settings);
  const writes = [];
  plugin.saveData = async (settings) => { writes.push(structuredClone(settings)); };

  const previousCss = global.CSS;
  global.CSS = { supports: () => true };
  try {
    for (const color of unterminated) {
      await assert.rejects(plugin.setPaletteColor("light", 0, color), /invalid/i, color);
      await assert.rejects(plugin.commitCustomColor("light", "tagBorderColor", color), /invalid/i, color);
      await assert.rejects(plugin.importPaletteColors("light", JSON.stringify(["#abcdef", color]), "json", "replace"), undefined, color);
      const incoming = structuredClone(original);
      incoming.palettes.light[0] = color;
      await assert.rejects(plugin.importSettings(JSON.stringify(incoming)), /invalid|valid colors/i, color);
      assert.deepEqual(plugin.settings, original, color);
      assert.equal(writes.length, 0, color);
    }
    const unsafeSaved = structuredClone(original);
    unsafeSaved.palettes.light[0] = "red/*";
    plugin.loadData = async () => unsafeSaved;
    await assert.rejects(plugin.loadSettings(), /valid colors/i);
    assert.deepEqual(plugin.settings, original);
    assert.equal(writes.length, 0);
    await plugin.setPaletteColor("light", 0, valid[5]);
    assert.equal(plugin.settings.palettes.light[0], valid[5]);
    const incoming = structuredClone(plugin.settings);
    incoming.palettes.dark[0] = valid[3];
    await plugin.importSettings(JSON.stringify(incoming));
    assert.equal(plugin.settings.palettes.dark[0], valid[3]);
  } finally {
    if (previousCss === undefined) delete global.CSS;
    else global.CSS = previousCss;
  }
});

test("snippet export rejects unbalanced legacy values without changing settings or writing a file", async () => {
  const harness = createHarness(await bundlePlugin());
  const fileActions = [];
  const plugin = new harness.Plugin({
    isDarkMode: () => false,
    vault: { configDir: ".test-config", adapter: {
      mkdir: async (...args) => { fileActions.push(["mkdir", ...args]); },
      write: async (...args) => { fileActions.push(["write", ...args]); },
    } },
  });
  plugin.settings = structuredClone(harness.DEFAULT_SETTINGS);
  plugin.saveData = async () => {};

  for (const [mode, key, prop, color] of [
    ["light", "tagColor", "--tag-color", "red/*"],
    ["dark", "h1Color", "--h1-color", 'var(--x, "red'],
    ["light", "h1Color", "--h1-color", "var(--x, [red"],
  ]) {
    const incoming = structuredClone(harness.DEFAULT_SETTINGS);
    incoming.profiles[mode][key] = color;
    await plugin.importSettings(JSON.stringify(incoming));
    const before = structuredClone(plugin.settings);
    const message = new RegExp(`${mode} profile: ${prop}.*unbalanced`, "i");
    assert.throws(() => plugin.styleManager.generateSnippetCss(), message, color);
    try {
      await plugin.exportCssSnippet();
    } catch (error) {
      assert.match(String(error), message, color);
    }
    assert.deepEqual(fileActions, [], color);
    assert.deepEqual(plugin.settings, before, color);
    assert.equal(plugin.settings.profiles[mode][key], color);
  }
});

test("valid legacy expressions remain stored and export with their CSS text intact", async () => {
  const harness = createHarness(await bundlePlugin());
  const plugin = new harness.Plugin({ isDarkMode: () => false, vault: { configDir: ".test-config" } });
  plugin.settings = structuredClone(harness.DEFAULT_SETTINGS);
  plugin.saveData = async () => {};
  const incoming = structuredClone(harness.DEFAULT_SETTINGS);
  incoming.profiles.light.tagColor = "rgb(1, /* ) */ 2, 3)";
  incoming.profiles.dark.h1Color = 'var(--accent, "/*")';
  incoming.profiles.dark.h2Color = "oklch(60% 0.2 30 / 0.5)";
  await plugin.importSettings(JSON.stringify(incoming));
  const before = structuredClone(plugin.settings);
  const snippet = plugin.styleManager.generateSnippetCss();
  assert.match(snippet, /--tag-color: rgb\(1, \/\* \) \*\/ 2, 3\);/);
  assert.ok(snippet.includes('--h1-color: var(--accent, "/*");'));
  assert.ok(snippet.includes("--h2-color: oklch(60% 0.2 30 / 0.5);"));
  assert.deepEqual(plugin.settings, before);
});

const vault = process.env.OBSIDIAN_TEST_VAULT;
test("real Obsidian CSS parser recovers at EOF, but validation protects following declarations", { skip: !vault }, () => {
  const unsafe = ["red/*", "var(--x, red", 'var(--x, "red', "var(--x, [red"];
  const safe = ["red /* closed */", "red /*;*/", "red /* *;/ ' */", "rgba(1, /* ;{} */ 2, 3, .5)",
    "rgb(1, /* ) */ 2, 3)", 'var(--x, "/*")', "oklch(60% 0.2 30 / .5)"];
  const code = `JSON.stringify((() => {
    const module = { exports: {} };
    new Function("module", "exports", ${JSON.stringify(output.text)})(module, module.exports);
    const unsafe = ${JSON.stringify(unsafe)};
    const safe = ${JSON.stringify(safe)};
    const check = (value) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("body { --first: " + value + "; --marker: blue; }");
      return { value, supports: CSS.supports("color", value), accepted: module.exports.isValidCssColor(value),
        marker: sheet.cssRules[0]?.style.getPropertyValue("--marker") };
    };
    return { unsafe: unsafe.map(check), safe: safe.map(check) };
  })())`;
  const response = execFileSync("obsidian", [`vault=${vault}`, "eval", `code=${code}`], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  }).trim();
  if (!response.startsWith("=> ")) throw new Error(`Obsidian renderer checks failed: ${response}`);
  const observations = JSON.parse(response.slice(3));
  for (const entry of observations.unsafe) {
    assert.equal(entry.supports, true, entry.value);
    assert.equal(entry.accepted, false, entry.value);
    assert.equal(entry.marker, "", entry.value);
  }
  for (const entry of observations.safe) {
    assert.equal(entry.supports, true, entry.value);
    assert.equal(entry.accepted, true, entry.value);
    assert.equal(entry.marker, "blue", entry.value);
  }
});

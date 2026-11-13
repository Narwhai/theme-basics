import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { bundlePlugin, createHarness } from "./harness.mjs";

const vault = process.env.OBSIDIAN_TEST_VAULT;
if (!vault) throw new Error("Set OBSIDIAN_TEST_VAULT to the name of an open Obsidian vault.");

function rendererChecks(harness) {
  const { StyleManager, DEFAULT_PROFILE, BODY_CLASS, flush } = harness;
  const fixtures = [];
  const fixture = () => {
    const root = activeDocument.body.createDiv({ cls: "theme-basics-offscreen" });
    const profiles = { light: { ...DEFAULT_PROFILE }, dark: { ...DEFAULT_PROFILE } };
    const manager = new StyleManager({
      app: { workspace: { containerEl: { ownerDocument: { body: root } } } },
      getProfile: (mode) => profiles[mode],
      getResolvedProfile: (mode) => profiles[mode],
      getAppliedProfileMode: () => "light",
    });
    fixtures.push({ root, manager });
    return { root, manager, profiles };
  };
  try {
    const { manager, profiles, root } = fixture();
    const colors = Object.fromEntries([
      "#123456", "#abc", "rgba(255, 0, 0, 0.2)", "rgb(100% 0% 50%)", "rebeccapurple",
      "oklch(60% 0.2 30)", "oklab(0.6 0.1 0.1)", "color(srgb 0.1 0.2 0.3)",
      "color(display-p3 1 0 0)", "color-mix(in oklch, red 10%, transparent)",
      "color(srgb 0.1 0.2 0.3 / 0.1)", "not-a-color", "255, 0, 0",
    ].map((color) => [color, manager.tryToPickerHex(color)]));
    const matches = {
      opaque: manager.colorsMatch("#ff0000", "rgb(255 0 0)"),
      alpha: manager.colorsMatch("rgba(255, 0, 0, 0.5)", "rgb(255 0 0 / 50%)"),
      alphaDifferent: manager.colorsMatch("rgba(255, 0, 0, 0.5)", "rgb(255 0 0 / 50.01%)"),
      hexAlphaDifferent: manager.colorsMatch("#ff000080", "rgba(255, 0, 0, 0.5)"),
      distinctVariables: manager.colorsMatch("var(--first)", "var(--second)"),
      sameVariable: manager.colorsMatch("var(--first)", "var(--first)"),
      mixedCommaSpacing: manager.colorsMatch("color-mix(in srgb, red, blue)", "color-mix(in srgb,red,blue)"),
      mixedSameContext: manager.colorsMatch("color-mix(in srgb, var(--first), blue)", "color-mix(in srgb,var(--first),blue)"),
      mixedDifferentContext: manager.colorsMatch("color-mix(in srgb, var(--first), blue)", "color-mix(in srgb,var(--second),blue)"),
      mixedDifferentAlpha: manager.colorsMatch("color-mix(in srgb, rgb(1 2 3 / 0.5), blue)", "color-mix(in srgb,rgb(1 2 3 / 0.5001),blue)"),
    };
    profiles.light.linkColor = "oklch(60% 0.2 30)";
    profiles.light.tagBackground = "color-mix(in oklch, red 10%, transparent)";
    const properties = manager.buildCssPropertiesForMode("light");
    const hover = manager.resolveColor(properties["--tag-background-hover"]);
    const snippet = manager.generateSnippetCss();
    root.setCssProps({ "--theme-basics-test-color": "#112233" });
    const firstVariable = manager.tryToPickerHex("var(--theme-basics-test-color)");
    root.setCssProps({ "--theme-basics-test-color": "#445566" });
    manager.applyStyles();
    flush();
    const secondVariable = manager.tryToPickerHex("var(--theme-basics-test-color)");

    const owned = fixture();
    owned.root.setCssProps({ "--h1-color": "#123456", "--unrelated": "preserved" });
    owned.manager.applyStyles();
    flush();
    const afterEmpty = owned.root.style.getPropertyValue("--h1-color");
    owned.profiles.light.h1Color = "#abcdef";
    owned.manager.applyStyles();
    flush();
    const afterOverride = owned.root.style.getPropertyValue("--h1-color");
    owned.manager.refreshThemeDefaults();
    const afterRefresh = owned.root.style.getPropertyValue("--h1-color");
    owned.profiles.light.h1Color = "";
    owned.manager.applyStyles();
    flush();
    const afterReset = owned.root.style.getPropertyValue("--h1-color");
    owned.profiles.light.h1Color = "#abcdef";
    owned.manager.applyStyles();
    flush();
    owned.manager.cleanup();
    const afterCleanup = owned.root.style.getPropertyValue("--h1-color");

    const foreign = fixture();
    foreign.profiles.light.h1Color = "#abcdef";
    foreign.manager.applyStyles();
    flush();
    foreign.root.setCssProps({ "--h1-color": "#fedcba" });
    foreign.manager.cleanup();

    const interactive = fixture();
    interactive.root.setCssProps({ "--interactive-normal": "#112233" });
    const interactiveButton = interactive.root.createEl("button", { cls: "theme-basics-color-select", text: "Color 1" });
    const interactiveBefore = getComputedStyle(interactiveButton).backgroundColor;
    interactive.profiles.light.interactiveBackground = "#abcdef";
    interactive.manager.applyStyles();
    flush();
    const interactiveApplied = getComputedStyle(interactiveButton).backgroundColor;
    interactive.profiles.light.interactiveBackground = "";
    interactive.manager.applyStyles();
    flush();
    const interactiveReset = getComputedStyle(interactiveButton).backgroundColor;

    const formField = fixture();
    formField.root.setCssProps({
      "--background-modifier-form-field": "#112233",
      "--background-modifier-form-field-hover": "#aabbcc",
      "--interactive-normal": "#445566",
      "--text-normal": "#778899",
      "--background-modifier-border": "#99aabb",
    });
    const searchInput = formField.root.createDiv({ cls: "search-input-container" }).createEl("input", { type: "search" });
    const textInput = formField.root.createEl("input", { type: "text" });
    const formButton = formField.root.createEl("button", { text: "Color 1" });
    const formValues = () => ({
      search: getComputedStyle(searchInput).backgroundColor,
      text: getComputedStyle(textInput).backgroundColor,
      button: getComputedStyle(formButton).backgroundColor,
      color: getComputedStyle(textInput).color,
      border: getComputedStyle(textInput).borderColor,
      hover: getComputedStyle(textInput).getPropertyValue("--background-modifier-form-field-hover").trim(),
    });
    const formBefore = formValues();
    formField.profiles.light.formFieldBackground = "#abcdef";
    formField.manager.applyStyles();
    flush();
    const formApplied = formValues();
    formField.profiles.light.formFieldBackground = "";
    formField.manager.applyStyles();
    flush();
    const formReset = formValues();

    const failure = fixture();
    failure.profiles.light.h1Color = "#abcdef";
    failure.manager.applyStyles();
    flush();
    failure.manager.captureThemeDefaultsForMode = () => { throw new Error("Probe failed"); };
    let captureFailed = false;
    try { failure.manager.refreshThemeDefaults(); } catch { captureFailed = true; }

    return {
      colors, matches, properties, hover, snippet, firstVariable, secondVariable,
      interactive: { before: interactiveBefore, applied: interactiveApplied, reset: interactiveReset },
      formField: { before: formBefore, applied: formApplied, reset: formReset },
      ownership: { afterEmpty, afterOverride, afterRefresh, afterReset, afterCleanup,
        unrelated: owned.root.style.getPropertyValue("--unrelated"),
        classRemoved: !owned.root.classList.contains(BODY_CLASS),
        newerValue: foreign.root.style.getPropertyValue("--h1-color"),
      },
      failure: { captureFailed, color: failure.root.style.getPropertyValue("--h1-color"),
        classRestored: failure.root.classList.contains(BODY_CLASS) },
    };
  } finally {
    for (const { root, manager } of fixtures) {
      manager.cleanup();
      root.remove();
    }
  }
}

const bundle = await bundlePlugin();
const code = `JSON.stringify((${rendererChecks.toString()})((${createHarness.toString()})(${JSON.stringify(bundle)})))`;
const output = execFileSync("obsidian", [`vault=${vault}`, "eval", `code=${code}`], {
  encoding: "utf8",
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
}).trim();
if (!output.startsWith("=> ")) throw new Error(`Obsidian renderer checks failed: ${output}`);
const result = JSON.parse(output.slice(3));

for (const [color, hex] of [
  ["#123456", "#123456"], ["#abc", "#aabbcc"], ["rgba(255, 0, 0, 0.2)", "#ff0000"],
  ["rgb(100% 0% 50%)", "#ff0080"], ["rebeccapurple", "#663399"],
  ["oklch(60% 0.2 30)", "#de3e2d"], ["oklab(0.6 0.1 0.1)", "#c3602e"],
  ["color(srgb 0.1 0.2 0.3)", "#1a334d"], ["color(display-p3 1 0 0)", "#ff0000"],
  ["color-mix(in oklch, red 10%, transparent)", "#ff0000"],
  ["color(srgb 0.1 0.2 0.3 / 0.1)", "#1a334d"],
  ["not-a-color", null], ["255, 0, 0", null],
]) {
  test(`picker resolves ${color}`, () => assert.equal(result.colors[color], hex));
}

test("matching equivalent CSS colors preserves authored alpha and context", () => {
  assert.deepEqual(result.matches, {
    opaque: true, alpha: true, alphaDifferent: false, hexAlphaDifferent: false,
    distinctVariables: false, sameVariable: true,
    mixedCommaSpacing: true, mixedSameContext: true, mixedDifferentContext: false, mixedDifferentAlpha: false,
  });
});

test("modern colors remain intact in overrides and snippet exports", () => {
  assert.equal(result.properties["--link-color"], "oklch(60% 0.2 30)");
  assert.ok(result.properties["--link-color-hover"]);
  assert.match(result.snippet, /--link-color: oklch\(60% 0.2 30\);/);
});

test("automatically generated tag hover colors retain transparency", () => {
  assert.equal(result.hover.a, 0.1);
});

test("color caches invalidate after profile/style changes", () => {
  assert.equal(result.firstVariable, "#112233");
  assert.equal(result.secondVariable, "#445566");
});

test("only owned inline properties are changed, then restored on reset/unload", () => {
  assert.deepEqual(result.ownership, {
    afterEmpty: "#123456", afterOverride: "#abcdef", afterRefresh: "#abcdef",
    afterReset: "#123456", afterCleanup: "#123456", unrelated: "preserved",
    classRemoved: true, newerValue: "#fedcba",
  });
});

test("interactive background applies to selector buttons and restores the inherited value", () => {
  assert.deepEqual(result.interactive, {
    before: "rgb(17, 34, 51)", applied: "rgb(171, 205, 239)", reset: "rgb(17, 34, 51)",
  });
});

test("form field background updates search and text inputs without changing other controls", () => {
  const before = result.formField.before;
  assert.equal(before.search, "rgb(17, 34, 51)");
  assert.equal(before.text, "rgb(17, 34, 51)");
  assert.deepEqual(result.formField.applied, { ...before, search: "rgb(171, 205, 239)", text: "rgb(171, 205, 239)" });
  assert.deepEqual(result.formField.reset, before);
  assert.equal(before.button, "rgb(68, 85, 102)");
  assert.equal(before.color, "rgb(119, 136, 153)");
  assert.equal(before.hover, "#aabbcc");
});

test("failed theme probes restore applied overrides and plugin classes", () => {
  assert.deepEqual(result.failure, { captureFailed: true, color: "#abcdef", classRestored: true });
});

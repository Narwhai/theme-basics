import assert from "node:assert/strict";
import test from "node:test";

import { bundlePlugin, createHarness } from "./harness.mjs";

const bundle = await bundlePlugin();

function fixture() {
  const harness = createHarness(bundle);
  const plugin = new harness.Plugin({ isDarkMode: () => false, vault: { configDir: ".test-config" } });
  plugin.settings = structuredClone(harness.DEFAULT_SETTINGS);
  const writes = [];
  plugin.saveData = async (settings) => { writes.push(structuredClone(settings)); };
  return { ...harness, plugin, writes };
}

function paletteRow(picker, button) {
  const text = {
    inputEl: { addClass() {}, setAttribute() {} },
    setPlaceholder() { return this; }, setValue(value) { this.value = value; return this; },
    onChange(callback) { this.change = callback; return this; },
  };
  const swatch = { setAttribute() {}, addClass() {}, removeClass() {}, setCssProps(props) { this.props = props; } };
  return {
    text, swatch,
    controlEl: { createSpan() { return swatch; }, querySelector() { return { setAttribute() {} }; }, toggleClass() {} },
    setDesc(value) { this.desc = value; return this; },
    addText(configure) { configure(text); return this; },
    addColorPicker(configure) { configure(picker); return this; },
    addButton(configure) { if (button) configure(button); return this; },
  };
}

function h1ColorDef(definitions) {
  const page = definitions.find((item) => item.type === "page" && item.name === "Headings");
  assert.ok(page);
  const group = page.items.find((item) => item.heading === "H1");
  assert.ok(group);
  const def = group.items.find((item) => item.desc?.includes("Text color for H1 headings."));
  assert.ok(def);
  return def;
}

function paletteGroup(definitions) {
  const page = definitions.find((item) => item.name === "Color palette");
  assert.equal(page?.type, "page");
  const group = page.items.find((item) => item.heading === "Colors");
  assert.ok(group);
  return group;
}

test("blocked CSS values are rejected on every call, not every other call", () => {
  const { sanitizeCssValue } = fixture();
  for (const value of ["url(https://example.com)", "expression(alert(1))", "@import 'x'", "behavior: x", "\\0075rl(x)"]) {
    for (let i = 0; i < 4; i++) assert.equal(sanitizeCssValue(value), "");
  }
  assert.equal(sanitizeCssValue(" oklch(60%  0.2 30) "), "oklch(60% 0.2 30)");
});

test("invalid imports leave both profiles and persisted settings untouched", async () => {
  const { plugin, writes } = fixture();
  plugin.settings.profiles.light.textNormal = "#123456";
  const original = structuredClone(plugin.settings);
  const invalid = [
    null, {}, [], "text", { unrelated: "value" },
    { version: 99, uiProfile: "light", profiles: { light: {}, dark: {} } },
    { version: 2, uiProfile: "light", profiles: { light: {} } },
    { version: 2, uiProfile: "dark", profiles: { light: null, dark: {} } },
    { version: 2, uiProfile: "dark", profiles: { light: { unknown: "red" }, dark: {} } },
    { version: 2, uiProfile: "other", profiles: { light: {}, dark: {} } },
    { version: 2, uiProfile: "light", profiles: { light: { textNormal: 42 }, dark: {} } },
    { textNormal: 42 },
  ];
  for (const value of invalid) {
    await assert.rejects(plugin.importSettings(JSON.stringify(value)));
    assert.deepEqual(plugin.settings, original);
    assert.equal(writes.length, 0);
  }
  await assert.rejects(plugin.importSettings("{broken JSON"));
  assert.deepEqual(plugin.settings, original);
});

test("valid imports preserve CSS colors and refresh hidden declarative definitions", async () => {
  const { plugin, SettingsTab, DEFAULT_SETTINGS, writes } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.settingsTab = tab;
  tab.update();
  assert.equal(tab.settingItems[2].name, "Reset Light profile");
  const incoming = structuredClone(DEFAULT_SETTINGS);
  incoming.uiProfile = "dark";
  incoming.profiles.dark.linkColor = "oklch(60% 0.2 30)";
  incoming.profiles.light.highlightBackground = "rgb(20 30 40 / 0.25)";
  await plugin.importSettings(JSON.stringify(incoming));
  assert.deepEqual(plugin.settings, incoming);
  assert.deepEqual(writes, [incoming]);
  assert.equal(tab.settingItems[2].name, "Reset Dark profile");
});

test("legacy single-profile JSON still imports into both modes", async () => {
  const { plugin } = fixture();
  await plugin.importSettings(JSON.stringify({ textNormal: "#abcdef", tagColor: "url(x)" }));
  assert.equal(plugin.getProfile("light").textNormal, "#abcdef");
  assert.equal(plugin.getProfile("dark").textNormal, "#abcdef");
  assert.equal(plugin.getProfile("light").tagColor, "");
  assert.equal(plugin.getProfile("dark").tagColor, "");
});

test("a failed import write does not replace in-memory settings", async () => {
  const { plugin } = fixture();
  const original = structuredClone(plugin.settings);
  plugin.saveData = () => Promise.reject(new Error("Disk full"));
  await assert.rejects(plugin.importSettings('{"textNormal":"red"}'), /Disk full/);
  assert.deepEqual(plugin.settings, original);
});

test("the last profile selection wins while earlier saves are pending", async () => {
  const { plugin, SettingsTab } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  const completions = [];
  plugin.saveData = () => new Promise((resolve) => { completions.push(resolve); });
  const dropdown = {
    addOption() { return this; },
    setValue() { return this; },
    setDisabled() { return this; },
    onChange(callback) { this.change = callback; return this; },
  };
  const row = tab.getSettingDefinitions()[0];
  row.render({ addDropdown: (configure) => configure(dropdown) });
  const dark = dropdown.change("dark");
  const light = dropdown.change("light");
  assert.equal(plugin.getEditedProfileMode(), "light");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completions.length, 1, "only one settings write may be active");
  completions[0]();
  await dark;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completions.length, 2);
  assert.equal(plugin.getEditedProfileMode(), "dark");
  completions[1]();
  await light;
  assert.equal(plugin.getEditedProfileMode(), "light");
});

test("a pending profile switch keeps the visible dropdown aligned with editable rows", async () => {
  const { plugin, SettingsTab } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.settingsTab = tab;
  const gate = Promise.withResolvers();
  plugin.saveData = () => gate.promise;
  const makeDropdown = () => ({
    value: "", disabled: false,
    addOption() { return this; },
    setValue(value) { this.value = value; this.change?.(value); return this; },
    setDisabled(value) { this.disabled = value; return this; },
    onChange(callback) { this.change = callback; return this; },
  });
  const dropdown = makeDropdown();
  tab.getSettingDefinitions()[0].render({ addDropdown: (configure) => configure(dropdown) });
  dropdown.value = "dark";
  const switching = dropdown.change("dark");
  assert.equal(dropdown.value, "light");
  assert.equal(dropdown.disabled, true);
  assert.equal(plugin.getEditedProfileMode(), "light");

  // A rebuild while saving still shows the committed mode and keeps switching disabled.
  const rebuilt = makeDropdown();
  tab.getSettingDefinitions()[0].render({ addDropdown: (configure) => configure(rebuilt) });
  assert.equal(rebuilt.value, "light");
  assert.equal(rebuilt.disabled, true);
  const edit = plugin.setColorAssignment("light", "tagBorderColor", 0);
  gate.resolve();
  await Promise.all([switching, edit]);
  assert.equal(plugin.getEditedProfileMode(), "dark");
  assert.equal(plugin.settings.colorAssignments.light.tagBorderColor, 0);
  assert.equal(plugin.settings.colorAssignments.dark.tagBorderColor, undefined);
  const committed = makeDropdown();
  tab.getSettingDefinitions()[0].render({ addDropdown: (configure) => configure(committed) });
  assert.equal(committed.value, "dark");
  assert.equal(committed.disabled, false);
});

test("old declarative controls cannot mutate settings after definitions rebuild", async () => {
  const { plugin, SettingsTab, writes } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  const dropdown = {
    addOption() { return this; },
    setValue() { return this; },
    setDisabled() { return this; },
    onChange(callback) { this.change = callback; return this; },
  };
  tab.getSettingDefinitions()[0].render({ addDropdown: (configure) => configure(dropdown) });
  tab.update();
  await dropdown.change("dark");
  assert.equal(plugin.getEditedProfileMode(), "light");
  assert.equal(writes.length, 0);
});

test("pending saves and layout initialization cannot revive an unloaded manager", async () => {
  const { plugin, flush } = fixture();
  const pending = Promise.withResolvers();
  plugin.saveData = () => pending.promise;
  const save = plugin.saveSettings();
  plugin.styleManager.cleanup();
  pending.resolve();
  await save;
  plugin.styleManager.refreshThemeDefaults();
  flush(); // An attempted DOM access here would throw: the fixture has no workspace.
  assert.equal(plugin.styleManager.appliedBody, null);
  assert.equal(plugin.styleManager.colorProbe, null);
});

test("Base16 imports accept quoted hex prefixes but not truncated values or unrelated keys", async () => {
  const { plugin, writes } = fixture();
  const invalid = ['baseFF: "ffffff"', 'base00: "1234567"', 'base00: "123456', 'base00: #123456'];
  for (const yaml of invalid) {
    assert.deepEqual(await plugin.applyBase16Theme(yaml, "light"), { success: false, count: 0 });
  }
  assert.equal(writes.length, 0);
  const valid = `palette:
    base00: "#ABCDEF"
    base01: '123456' # secondary
    base0A: fedcba
    base0D: "0000FF"`;
  assert.deepEqual(await plugin.applyBase16Theme(valid, "light"), { success: true, count: 4 });
  assert.equal(plugin.settings.palettes.light[0], "#abcdef");
  assert.equal(plugin.settings.palettes.light[1], "#123456");
  assert.equal(plugin.settings.palettes.light[10], "#fedcba");
  assert.equal(plugin.settings.palettes.light[13], "#0000ff");
  assert.equal(plugin.getProfile("light").backgroundPrimary, "");
  assert.equal(plugin.getProfile("light").highlightBackground, "");
  assert.equal(plugin.settings.palettes.dark[0], "");
});

test("version 2 migration preserves independent legacy colors and empty palettes", async () => {
  const { plugin } = fixture();
  const old = { version: 2, uiProfile: "dark", profiles: {
    light: { h1Color: "  oklch(60%  0.2 30) ", highlightBackground: "rgb(20 30 40 / 0.25)" },
    dark: { h1Color: "rgba(1, 2, 3, 0.3)" },
  } };
  await plugin.importSettings(JSON.stringify(old));
  assert.equal(plugin.settings.version, 4);
  assert.equal(plugin.getProfile("light").h1Color, old.profiles.light.h1Color);
  assert.equal(plugin.getResolvedProfile("light").highlightBackground, old.profiles.light.highlightBackground);
  assert.equal(plugin.getResolvedProfile("dark").h1Color, old.profiles.dark.h1Color);
  assert.deepEqual(plugin.settings.palettes.light, Array(16).fill(""));
  assert.deepEqual(plugin.settings.colorAssignments.light, {});
});

test("interactive background inherits for older profiles and round-trips independently in both modes", async () => {
  const { plugin, DEFAULT_SETTINGS } = fixture();
  const old = structuredClone(DEFAULT_SETTINGS);
  delete old.profiles.light.interactiveBackground;
  delete old.profiles.dark.interactiveBackground;
  old.profiles.light.textNormal = "#123456";
  const loadedPlugin = fixture().plugin;
  loadedPlugin.loadData = async () => old;
  await loadedPlugin.loadSettings();
  assert.equal(loadedPlugin.getProfile("light").interactiveBackground, "");
  assert.equal(loadedPlugin.getProfile("dark").interactiveBackground, "");
  await plugin.importSettings(JSON.stringify({ version: 2, uiProfile: "light", profiles: {
    light: { textNormal: "#123456" }, dark: {},
  } }));
  assert.equal(plugin.getProfile("light").interactiveBackground, "");
  assert.equal(plugin.getProfile("dark").interactiveBackground, "");
  await plugin.importSettings(JSON.stringify(old));
  for (const mode of ["light", "dark"]) {
    assert.equal(plugin.getProfile(mode).interactiveBackground, "");
    assert.equal(plugin.styleManager.buildCssPropertiesForMode(mode)["--interactive-normal"], undefined);
  }
  assert.equal(plugin.getProfile("light").textNormal, "#123456");

  await plugin.setPaletteColor("light", 9, "#abcdef");
  await plugin.setColorAssignment("light", "interactiveBackground", 9);
  await plugin.setProfileValue("dark", "interactiveBackground", "#112233");
  assert.equal(plugin.styleManager.buildCssPropertiesForMode("light")["--interactive-normal"], "#abcdef");
  assert.equal(plugin.styleManager.buildCssPropertiesForMode("dark")["--interactive-normal"], "#112233");
  const snippet = plugin.styleManager.generateSnippetCss();
  assert.match(snippet, /body\.theme-light\s*\{[^}]*--interactive-normal: #abcdef;/);
  assert.match(snippet, /body\.theme-dark\s*\{[^}]*--interactive-normal: #112233;/);
  const imported = fixture().plugin;
  await imported.importSettings(JSON.stringify(plugin.settings));
  assert.equal(imported.getResolvedProfile("light").interactiveBackground, "#abcdef");
  assert.equal(imported.getResolvedProfile("dark").interactiveBackground, "#112233");

  await imported.setProfileValue("light", "interactiveBackground", "#445566");
  await imported.setPaletteColor("dark", 9, "#778899");
  await imported.setColorAssignment("dark", "interactiveBackground", 9);
  assert.equal(imported.styleManager.buildCssPropertiesForMode("light")["--interactive-normal"], "#445566");
  assert.equal(imported.styleManager.buildCssPropertiesForMode("dark")["--interactive-normal"], "#778899");
  await imported.copyProfile("dark", "light");
  assert.equal(imported.getResolvedProfile("light").interactiveBackground, "#778899");
  await imported.resetProfileValue("light", "interactiveBackground");
  assert.equal(imported.styleManager.buildCssPropertiesForMode("light")["--interactive-normal"], undefined);
  assert.equal(imported.getResolvedProfile("dark").interactiveBackground, "#778899");
  await imported.resetProfile("dark");
  assert.equal(imported.styleManager.buildCssPropertiesForMode("dark")["--interactive-normal"], undefined);
});

test("form field background inherits for older profiles and supports palette, custom, reset and export", async () => {
  const { plugin, DEFAULT_SETTINGS } = fixture();
  const old = structuredClone(DEFAULT_SETTINGS);
  delete old.profiles.light.formFieldBackground;
  delete old.profiles.dark.formFieldBackground;
  old.profiles.light.interactiveBackground = "#123456";
  old.profiles.light.textNormal = "#334455";
  const loadedPlugin = fixture().plugin;
  loadedPlugin.loadData = async () => old;
  await loadedPlugin.loadSettings();
  assert.equal(loadedPlugin.getProfile("light").formFieldBackground, "");
  assert.equal(loadedPlugin.getProfile("dark").formFieldBackground, "");
  await plugin.importSettings(JSON.stringify({ version: 2, uiProfile: "light", profiles: {
    light: { textNormal: "#123456" }, dark: {},
  } }));
  assert.equal(plugin.getProfile("light").formFieldBackground, "");
  assert.equal(plugin.getProfile("dark").formFieldBackground, "");
  await plugin.importSettings(JSON.stringify(old));
  for (const mode of ["light", "dark"]) {
    assert.equal(plugin.getProfile(mode).formFieldBackground, "");
    assert.equal(plugin.styleManager.buildCssPropertiesForMode(mode)["--background-modifier-form-field"], undefined);
  }
  await plugin.setPaletteColor("light", 9, "#abcdef");
  await plugin.setColorAssignment("light", "formFieldBackground", 9);
  await plugin.setProfileValue("dark", "formFieldBackground", "#112233");
  const lightProps = plugin.styleManager.buildCssPropertiesForMode("light");
  assert.equal(lightProps["--background-modifier-form-field"], "#abcdef");
  assert.equal(lightProps["--interactive-normal"], "#123456");
  assert.equal(lightProps["--text-normal"], "#334455");
  assert.equal(lightProps["--background-modifier-form-field-hover"], undefined);
  assert.equal(lightProps["--background-modifier-border"], undefined);
  assert.equal(plugin.styleManager.buildCssPropertiesForMode("dark")["--background-modifier-form-field"], "#112233");
  const snippet = plugin.styleManager.generateSnippetCss();
  assert.match(snippet, /body\.theme-light\s*\{[^}]*--background-modifier-form-field: #abcdef;/);
  assert.match(snippet, /body\.theme-dark\s*\{[^}]*--background-modifier-form-field: #112233;/);
  assert.doesNotMatch(snippet, /--background-modifier-form-field-hover:/);
  const imported = fixture().plugin;
  await imported.importSettings(JSON.stringify(plugin.settings));
  assert.equal(imported.getResolvedProfile("light").formFieldBackground, "#abcdef");
  assert.equal(imported.getResolvedProfile("dark").formFieldBackground, "#112233");
  await imported.setProfileValue("light", "formFieldBackground", "#445566");
  await imported.setPaletteColor("dark", 9, "#778899");
  await imported.setColorAssignment("dark", "formFieldBackground", 9);
  assert.equal(imported.styleManager.buildCssPropertiesForMode("light")["--background-modifier-form-field"], "#445566");
  assert.equal(imported.styleManager.buildCssPropertiesForMode("dark")["--background-modifier-form-field"], "#778899");
  await imported.copyProfile("dark", "light");
  assert.equal(imported.getResolvedProfile("light").formFieldBackground, "#778899");
  await imported.resetProfileValue("light", "formFieldBackground");
  assert.equal(imported.styleManager.buildCssPropertiesForMode("light")["--background-modifier-form-field"], undefined);
  assert.equal(imported.getResolvedProfile("dark").formFieldBackground, "#778899");
  await imported.resetProfile("dark");
  assert.equal(imported.styleManager.buildCssPropertiesForMode("dark")["--background-modifier-form-field"], undefined);
});

test("palette assignments follow edited and imported slots without touching literals or other mode", async () => {
  const { plugin } = fixture();
  plugin.settings.profiles.light.highlightBackground = "rgba(254, 220, 186, 0.3)";
  await plugin.setPaletteColor("light", 12, "#123456");
  await plugin.setPaletteColor("light", 4, "#abcdef");
  await plugin.setPaletteColor("dark", 12, "#999999");
  await plugin.setColorAssignment("light", "h1Color", 12);
  await plugin.setColorAssignment("light", "h2Color", 12);
  await plugin.setColorAssignment("dark", "h1Color", 12);
  assert.equal(plugin.getResolvedProfile("light").h1Color, "#123456");
  assert.equal(plugin.getResolvedProfile("light").h2Color, "#123456");
  const assignments = structuredClone(plugin.settings.colorAssignments.light);
  await plugin.applyBase16Theme('base0C: "aBcDeF"\nbase00: "101010"', "light");
  assert.deepEqual(plugin.settings.colorAssignments.light, assignments);
  assert.equal(plugin.getResolvedProfile("light").h1Color, "#abcdef");
  assert.equal(plugin.getResolvedProfile("light").h2Color, "#abcdef");
  assert.equal(plugin.getResolvedProfile("light").highlightBackground, "rgba(254, 220, 186, 0.3)");
  assert.equal(plugin.settings.palettes.light[4], "#abcdef");
  assert.equal(plugin.getResolvedProfile("dark").h1Color, "#999999");
  await plugin.setColorAssignment("light", "h3Color", 3);
  assert.equal(plugin.getResolvedProfile("light").h3Color, "");
  await plugin.setPaletteColor("light", 3, "#112233");
  assert.equal(plugin.getResolvedProfile("light").h3Color, "#112233");
  await plugin.resetProfileValue("light", "h1Color");
  assert.equal(plugin.getResolvedProfile("light").h1Color, "");
  assert.equal(plugin.settings.colorAssignments.light.h1Color, undefined);
});

test("palette copies are independent and profile resets are isolated", async () => {
  const { plugin } = fixture();
  await plugin.setPaletteColor("light", 12, "#abcdef");
  await plugin.setColorAssignment("light", "h1Color", 12);
  await plugin.copyProfile("light", "dark");
  await plugin.setPaletteColor("dark", 12, "#123456");
  await plugin.setColorAssignment("dark", "h2Color", 12);
  assert.equal(plugin.getResolvedProfile("light").h1Color, "#abcdef");
  assert.equal(plugin.settings.colorAssignments.light.h2Color, undefined);
  await plugin.resetProfile("dark");
  assert.equal(plugin.settings.palettes.dark[12], "");
  assert.deepEqual(plugin.settings.colorAssignments.dark, {});
  assert.equal(plugin.getResolvedProfile("light").h1Color, "#abcdef");
  await plugin.resetAllSettings();
  assert.equal(plugin.settings.palettes.light[12], "");
  assert.deepEqual(plugin.settings.colorAssignments.light, {});
});

test("version 3 settings validate palettes and assignments atomically and round-trip", async () => {
  const { plugin, writes } = fixture();
  await plugin.setPaletteColor("light", 12, "#abcdef");
  await plugin.setColorAssignment("light", "h1Color", 12);
  const saved = structuredClone(plugin.settings);
  writes.length = 0;
  for (const mutate of [
    (s) => { s.palettes.light.pop(); },
    (s) => { s.palettes.light[0] = "url(x)"; },
    (s) => { s.colorAssignments.light.h1Color = 16; },
    (s) => { s.colorAssignments.light.h1Color = 1.5; },
    (s) => { s.colorAssignments.light.fontTextSize = 1; },
    (s) => { delete s.colorAssignments.dark; },
  ]) {
    const invalid = structuredClone(saved);
    mutate(invalid);
    await assert.rejects(plugin.importSettings(JSON.stringify(invalid)));
    assert.deepEqual(plugin.settings, saved);
    assert.equal(writes.length, 0);
  }
  await plugin.importSettings(JSON.stringify(saved));
  assert.deepEqual(plugin.settings, saved);
  assert.deepEqual(writes, [saved]);
  await assert.rejects(plugin.setColorAssignment("light", "fontTextSize", 1), /Invalid/);
  await assert.rejects(plugin.setPaletteColor("light", 16, "#123456"), /Invalid/);
});

test("CSS properties and snippets resolve slots before derived colors", async () => {
  const { plugin } = fixture();
  await plugin.setPaletteColor("light", 12, "#123456");
  await plugin.setColorAssignment("light", "h1Color", 12);
  await plugin.setColorAssignment("light", "linkColor", 12);
  await plugin.setColorAssignment("light", "tagBackground", 12);
  plugin.styleManager.computeAutoHoverColor = (mode, value) => `hover(${mode}, ${value})`;
  const properties = plugin.styleManager.buildCssPropertiesForMode("light");
  assert.equal(properties["--h1-color"], "#123456");
  assert.equal(properties["--link-color-hover"], "hover(light, #123456)");
  assert.equal(properties["--tag-background-hover"], "hover(light, #123456)");
  assert.match(plugin.styleManager.generateSnippetCss(), /--h1-color: #123456;/);
  await plugin.setPaletteColor("light", 12, "#abcdef");
  assert.equal(plugin.styleManager.buildCssPropertiesForMode("light")["--tag-background-hover"], "hover(light, #abcdef)");
});

test("custom literals survive palette changes, profile copy, JSON and CSS export", async () => {
  const { plugin } = fixture();
  await plugin.setPaletteColor("light", 9, "#abcdee");
  await plugin.setColorAssignment("light", "tagBorderColor", 9);
  await plugin.setColorAssignment("light", "linkColor", 9);
  await plugin.setProfileValue("light", "tagBorderColor", "#8799aa");
  await plugin.setProfileValue("light", "linkColor", "#778899");
  await plugin.setProfileValue("dark", "tagBorderColor", "#112233");
  await plugin.applyBase16Theme('base09: "ffeeaa"', "light");
  assert.equal(plugin.getResolvedProfile("light").tagBorderColor, "#8799aa");
  assert.equal(plugin.getResolvedProfile("dark").tagBorderColor, "#112233");
  assert.equal(plugin.settings.colorAssignments.light.tagBorderColor, undefined);
  plugin.styleManager.computeAutoHoverColor = (mode, value) => `hover(${mode}, ${value})`;
  const props = plugin.styleManager.buildCssPropertiesForMode("light");
  assert.equal(props["--tag-border-color"], "#8799aa");
  assert.equal(props["--tag-border-color-hover"], "#8799aa");
  assert.equal(props["--link-color-hover"], "hover(light, #778899)");
  assert.match(plugin.styleManager.generateSnippetCss(), /--tag-border-color: #8799aa;/);
  const exported = JSON.stringify(plugin.settings);
  const imported = fixture().plugin;
  await imported.importSettings(exported);
  assert.equal(imported.getProfile("light").tagBorderColor, "#8799aa");
  assert.equal(imported.getProfile("dark").tagBorderColor, "#112233");
  await imported.copyProfile("light", "dark");
  await imported.setProfileValue("dark", "tagBorderColor", "#334455");
  assert.equal(imported.getProfile("light").tagBorderColor, "#8799aa");
  await imported.resetProfileValue("light", "tagBorderColor");
  assert.equal(imported.getResolvedProfile("light").tagBorderColor, "");
  assert.equal(imported.getProfile("dark").tagBorderColor, "#334455");
});

test("settings use neutral palette labels and preserve a legacy value until changed", async () => {
  const { plugin, SettingsTab, SuggestModal, writes } = fixture();
  plugin.settings.profiles.light.h1Color = "rgb(10 20 30 / 0.5)";
  plugin.styleManager.tryToPickerHex = () => "#0a141e";
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.settingsTab = tab;
  const definitions = tab.getSettingDefinitions();
  const page = definitions.find((item) => item.name === "Color palette");
  const palette = paletteGroup(definitions);
  assert.equal(definitions.some((item) => item.heading === "Import Base16 theme"), false);
  assert.ok(page.items.some((item) => item.heading === "Import Base16 theme"));
  assert.deepEqual(palette.items.slice(1).map((item) => item.name), Array.from({ length: 16 }, (_, i) => `Color ${i + 1}`));
  const h1 = h1ColorDef(definitions);
  const extra = {
    setIcon() { return this; }, setTooltip() { return this; }, setDisabled(value) { this.disabled = value; return this; },
    onClick(callback) { this.click = callback; return this; },
  };
  const element = {
    children: [], attributes: {}, addClass() {}, setAttribute(key, value) { this.attributes[key] = value; },
    empty() { this.children = []; },
    createSpan(data) {
      const child = { ...data, addClass() {}, setAttribute() {}, setCssProps(props) { this.props = props; } };
      this.children.push(child);
      return child;
    },
  };
  const button = { buttonEl: element, onClick(callback) { this.click = callback; return this; } };
  const customContainer = {
    input: null,
    querySelector() { return this.input; },
    empty() { this.input = null; },
  };
  const row = {
    controlEl: { createDiv() { return customContainer; }, toggleClass() {} },
    addExtraButton(configure) { configure(extra); return this; },
    addButton(configure) { configure(button); return this; },
  };
  h1.render(row);
  assert.match(element.attributes["aria-label"], /Custom: rgb\(10 20 30 \/ 0.5\)/);
  assert.deepEqual(element.children[0].props, { "--theme-basics-swatch-color": "rgb(10 20 30 / 0.5)" });
  button.click();
  const modal = SuggestModal.latest;
  const choices = modal.getSuggestions("");
  assert.equal(choices.find((choice) => choice.value === "custom").selected, true);
  assert.equal(choices.find((choice) => choice.value === "12").label, "Color 13 (not set)");
  modal.onChooseSuggestion(choices.find((choice) => choice.value === "custom"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.getProfile("light").h1Color, "rgb(10 20 30 / 0.5)");
  assert.equal(customContainer.input.value, "#0a141e");
  assert.equal(writes.length, 0);
  assert.equal(customContainer.textInput.value, "rgb(10 20 30 / 0.5)");
  assert.deepEqual(customContainer.buttons.map((component) => component.text), ["Set"]);
  customContainer.textComponent.inputEl.value = "#0a141e";
  customContainer.textComponent.change("#0a141e");
  assert.equal(writes.length, 0, "editing a draft must not save or consume a slot");
  await customContainer.buttons[0].click();
  assert.equal(plugin.getProfile("light").h1Color, "");
  assert.equal(plugin.getResolvedProfile("light").h1Color, "#0a141e");
  assert.equal(plugin.settings.colorAssignments.light.h1Color, 16);
  assert.equal(writes.length, 1);
  assert.equal(paletteGroup(tab.settingItems).items.length, 18, "new slot must be indexed in the declarative palette page");
  const refreshedH1 = h1ColorDef(tab.settingItems);
  refreshedH1.render(row);
  button.click();
  const refreshedModal = SuggestModal.latest;
  refreshedModal.onChooseSuggestion(refreshedModal.getSuggestions("").find((choice) => choice.value === "12"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.settings.colorAssignments.light.h1Color, 12);
  assert.equal(plugin.getProfile("light").h1Color, "");
  await extra.click();
  assert.equal(plugin.settings.colorAssignments.light.h1Color, undefined);
  assert.match(element.attributes["aria-label"], /Inherit/);
});

test("pending custom choices are transient, profile-scoped, and cleared only by relevant replacements", async () => {
  const { plugin, SettingsTab } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.settingsTab = tab;
  const setPending = (mode) => {
    tab.pendingCustom[mode].add("tagBorderColor");
    tab.customDraftRevisions[mode].set("tagBorderColor", ++tab.nextCustomDraftRevision);
  };
  setPending("light");
  setPending("dark");
  await plugin.setPaletteColor("light", 0, "#123456");
  await plugin.applyBase16Theme('base00: "abcdef"', "light");
  assert.equal(tab.pendingCustom.light.has("tagBorderColor"), true);
  assert.equal(tab.pendingCustom.dark.has("tagBorderColor"), true);
  assert.equal(Object.hasOwn(plugin.settings, "pendingCustom"), false);

  await plugin.resetProfileValue("light", "tagBorderColor");
  assert.equal(tab.pendingCustom.light.has("tagBorderColor"), false);
  assert.equal(tab.pendingCustom.dark.has("tagBorderColor"), true);
  setPending("light");
  await plugin.setColorAssignment("light", "tagBorderColor", 0);
  assert.equal(tab.pendingCustom.light.has("tagBorderColor"), false);
  setPending("light");
  await plugin.copyProfile("light", "dark");
  assert.equal(tab.pendingCustom.light.has("tagBorderColor"), true);
  assert.equal(tab.pendingCustom.dark.has("tagBorderColor"), false);
  setPending("dark");
  await plugin.resetProfileValues("light", ["tagBorderColor"]);
  assert.equal(tab.pendingCustom.light.has("tagBorderColor"), false);
  assert.equal(tab.pendingCustom.dark.has("tagBorderColor"), true);
  setPending("light");
  await assert.rejects(plugin.importSettings("{}"));
  const saveData = plugin.saveData;
  plugin.saveData = async () => { throw new Error("Disk full"); };
  await assert.rejects(plugin.importSettings(JSON.stringify(plugin.settings)), /Disk full/);
  plugin.saveData = saveData;
  assert.equal(tab.pendingCustom.light.has("tagBorderColor"), true);
  assert.equal(tab.pendingCustom.dark.has("tagBorderColor"), true);
  await plugin.importSettings(JSON.stringify(plugin.settings));
  assert.equal(tab.pendingCustom.light.size, 0);
  assert.equal(tab.pendingCustom.dark.size, 0);
  setPending("light");
  setPending("dark");
  await plugin.resetProfile("light");
  assert.equal(tab.pendingCustom.light.size, 0);
  assert.equal(tab.pendingCustom.dark.has("tagBorderColor"), true);
  await plugin.resetAllSettings();
  assert.equal(tab.pendingCustom.light.size, 0);
  assert.equal(tab.pendingCustom.dark.size, 0);
});

test("queued assignment and reset operations retain newer custom drafts", async () => {
  const { plugin, SettingsTab } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.settingsTab = tab;
  const key = "tagBorderColor";
  const setDraft = (value) => {
    tab.pendingCustom.light.add(key);
    tab.customDrafts.light.set(key, value);
    tab.customDraftRevisions.light.set(key, ++tab.nextCustomDraftRevision);
  };
  const actions = [
    () => plugin.setColorAssignment("light", key, 0),
    () => plugin.resetProfileValue("light", key),
    () => plugin.setProfileValue("light", key, "#abcdef"),
    () => plugin.resetProfile("light"),
    () => plugin.copyProfile("dark", "light"),
    () => plugin.resetAllSettings(),
    () => plugin.importSettings(JSON.stringify(plugin.settings)),
  ];
  for (const action of actions) {
    setDraft("old");
    const deferred = Promise.withResolvers();
    plugin.saveData = () => deferred.promise;
    const write = action();
    await new Promise((resolve) => setImmediate(resolve));
    setDraft("new");
    deferred.resolve();
    await write;
    assert.equal(tab.pendingCustom.light.has(key), true);
    assert.equal(tab.customDrafts.light.get(key), "new");
  }
});

test("unsafe legacy colors report snippet-generation errors without writing or changing settings", async () => {
  const { plugin, notices } = fixture();
  const actions = [];
  let snippet = "existing snippet";
  plugin.app.vault.adapter = {
    async mkdir(path) { actions.push(["mkdir", path]); },
    async write(path, contents) { actions.push(["write", path]); snippet = contents; },
  };
  plugin.settings.profiles.light.h1Color = "red/*";
  const original = structuredClone(plugin.settings);
  await plugin.exportCssSnippet();
  assert.match(notices.at(-1), /Failed to generate CSS snippet:.*light profile: --h1-color.*unbalanced/i);
  assert.deepEqual(actions, []);
  assert.equal(snippet, "existing snippet");
  assert.deepEqual(plugin.settings, original);

  plugin.settings.profiles.light.h1Color = "#abcdef";
  await plugin.exportCssSnippet();
  assert.deepEqual(actions, [["mkdir", ".test-config/snippets"], ["write", ".test-config/snippets/theme-basics.css"]]);
  assert.match(snippet, /--h1-color: #abcdef;/);
  assert.match(notices.at(-1), /Snippet saved/);
});

test("loading malformed or newer palette settings never overwrites saved data", async () => {
  const { plugin, writes, DEFAULT_SETTINGS } = fixture();
  const bad = structuredClone(DEFAULT_SETTINGS);
  bad.palettes.light[0] = "not-a-color";
  plugin.loadData = async () => bad;
  await assert.rejects(plugin.loadSettings(), /palette/i);
  assert.deepEqual(writes, []);
  plugin.loadData = async () => ({ version: 5, profiles: {} });
  await assert.rejects(plugin.loadSettings(), /newer version/i);
  assert.deepEqual(writes, []);
});

test("empty palette picker is not saved until changed or explicitly set", async () => {
  const { plugin, SettingsTab, writes } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  const palette = paletteGroup(tab.getSettingDefinitions());
  const picker = {
    value: "#000000", setValue(value) { this.value = value; return this; },
    getValue() { return this.value; }, onChange(callback) { this.change = callback; return this; },
  };
  const button = { setButtonText() { return this; }, onClick(callback) { this.click = callback; return this; } };
  const row = paletteRow(picker, button);
  palette.items[1].render(row);
  assert.equal(plugin.settings.palettes.light[0], "");
  assert.equal(writes.length, 0);
  await button.click();
  assert.equal(plugin.settings.palettes.light[0], "#000000");
  await picker.change("#123456");
  assert.equal(plugin.settings.palettes.light[0], "#123456");
});

test("declarative palette rows reject stale handlers after their page is closed", async () => {
  const { plugin, SettingsTab, writes } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  const definitions = tab.getSettingDefinitions();
  const page = definitions.find((item) => item.name === "Color palette");
  const picker = {
    setValue() { return this; }, onChange(callback) { this.change = callback; return this; },
  };
  const row = paletteRow(picker);
  const cleanup = paletteGroup(definitions).items[1].render(row);
  const dropdown = {
    addOption() { return this; }, setValue() { return this; }, setDisabled() { return this; },
    onChange(callback) { this.change = callback; return this; },
  };
  const profileCleanup = page.items[0].render({ addDropdown: (configure) => configure(dropdown) });
  cleanup();
  profileCleanup();
  await picker.change("#abcdef");
  await dropdown.change("dark");
  assert.equal(plugin.settings.palettes.light[0], "");
  assert.equal(plugin.settings.uiProfile, "light");
  assert.equal(writes.length, 0);
});

test("reset commands refresh settings definitions and invalidate stale palette controls", async () => {
  for (const commandId of ["reset-current-profile-overrides", "reset-all-overrides"]) {
    const { plugin, SettingsTab, writes } = fixture();
    await plugin.setPaletteColor("light", 0, "#123456");
    await plugin.setColorAssignment("light", "h1Color", 0);
    const tab = new SettingsTab(plugin.app, plugin);
    plugin.settingsTab = tab;
    tab.update();
    const palette = paletteGroup(tab.settingItems);
    const picker = {
      setValue() { return this; }, onChange(callback) { this.change = callback; return this; },
    };
    const row = paletteRow(picker);
    palette.items[1].render(row);
    const commands = new Map();
    plugin.addCommand = (command) => commands.set(command.id, command);
    plugin.registerCommands();
    await commands.get(commandId).callback();
    assert.equal(plugin.settings.palettes.light[0], "");
    assert.equal(plugin.settings.colorAssignments.light.h1Color, undefined);
    const refreshed = paletteGroup(tab.settingItems);
    assert.match(refreshed.items[1].desc, /^Not set\./);
    const count = writes.length;
    await picker.change("#abcdef");
    assert.equal(plugin.settings.palettes.light[0], "");
    assert.equal(writes.length, count);
  }
});

test("version 3 palettes migrate without changing slot assignments or legacy literals", async () => {
  const { plugin, DEFAULT_SETTINGS } = fixture();
  const v3 = structuredClone(DEFAULT_SETTINGS);
  v3.version = 3;
  v3.palettes.light[12] = "#ABCDEF";
  v3.colorAssignments.light.h1Color = 12;
  v3.profiles.dark.tagBorderColor = "rgba(1, 2, 3, 0.3)";
  await plugin.importSettings(JSON.stringify(v3));
  assert.equal(plugin.settings.version, 4);
  assert.equal(plugin.getResolvedProfile("light").h1Color, "#abcdef");
  assert.equal(plugin.settings.colorAssignments.light.h1Color, 12);
  assert.equal(plugin.getProfile("dark").tagBorderColor, "rgba(1, 2, 3, 0.3)");
  assert.equal(plugin.settings.palettes.light.length, 16);
});

test("expanded palettes append and replace by position with stable assignments across save and import", async () => {
  const { plugin } = fixture();
  const colors = Array.from({ length: 60 }, (_, index) => `#${index.toString(16).padStart(6, "0")}`);
  await plugin.setPaletteColor("light", 0, "#abcdef");
  await plugin.setColorAssignment("light", "h1Color", 0);
  await plugin.setPaletteColor("dark", 0, "#112233");
  await plugin.setColorAssignment("dark", "h1Color", 0);
  assert.equal(await plugin.importPaletteColors("light", JSON.stringify(colors), "json", "append"), 60);
  assert.equal(plugin.settings.palettes.light.length, 76);
  await plugin.setColorAssignment("light", "tagBorderColor", 68);
  assert.equal(plugin.getResolvedProfile("light").tagBorderColor, colors[52]);
  assert.equal(await plugin.importPaletteColors("light", "#010203, #040506", "csv", "replace"), 2);
  assert.equal(plugin.getResolvedProfile("light").h1Color, "#010203");
  assert.equal(plugin.getResolvedProfile("light").tagBorderColor, colors[52]);
  assert.equal(plugin.settings.palettes.light[2], "");
  assert.equal(plugin.getResolvedProfile("dark").h1Color, "#112233");
  await plugin.applyBase16Theme('base00: "fedcba"', "light");
  assert.equal(plugin.getResolvedProfile("light").h1Color, "#fedcba");
  assert.equal(plugin.getResolvedProfile("light").tagBorderColor, colors[52]);
  const saved = JSON.stringify(plugin.settings);
  const loaded = fixture().plugin;
  loaded.loadData = async () => JSON.parse(saved);
  await loaded.loadSettings();
  assert.equal(loaded.settings.palettes.light.length, 76);
  assert.equal(loaded.getResolvedProfile("light").tagBorderColor, colors[52]);
  const imported = fixture().plugin;
  await imported.importSettings(saved);
  assert.deepEqual(imported.settings, loaded.settings);
  await imported.copyProfile("light", "dark");
  await imported.setPaletteColor("dark", 68, "#abcdef");
  assert.equal(imported.getResolvedProfile("dark").tagBorderColor, "#abcdef");
  assert.equal(imported.getResolvedProfile("light").tagBorderColor, colors[52]);
  await imported.resetProfile("dark");
  assert.equal(imported.settings.palettes.dark.length, 16);
  assert.equal(imported.getResolvedProfile("light").tagBorderColor, colors[52]);
});

test("color list import preserves CSS expressions and is atomic on invalid input or save failure", async () => {
  const previousCss = global.CSS;
  global.CSS = { supports: (property, value) => property === "color" && /^(?:rgba|oklch|color-mix)\(/i.test(value) };
  try {
    const { plugin, writes } = fixture();
    const before = structuredClone(plugin.settings);
    for (const input of ["#ffffff, not-a-color", '"rgba(1, 2, 3, 0.5)", url(x)', "#abcdef; color:red"]) {
      await assert.rejects(plugin.importPaletteColors("light", input, "csv", "replace"));
      assert.deepEqual(plugin.settings, before);
      assert.equal(writes.length, 0);
    }
    const expressions = ["rgba(1, 2, 3, 0.3)", "oklch(60%  0.2 30)", "#abcdef80"];
    await plugin.importPaletteColors("light", JSON.stringify(expressions), "json", "replace");
    assert.deepEqual(plugin.settings.palettes.light.slice(0, 3), expressions);
    await plugin.setColorAssignment("light", "tagBorderColor", 0);
    assert.equal(plugin.getResolvedProfile("light").tagBorderColor, expressions[0]);
    assert.match(plugin.styleManager.generateSnippetCss(), /--tag-border-color: rgba\(1, 2, 3, 0.3\);/);
    const saved = structuredClone(plugin.settings);
    plugin.saveData = async () => { throw new Error("Disk full"); };
    await assert.rejects(plugin.importPaletteColors("light", "#112233", "csv", "replace"), /Disk full/);
    await assert.rejects(plugin.setPaletteColor("light", 0, "#112233"), /Disk full/);
    await assert.rejects(plugin.addPaletteSlot("light"), /Disk full/);
    await assert.rejects(plugin.applyBase16Theme('base00: "112233"', "light"), /Disk full/);
    assert.deepEqual(plugin.settings, saved);
  } finally {
    if (previousCss === undefined) delete global.CSS;
    else global.CSS = previousCss;
  }
});

test("custom commit reuses equivalent hex, preserves alpha and adds only one slot", async () => {
  const { plugin, writes } = fixture();
  await plugin.setPaletteColor("light", 0, "#ff0000");
  await plugin.setPaletteColor("light", 1, "#ff000088");
  const existingLength = plugin.settings.palettes.light.length;
  assert.equal(await plugin.commitCustomColor("light", "tagBorderColor", "#f00"), 0);
  assert.equal(plugin.settings.palettes.light.length, existingLength);
  assert.equal(await plugin.commitCustomColor("light", "h1Color", "#f008"), 1);
  assert.equal(plugin.settings.palettes.light.length, existingLength);
  const count = writes.length;
  assert.equal(await plugin.commitCustomColor("light", "tagBackground", "#ff000081"), 16);
  assert.equal(writes.length, count + 1);
  assert.equal(plugin.settings.palettes.light.length, existingLength + 1);
  assert.equal(plugin.getResolvedProfile("light").tagBackground, "#ff000081");
  assert.equal(plugin.getResolvedProfile("light").h1Color, "#ff000088");
  const before = structuredClone(plugin.settings);
  plugin.saveData = async () => { throw new Error("Disk full"); };
  await assert.rejects(plugin.commitCustomColor("light", "h2Color", "#123456"), /Disk full/);
  assert.deepEqual(plugin.settings, before);
});

test("overlapping palette, assignment, profile and import writes serialize against the latest committed state", async () => {
  const { plugin } = fixture();
  const pending = [];
  let active = 0;
  let maxActive = 0;
  plugin.saveData = (settings) => new Promise((resolve, reject) => {
    active++;
    maxActive = Math.max(maxActive, active);
    pending.push({ snapshot: structuredClone(settings), resolve: () => { active--; resolve(); },
      reject: () => { active--; reject(new Error("Disk full")); } });
  });
  const first = plugin.setPaletteColor("light", 0, "#111111");
  const second = plugin.setPaletteColor("light", 1, "#222222");
  const assignment = plugin.setColorAssignment("light", "h1Color", 0);
  const profile = plugin.setProfileValue("dark", "textNormal", "#333333");
  const imported = plugin.importPaletteColors("light", "#444444", "csv", "append");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1);
  assert.equal(plugin.settings.palettes.light[0], "", "uncommitted settings stay unchanged");
  for (const operation of [first, second, assignment, profile, imported]) {
    pending.shift().resolve();
    await operation;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(maxActive, 1);
  assert.equal(plugin.settings.palettes.light[0], "#111111");
  assert.equal(plugin.settings.palettes.light[1], "#222222");
  assert.equal(plugin.settings.palettes.light[16], "#444444");
  assert.equal(plugin.settings.colorAssignments.light.h1Color, 0);
  assert.equal(plugin.getProfile("dark").textNormal, "#333333");
  const saved = structuredClone(plugin.settings);
  const reset = plugin.resetProfileValue("light", "h1Color");
  const subsequent = plugin.setPaletteColor("light", 2, "#555555");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1);
  pending.shift().reject();
  await assert.rejects(reset, /Disk full/);
  assert.deepEqual(plugin.settings, saved, "failed reset must not mutate the live profile or assignment");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1, "a failed write must not poison the queue");
  assert.equal(pending[0].snapshot.colorAssignments.light.h1Color, 0);
  pending.shift().resolve();
  await subsequent;
  assert.equal(plugin.settings.colorAssignments.light.h1Color, 0);
  assert.equal(plugin.settings.palettes.light[2], "#555555");
});

test("failed profile selection restores the committed mode and reports the error", async () => {
  const { plugin, SettingsTab, notices } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.saveData = async () => { throw new Error("Disk full"); };
  const dropdown = {
    value: "", addOption() { return this; },
    setValue(value) { this.value = value; this.change?.(value); return this; },
    setDisabled() { return this; },
    onChange(callback) { this.change = callback; return this; },
  };
  tab.getSettingDefinitions()[0].render({ addDropdown: (configure) => configure(dropdown) });
  dropdown.value = "dark";
  await dropdown.change("dark");
  assert.equal(plugin.getEditedProfileMode(), "light");
  assert.equal(dropdown.value, "light");
  assert.match(notices.at(-1), /Disk full/);
});

test("palette save refreshes committed swatch without replacing a newer text draft", async () => {
  const { plugin, SettingsTab } = fixture();
  plugin.settings.palettes.light[0] = "#111111";
  plugin.styleManager.tryToPickerHex = (value) => value;
  const tab = new SettingsTab(plugin.app, plugin);
  const pending = Promise.withResolvers();
  plugin.saveData = () => pending.promise;
  const picker = { value: "#111111", getValue() { return this.value; }, setValue(value) { this.value = value; return this; },
    onChange(callback) { this.change = callback; return this; } };
  const button = { setButtonText() { return this; }, onClick(callback) { this.click = callback; return this; } };
  const row = paletteRow(picker, button);
  let refreshes = 0;
  tab.colorControlRefreshers.add(() => { refreshes++; });
  tab.configurePaletteSetting(row, "light", 0, tab.displayToken);
  row.text.value = "#223344";
  row.text.change("#223344");
  const saving = button.click();
  await new Promise((resolve) => setImmediate(resolve));
  row.text.value = "#445566";
  row.text.change("#445566");
  pending.resolve();
  await saving;
  assert.equal(plugin.settings.palettes.light[0], "#223344");
  assert.equal(row.text.value, "#445566");
  assert.equal(row.swatch.props["--theme-basics-swatch-color"], "#223344");
  assert.match(row.desc, /All settings assigned/);
  assert.equal(refreshes, 1);
});

test("a newer Custom draft survives an earlier asynchronous commit and row rebuild", async () => {
  const { plugin, SettingsTab } = fixture();
  plugin.settings.profiles.light.h1Color = "#123456";
  plugin.styleManager.tryToPickerHex = (value) => value;
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.settingsTab = tab;
  const makeRow = () => {
    const extra = { setIcon() { return this; }, setTooltip() { return this; }, setDisabled() { return this; }, onClick() { return this; } };
    const element = { addClass() {}, setAttribute() {}, empty() {},
      createSpan(data) { return { ...data, addClass() {}, setAttribute() {}, setCssProps() {} }; } };
    const button = { buttonEl: element, onClick() { return this; } };
    const container = { input: null, querySelector() { return this.input; }, empty() { this.input = null; } };
    return { container, row: { controlEl: { createDiv() { return container; }, toggleClass() {} },
      addExtraButton(configure) { configure(extra); return this; },
      addButton(configure) { configure(button); return this; } } };
  };
  const h1 = (definitions) => h1ColorDef(definitions);
  const first = makeRow();
  h1(tab.getSettingDefinitions()).render(first.row);
  first.container.textComponent.change("#223344");
  const pending = Promise.withResolvers();
  plugin.saveData = () => pending.promise;
  const saving = first.container.buttons.find((component) => component.text === "Set").click();
  await new Promise((resolve) => setImmediate(resolve));
  first.container.textComponent.change("#445566");
  pending.resolve();
  await saving;
  assert.equal(plugin.getResolvedProfile("light").h1Color, "#223344");
  assert.equal(tab.customDrafts.light.get("h1Color"), "#445566");
  const next = makeRow();
  h1(tab.settingItems).render(next.row);
  assert.equal(next.container.textInput.value, "#445566");
});

test("an exported settings file over 1 MB can be restored through the file input", async () => {
  const source = fixture().plugin;
  source.settings.palettes.light = Array(110000).fill("#abcdef");
  const originalDocument = globalThis.activeDocument;
  const originalCreateEl = globalThis.createEl;
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  let exportedBlob;
  let input;
  globalThis.activeDocument = { adoptNode(node) { node.ownerDocument = this; return node; } };
  globalThis.createEl = (tag, options) => {
    if (tag === "a") return { click() {} };
    input = { files: [], click() {} };
    assert.equal(options.type, "file");
    return input;
  };
  URL.createObjectURL = (blob) => { exportedBlob = blob; return "blob:test"; };
  URL.revokeObjectURL = () => {};
  try {
    source.exportSettingsJson();
    assert.ok(exportedBlob.size > 1024 * 1024);
    const file = new File([await exportedBlob.text()], "settings.json", { type: "application/json" });
    const { plugin: target, notices } = fixture();
    target.importSettingsJson();
    input.files = [file];
    await input.onchange();
    assert.equal(target.settings.palettes.light.length, source.settings.palettes.light.length);
    assert.equal(target.settings.palettes.light.at(-1), "#abcdef");
    assert.match(notices.at(-1), /success/i);
  } finally {
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    if (originalDocument === undefined) delete globalThis.activeDocument;
    else globalThis.activeDocument = originalDocument;
    if (originalCreateEl === undefined) delete globalThis.createEl;
    else globalThis.createEl = originalCreateEl;
  }
});

test("settings file imports honor the latest selected file and retain atomic failures", async (t) => {
  const previousDocument = globalThis.activeDocument;
  const previousCreateEl = globalThis.createEl;
  const inputs = [];
  globalThis.activeDocument = { adoptNode(node) { node.ownerDocument = this; return node; } };
  globalThis.createEl = (tag, options) => {
    assert.equal(tag, "input");
    assert.equal(options.type, "file");
    const input = { files: [], click() {} };
    inputs.push(input);
    return input;
  };
  const openInput = (plugin) => {
    plugin.importSettingsJson();
    const input = inputs.pop();
    assert.ok(input);
    return input;
  };
  const deferredFile = (name) => {
    const read = Promise.withResolvers();
    const file = new File([], name, { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => read.promise });
    return { file, read };
  };
  const backup = (plugin, color) => {
    const settings = structuredClone(plugin.settings);
    settings.profiles.light.textNormal = color;
    return JSON.stringify(settings);
  };
  try {
    await t.test("later selected backup wins even when its read finishes first", async () => {
      const { plugin, writes, notices } = fixture();
      const old = deferredFile("old.json");
      const latest = deferredFile("latest.json");
      const oldInput = openInput(plugin);
      oldInput.files = [old.file];
      const oldImport = oldInput.onchange();
      const latestInput = openInput(plugin);
      latestInput.files = [latest.file];
      const latestImport = latestInput.onchange();
      latest.read.resolve(backup(plugin, "#112233"));
      await latestImport;
      old.read.resolve(backup(plugin, "#aabbcc"));
      await oldImport;
      assert.equal(plugin.settings.profiles.light.textNormal, "#112233");
      assert.equal(writes.length, 1);
      assert.deepEqual(notices, ["Settings imported successfully."]);
    });
    await t.test("a cancelled later dialog does not supersede an earlier file", async () => {
      const { plugin, writes, notices } = fixture();
      const pending = deferredFile("pending.json");
      const first = openInput(plugin);
      first.files = [pending.file];
      const importing = first.onchange();
      const cancelled = openInput(plugin);
      await cancelled.onchange();
      pending.read.resolve(backup(plugin, "#445566"));
      await importing;
      assert.equal(plugin.settings.profiles.light.textNormal, "#445566");
      assert.equal(writes.length, 1);
      assert.deepEqual(notices, ["Settings imported successfully."]);
    });
    await t.test("invalid latest file rejects atomically and superseded reads are silent", async () => {
      const { plugin, writes, notices } = fixture();
      const before = structuredClone(plugin.settings);
      const old = deferredFile("old.json");
      const invalid = deferredFile("invalid.json");
      const oldInput = openInput(plugin);
      oldInput.files = [old.file];
      const oldImport = oldInput.onchange();
      const invalidInput = openInput(plugin);
      invalidInput.files = [invalid.file];
      const invalidImport = invalidInput.onchange();
      invalid.read.resolve("{invalid JSON");
      await invalidImport;
      old.read.resolve(backup(plugin, "#aabbcc"));
      await oldImport;
      assert.deepEqual(plugin.settings, before);
      assert.equal(writes.length, 0);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /Failed to import settings/);
    });
    await t.test("a queued import superseded by a newer invalid file never saves or refreshes", async () => {
      const { plugin, writes, notices } = fixture();
      const blocker = Promise.withResolvers();
      let writesStarted = 0;
      let refreshes = 0;
      let cleared = 0;
      plugin.saveData = async (settings) => {
        writesStarted++;
        if (writesStarted === 1) await blocker.promise;
        writes.push(structuredClone(settings));
      };
      const pendingSave = plugin.setProfileValue("dark", "tagColor", "#334455");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(writesStarted, 1);
      plugin.settingsTab = {
        getPendingCustomRevisions() { return new Map(); },
        clearPendingCustomRevisions() { cleared++; },
        refreshDisplayPreserveScroll() { refreshes++; },
      };
      const first = deferredFile("first.json");
      const firstInput = openInput(plugin);
      firstInput.files = [first.file];
      const firstImport = firstInput.onchange();
      first.read.resolve(backup(plugin, "#112233"));
      await new Promise((resolve) => setImmediate(resolve));
      const latest = deferredFile("invalid.json");
      const latestInput = openInput(plugin);
      latestInput.files = [latest.file];
      const latestImport = latestInput.onchange();
      latest.read.resolve("{invalid JSON");
      await latestImport;
      blocker.resolve();
      await pendingSave;
      await firstImport;
      assert.equal(writesStarted, 1);
      assert.equal(writes.length, 1);
      assert.equal(plugin.settings.profiles.dark.tagColor, "#334455");
      assert.equal(plugin.settings.profiles.light.textNormal, "");
      assert.equal(refreshes, 0);
      assert.equal(cleared, 0);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /Failed to import settings/);
    });
    await t.test("a newer valid queued import runs after the superseded import is skipped", async () => {
      const { plugin, writes, notices } = fixture();
      const blocker = Promise.withResolvers();
      let writesStarted = 0;
      plugin.saveData = async (settings) => {
        writesStarted++;
        if (writesStarted === 1) await blocker.promise;
        writes.push(structuredClone(settings));
      };
      const pendingSave = plugin.setProfileValue("dark", "tagColor", "#334455");
      await new Promise((resolve) => setImmediate(resolve));
      const first = deferredFile("first.json");
      const firstInput = openInput(plugin);
      firstInput.files = [first.file];
      const firstImport = firstInput.onchange();
      first.read.resolve(backup(plugin, "#112233"));
      await new Promise((resolve) => setImmediate(resolve));
      const latest = deferredFile("latest.json");
      const latestInput = openInput(plugin);
      latestInput.files = [latest.file];
      const latestImport = latestInput.onchange();
      latest.read.resolve(backup(plugin, "#445566"));
      await new Promise((resolve) => setImmediate(resolve));
      blocker.resolve();
      await pendingSave;
      await firstImport;
      await latestImport;
      assert.equal(writes.length, 2);
      assert.equal(plugin.settings.profiles.light.textNormal, "#445566");
      assert.deepEqual(notices, ["Settings imported successfully."]);
    });
    await t.test("cancelling a dialog does not supersede an import waiting in the queue", async () => {
      const { plugin, writes, notices } = fixture();
      const blocker = Promise.withResolvers();
      let writesStarted = 0;
      plugin.saveData = async (settings) => {
        writesStarted++;
        if (writesStarted === 1) await blocker.promise;
        writes.push(structuredClone(settings));
      };
      const pendingSave = plugin.setProfileValue("dark", "tagColor", "#334455");
      await new Promise((resolve) => setImmediate(resolve));
      const first = deferredFile("first.json");
      const firstInput = openInput(plugin);
      firstInput.files = [first.file];
      const firstImport = firstInput.onchange();
      first.read.resolve(backup(plugin, "#112233"));
      await new Promise((resolve) => setImmediate(resolve));
      const cancelled = openInput(plugin);
      await cancelled.onchange();
      blocker.resolve();
      await pendingSave;
      await firstImport;
      assert.equal(writes.length, 2);
      assert.equal(plugin.settings.profiles.light.textNormal, "#112233");
      assert.deepEqual(notices, ["Settings imported successfully."]);
    });
    await t.test("an import already saving completes even if a newer selected file is invalid", async () => {
      const { plugin, writes, notices } = fixture();
      const blocker = Promise.withResolvers();
      let writesStarted = 0;
      plugin.saveData = async (settings) => {
        writesStarted++;
        if (writesStarted === 1) await blocker.promise;
        writes.push(structuredClone(settings));
      };
      const first = deferredFile("first.json");
      const firstInput = openInput(plugin);
      firstInput.files = [first.file];
      const firstImport = firstInput.onchange();
      first.read.resolve(backup(plugin, "#112233"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(writesStarted, 1);
      const latest = deferredFile("invalid.json");
      const latestInput = openInput(plugin);
      latestInput.files = [latest.file];
      const latestImport = latestInput.onchange();
      latest.read.resolve("{invalid JSON");
      await latestImport;
      blocker.resolve();
      await firstImport;
      assert.equal(writes.length, 1);
      assert.equal(plugin.settings.profiles.light.textNormal, "#112233");
      assert.equal(notices.length, 2);
      assert.match(notices[0], /Failed to import settings/);
      assert.equal(notices[1], "Settings imported successfully.");
    });
    await t.test("a failed import that already began is reported and the newer import still succeeds", async () => {
      const { plugin, writes, notices } = fixture();
      const firstWrite = Promise.withResolvers();
      let attempts = 0;
      plugin.saveData = async (settings) => {
        attempts++;
        if (attempts === 1) await firstWrite.promise;
        writes.push(structuredClone(settings));
      };
      const first = deferredFile("first.json");
      const firstInput = openInput(plugin);
      firstInput.files = [first.file];
      const firstImport = firstInput.onchange();
      first.read.resolve(backup(plugin, "#112233"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(attempts, 1);
      const latest = deferredFile("latest.json");
      const latestInput = openInput(plugin);
      latestInput.files = [latest.file];
      const latestImport = latestInput.onchange();
      latest.read.resolve(backup(plugin, "#445566"));
      firstWrite.reject(new Error("First write failed"));
      await firstImport;
      await latestImport;
      assert.equal(plugin.settings.profiles.light.textNormal, "#445566");
      assert.equal(writes.length, 1);
      assert.deepEqual(notices, ["Failed to import settings: First write failed", "Settings imported successfully."]);
    });
    await t.test("failed reads and writes leave settings intact and report only current failures", async () => {
      const { plugin, writes, notices } = fixture();
      const before = structuredClone(plugin.settings);
      const old = deferredFile("old.json");
      const current = deferredFile("current.json");
      const oldInput = openInput(plugin);
      oldInput.files = [old.file];
      const oldImport = oldInput.onchange();
      const currentInput = openInput(plugin);
      currentInput.files = [current.file];
      const currentImport = currentInput.onchange();
      current.read.reject(new Error("Unreadable backup"));
      await currentImport;
      old.read.reject(new Error("Stale read error"));
      await oldImport;
      assert.deepEqual(plugin.settings, before);
      assert.equal(writes.length, 0);
      assert.deepEqual(notices, ["Failed to import settings: Unreadable backup"]);
      plugin.saveData = async () => { throw new Error("Disk full"); };
      const failingInput = openInput(plugin);
      failingInput.files = [new File([backup(plugin, "#123456")], "valid.json", { type: "application/json" })];
      await failingInput.onchange();
      assert.deepEqual(plugin.settings, before);
      assert.match(notices.at(-1), /Disk full/);
    });
  } finally {
    if (previousDocument === undefined) delete globalThis.activeDocument;
    else globalThis.activeDocument = previousDocument;
    if (previousCreateEl === undefined) delete globalThis.createEl;
    else globalThis.createEl = previousCreateEl;
  }
});

test("palette CSV and JSON file inputs populate and validate before importing", async () => {
  const { plugin, SettingsTab, notices } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  const token = tab.displayToken;
  const previousDocument = globalThis.activeDocument;
  const previousCreateEl = globalThis.createEl;
  let input;
  globalThis.activeDocument = { adoptNode(node) { node.ownerDocument = this; return node; } };
  globalThis.createEl = (tag, options) => {
    assert.equal(tag, "input");
    assert.equal(options.type, "file");
    input = { files: [], click() {} };
    return input;
  };
  tab.refreshDisplayPreserveScroll = () => {};
  const textArea = { inputEl: { addClass() {} }, setPlaceholder() { return this; }, setValue() { return this; },
    onChange(callback) { this.change = callback; return this; } };
  const buttons = [];
  const setting = { addTextArea(configure) { configure(textArea); return this; }, addButton(configure) {
    const button = { setButtonText(label) { this.label = label; return this; }, onClick(callback) { this.click = callback; return this; } };
    configure(button); buttons.push(button); return this;
  } };
  try {
    tab.configurePaletteListInput(setting, token);
    tab.configurePaletteListActions(setting, "light", token);
    const load = buttons.find((button) => button.label === "Load file");
    const append = buttons.find((button) => button.label === "Append colors");
    const replace = buttons.find((button) => button.label === "Replace by position");
    await load.click(); input.files = [new File(["#112233, #445566"], "palette.csv")]; await input.onchange();
    assert.equal(tab.paletteListFormat, "csv");
    await append.click();
    assert.deepEqual(plugin.settings.palettes.light.slice(-2), ["#112233", "#445566"]);
    await load.click(); input.files = [new File(['["#abcdef", "#123456"]'], "palette.json")]; await input.onchange();
    assert.equal(tab.paletteListFormat, "json");
    await replace.click();
    assert.deepEqual(plugin.settings.palettes.light.slice(0, 2), ["#abcdef", "#123456"]);
    const before = structuredClone(plugin.settings);
    await load.click(); input.files = [new File(['["#abcdef", "not-a-color"]'], "bad.json")]; await input.onchange();
    await append.click();
    assert.deepEqual(plugin.settings, before);
    assert.match(notices.at(-1), /Invalid color/);
    await load.click(); input.files = [{ name: "bad.csv", async text() { throw new Error("Unreadable file"); } }]; await input.onchange();
    assert.match(notices.at(-1), /Unreadable file/);
  } finally {
    if (previousDocument === undefined) delete globalThis.activeDocument;
    else globalThis.activeDocument = previousDocument;
    if (previousCreateEl === undefined) delete globalThis.createEl;
    else globalThis.createEl = previousCreateEl;
  }
});

function profileDropdown() {
  return {
    addOption() { return this; }, setValue() { return this; }, setDisabled() { return this; },
    onChange(callback) { this.change = callback; return this; },
  };
}

test("cached declarative definitions stay interactive after the tab is hidden and reopened", async () => {
  const { plugin, SettingsTab } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.settingsTab = tab;
  tab.update();
  const cached = tab.settingItems;
  const firstOpen = profileDropdown();
  const cleanup = cached[0].render({ addDropdown: (configure) => configure(firstOpen) });
  // Obsidian tears rows down, hides the tab, then re-renders the same cached
  // definitions on reopen without calling getSettingDefinitions() again.
  cleanup();
  tab.hide();
  assert.equal(tab.settingItems, cached);
  const reopened = profileDropdown();
  cached[0].render({ addDropdown: (configure) => configure(reopened) });
  await reopened.change("dark");
  assert.equal(plugin.getEditedProfileMode(), "dark");
});

test("cached palette rows stay interactive across repeated hide and reopen cycles", async () => {
  const { plugin, SettingsTab } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.settingsTab = tab;
  tab.update();
  for (const color of ["#111111", "#222222", "#333333"]) {
    const picker = { setValue() { return this; }, onChange(callback) { this.change = callback; return this; } };
    const cleanup = paletteGroup(tab.settingItems).items[1].render(paletteRow(picker));
    await picker.change(color);
    assert.equal(plugin.settings.palettes.light[0], color);
    cleanup();
    tab.hide();
  }
});

test("controls rendered before hide stay stale even if their cleanup never ran", async () => {
  const { plugin, SettingsTab, writes } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.settingsTab = tab;
  tab.update();
  const beforeHide = profileDropdown();
  tab.settingItems[0].render({ addDropdown: (configure) => configure(beforeHide) });
  tab.hide();
  const afterReopen = profileDropdown();
  tab.settingItems[0].render({ addDropdown: (configure) => configure(afterReopen) });
  await beforeHide.change("dark");
  assert.equal(plugin.getEditedProfileMode(), "light");
  assert.equal(writes.length, 0);
  await afterReopen.change("dark");
  assert.equal(plugin.getEditedProfileMode(), "dark");
});

test("unloading the plugin invalidates rows rendered from cached definitions", async () => {
  const { plugin, SettingsTab, writes } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  plugin.settingsTab = tab;
  tab.update();
  const cached = tab.settingItems;
  const rendered = profileDropdown();
  cached[0].render({ addDropdown: (configure) => configure(rendered) });
  tab.dispose();
  const afterDispose = profileDropdown();
  cached[0].render({ addDropdown: (configure) => configure(afterDispose) });
  await rendered.change("dark");
  await afterDispose.change("dark");
  assert.equal(plugin.getEditedProfileMode(), "light");
  assert.equal(writes.length, 0);
});

test("declarative rows have unique keys within each group and page", () => {
  const { plugin, SettingsTab } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  // Mirrors Obsidian's row key: explicit id, control key, then name.
  const rowKey = (item, index) => item.type === "page" ? `page:${item.id ?? item.name}`
    : item.id ? `id:${item.id}` : item.control ? `ctrl:${item.control.key}` : item.name ? `name:${item.name}` : `item#${index}`;
  const check = (items, path) => {
    const rows = items.filter((item) => item.type !== "group" && item.type !== "list");
    const keys = rows.map(rowKey);
    assert.deepEqual(keys.filter((key, index) => keys.indexOf(key) !== index), [], `duplicate keys in ${path}`);
    for (const item of items) {
      if (item.type === "group" || item.type === "list") check(item.items ?? [], `${path} > ${item.heading}`);
      if (item.type === "page") check(item.items ?? [], `${path} > ${item.name}`);
    }
  };
  check(tab.getSettingDefinitions(), "root");
});

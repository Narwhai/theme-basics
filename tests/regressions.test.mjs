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
    onChange(callback) { this.change = callback; return this; },
  };
  const row = tab.getSettingDefinitions()[0];
  row.render({ addDropdown: (configure) => configure(dropdown) });
  const dark = dropdown.change("dark");
  const light = dropdown.change("light");
  assert.equal(plugin.getEditedProfileMode(), "light");
  assert.equal(completions.length, 2);
  for (const complete of completions) complete();
  await Promise.all([dark, light]);
  assert.equal(plugin.getEditedProfileMode(), "light");
});

test("old declarative controls cannot mutate settings after definitions rebuild", async () => {
  const { plugin, SettingsTab, writes } = fixture();
  const tab = new SettingsTab(plugin.app, plugin);
  const dropdown = {
    addOption() { return this; },
    setValue() { return this; },
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
  assert.equal(plugin.settings.version, 3);
  assert.equal(plugin.getProfile("light").h1Color, old.profiles.light.h1Color);
  assert.equal(plugin.getResolvedProfile("light").highlightBackground, old.profiles.light.highlightBackground);
  assert.equal(plugin.getResolvedProfile("dark").h1Color, old.profiles.dark.h1Color);
  assert.deepEqual(plugin.settings.palettes.light, Array(16).fill(""));
  assert.deepEqual(plugin.settings.colorAssignments.light, {});
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

test("settings use neutral palette labels and preserve a legacy value until changed", async () => {
  const { plugin, SettingsTab, SuggestModal } = fixture();
  plugin.settings.profiles.light.h1Color = "rgb(10 20 30 / 0.5)";
  const tab = new SettingsTab(plugin.app, plugin);
  const definitions = tab.getSettingDefinitions();
  const page = definitions.find((item) => item.name === "Color palette");
  const palette = paletteGroup(definitions);
  assert.equal(definitions.some((item) => item.heading === "Import Base16 theme"), false);
  assert.ok(page.items.some((item) => item.heading === "Import Base16 theme"));
  assert.deepEqual(palette.items.slice(1).map((item) => item.name), Array.from({ length: 16 }, (_, i) => `Color ${i + 1}`));
  const headings = definitions.find((item) => item.heading === "Headings");
  const h1 = headings.items.find((item) => item.desc?.includes("Text color for H1 headings."));
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
  const row = {
    addExtraButton(configure) { configure(extra); return this; },
    addButton(configure) { configure(button); return this; },
  };
  h1.render(row);
  assert.match(element.attributes["aria-label"], /Existing color: rgb\(10 20 30 \/ 0.5\)/);
  assert.deepEqual(element.children[0].props, { "--theme-basics-swatch-color": "rgb(10 20 30 / 0.5)" });
  button.click();
  const modal = SuggestModal.latest;
  const choices = modal.getSuggestions("");
  assert.equal(choices.find((choice) => choice.value === "legacy").selected, true);
  assert.equal(choices.find((choice) => choice.value === "12").label, "Color 13 (not set)");
  modal.onChooseSuggestion(choices.find((choice) => choice.value === "12"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.settings.colorAssignments.light.h1Color, 12);
  assert.equal(plugin.getProfile("light").h1Color, "");
  await extra.click();
  assert.equal(plugin.settings.colorAssignments.light.h1Color, undefined);
  assert.match(element.attributes["aria-label"], /Inherit theme default/);
});

test("loading malformed or newer palette settings never overwrites saved data", async () => {
  const { plugin, writes, DEFAULT_SETTINGS } = fixture();
  const bad = structuredClone(DEFAULT_SETTINGS);
  bad.palettes.light[0] = "not-a-color";
  plugin.loadData = async () => bad;
  await assert.rejects(plugin.loadSettings(), /palette/i);
  assert.deepEqual(writes, []);
  plugin.loadData = async () => ({ version: 4, profiles: {} });
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
  const row = {
    setDesc(value) { this.desc = value; return this; },
    addColorPicker(configure) { configure(picker); return this; },
    addButton(configure) { configure(button); return this; },
  };
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
  const row = {
    setDesc() { return this; }, addColorPicker(configure) { configure(picker); return this; },
    addButton() { return this; },
  };
  const cleanup = paletteGroup(definitions).items[1].render(row);
  const dropdown = {
    addOption() { return this; }, setValue() { return this; },
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
    const row = {
      setDesc() { return this; }, addColorPicker(configure) { configure(picker); return this; },
      addButton() { return this; },
    };
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

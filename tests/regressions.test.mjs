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
  assert.equal(plugin.getProfile("light").backgroundPrimary, "#abcdef");
  assert.equal(plugin.getProfile("light").backgroundSecondary, "#123456");
  assert.equal(plugin.getProfile("light").linkColor, "#0000ff");
  assert.equal(plugin.getProfile("light").highlightBackground, "rgba(254, 220, 186, 0.3)");
  assert.equal(plugin.getProfile("dark").backgroundPrimary, "");
});

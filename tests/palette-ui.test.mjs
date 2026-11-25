/* global app */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bundlePlugin } from './harness.mjs';

const vault = process.env.OBSIDIAN_TEST_VAULT;
if (!vault) throw new Error('Set OBSIDIAN_TEST_VAULT to an open vault with Theme Basics enabled.');

async function rendererChecks(bundle, styles) {
  // Use real Obsidian Setting controls, but keep the fixture and writes isolated.
  const liveTab = app.plugins.plugins['theme-basics']?.settingsTab;
  if (!liveTab || typeof liveTab.getSettingDefinitions !== 'function') throw new Error('Enable Theme Basics in the test vault before running this test.');
  const RealPluginSettingTab = Object.getPrototypeOf(Object.getPrototypeOf(liveTab)).constructor;
  let Setting, ColorComponent, ButtonComponent, TextComponent;
  class ProbeTab extends RealPluginSettingTab {
    getSettingDefinitions() {
      return [{ name: 'probe', render: (setting) => {
        Setting = setting.constructor;
        setting.addColorPicker((picker) => { ColorComponent = picker.constructor; });
        setting.addText((text) => { TextComponent = text.constructor; });
        setting.addButton((button) => { ButtonComponent = button.constructor; });
      } }];
    }
  }
  // update() renders rows only into app.setting, so the probe needs the same detached host as the fixtures below.
  const probeHostEl = activeDocument.body.createDiv({ cls: 'theme-basics-offscreen' });
  const probeHost = Object.create(Object.getPrototypeOf(liveTab.app.setting));
  Object.assign(probeHost, { containerEl: probeHostEl, pageStack: [], tabContentContainer: probeHostEl,
    refreshSearch() {}, updatePageTitle() {} });
  const probeApp = Object.create(liveTab.app);
  Object.assign(probeApp, { setting: probeHost });
  const probeTab = new ProbeTab(probeApp, liveTab.plugin);
  probeTab.containerEl.isShown = () => true;
  probeHost.activeTab = probeTab;
  probeHostEl.append(probeTab.containerEl);
  try { probeTab.update(); }
  finally { probeHostEl.remove(); }
  if (!Setting || !ColorComponent || !ButtonComponent || !TextComponent) throw new Error('Could not obtain Obsidian UI constructors.');
  const quickSwitcher = app.internalPlugins.plugins.switcher?.instance?.QuickSwitcherModal;
  if (!quickSwitcher) throw new Error('Enable the Quick Switcher core plugin to run palette modal checks.');
  const SuggestModal = Object.getPrototypeOf(Object.getPrototypeOf(quickSwitcher));
  const notices = [];
  const fakeApi = {
    Setting, SuggestModal, ColorComponent, ButtonComponent, TextComponent,
    debounce: (fn) => Object.assign(fn, { cancel() {} }),
    Notice: class { constructor(message) { notices.push(message); } },
    Plugin: class { constructor(app) { this.app = app; this.manifest = { name: 'Theme Basics UI Test', id: 'theme-basics-ui-test' }; } },
    PluginSettingTab: RealPluginSettingTab,
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', bundle)((id) => {
    if (id !== 'obsidian') throw new Error(`Unexpected module ${id}`);
    return fakeApi;
  }, module, module.exports);
  const { Plugin, SettingsTab, StyleManager, DEFAULT_SETTINGS } = module.exports;
  const tick = () => new Promise((resolve) => activeWindow.setTimeout(resolve, 30));
  const results = {};
  if (typeof RealPluginSettingTab.prototype.update !== 'function') throw new Error('Obsidian has no declarative settings API.');
  for (const path of ['declarative']) {
    const fixtureApp = Object.create(app);
    const host = Object.create(Object.getPrototypeOf(app.setting));
    const hostEl = activeDocument.body.createDiv({ cls: 'theme-basics-offscreen' });
    Object.assign(host, { containerEl: hostEl, pageStack: [], tabContentContainer: hostEl,
      refreshSearch() {}, updatePageTitle() {} });
    Object.assign(fixtureApp, { isDarkMode: () => false, vault: { configDir: '.test-config' }, setting: host });
    const plugin = new Plugin(fixtureApp);
    plugin.settings = structuredClone(DEFAULT_SETTINGS);
    plugin.settings.profiles.light.h1Color = 'rgba(1, 2, 3, 0.3)';
    plugin.settings.profiles.light.h2Color = 'oklch(60% 0.2 30)';
    let saves = 0;
    plugin.saveData = async () => { saves++; };
    const importSettingsFile = plugin.importSettingsJson.bind(plugin);
    const exportSettingsFile = plugin.exportSettingsJson.bind(plugin);
    const rootActions = [];
    plugin.exportSettingsJson = () => rootActions.push('export');
    plugin.importSettingsJson = () => rootActions.push('import');
    plugin.exportCssSnippet = async () => { rootActions.push('snippet'); };
    const colorResolver = new StyleManager(plugin);
    plugin.styleManager = {
      applyStyles() {}, getDefaultNumericValue(_m, _k, _v, fallback) { return fallback; },
      ensureWithinRange(value) { return value; },
      tryToPickerHex(value) { return colorResolver.tryToPickerHex(value); },
      colorsMatch(first, second) { return colorResolver.colorsMatch(first, second); },
    };
    const tab = new SettingsTab(plugin.app, plugin);
    plugin.settingsTab = tab;
    tab.containerEl.isShown = () => true;
    hostEl.append(tab.containerEl);
    host.activeTab = tab;
    const render = () => tab.update();
    const content = () => host.getCurrentPageEl();
    // Synchronous lookup on the open page; blocks navigate first with goto().
    const row = (name) => [...content().querySelectorAll('.setting-item')].find((el) => el.querySelector('.setting-item-name')?.textContent === name);
    const fire = async (el, type = 'change') => { el.dispatchEvent(new Event(type, { bubbles: true })); await tick(); };
    const click = async (el) => { el.click(); await tick(); };
    const selectButton = (el) => el.querySelector('.theme-basics-color-select');
    const swatch = (el) => {
      const element = el.querySelector('.theme-basics-color-swatch');
      return { color: element?.style.getPropertyValue('--theme-basics-swatch-color') ?? null,
        unset: element?.classList.contains('is-unset') ?? null };
    };
    const openChoices = async (el) => {
      await click(selectButton(el));
      const modal = tab.activeColorModal;
      if (!modal) throw new Error('Color selector did not open a modal');
      await tick();
      return modal;
    };
    const choiceElements = (modal) => [...modal.resultContainerEl.querySelectorAll('.theme-basics-color-suggestion')];
    const choose = async (modal, label) => {
      const option = choiceElements(modal).find((el) => el.textContent.replace('Current', '').trim() === label);
      if (!option) throw new Error(`Missing option ${label}`);
      await click(option);
    };
    const stylesheet = activeDocument.head.createEl('style');
    stylesheet.textContent = styles;
    try {
      render();
      // Reopening a hidden tab: the settings modal tears rows down, calls
      // hide(), then renderTab() re-renders the cached definitions without a
      // new getSettingDefinitions() call.
      const opensChoices = async (button) => {
        await click(button);
        const opened = Boolean(tab.activeColorModal);
        tab.activeColorModal?.close();
        await tick();
        return opened;
      };
      const teardown = (items) => {
        for (const item of items ?? []) {
          if (item.children) teardown(item.children);
          const cleanup = item.cleanup;
          item.cleanup = undefined;
          cleanup?.();
        }
      };
      // Hiding leaves any open sub-page; the next lookup must start from the root.
      const hideTab = () => {
        tab.hide();
        host.clearPageStack();
        currentPage = null;
      };
      const reopenTab = () => {
        teardown(tab.renderedItems);
        tab.renderedItems = [];
        hideTab();
        if (typeof tab.renderTab !== 'function') throw new Error('Obsidian has no renderTab() on the settings tab.');
        tab.renderTab();
      };
      // Settings sub-pages: each is opened from its root entry and left via its back control.
      // `currentPage` tracks which page (root entry name) is open, or null on the root.
      let currentPage = null;
      const settle = () => new Promise((resolve) => activeWindow.setTimeout(resolve, 350));
      const pageMarker = {
        'Color palette': 'Color 1', Backgrounds: 'Primary background', 'Links and emphasis': 'Internal link color',
        Typography: 'Base font size', Headings: 'H1', Advanced: 'Tag border color', 'Import / Export': 'Export settings',
      };
      const goto = async (name) => {
        if (currentPage === name) return;
        if (currentPage !== null) {
          const backButton = content().querySelector('.setting-page-back-button');
          if (!backButton) throw new Error('Settings page has no back button');
          await click(backButton);
          await settle();
          // This minimal detached host lacks the full settings modal's container
          // restoration; attach the real renderer's returned tab for CSS checks.
          if (!tab.containerEl.isConnected) hostEl.append(tab.containerEl);
          if (!row(currentPage)) throw new Error(`Back did not restore the root from ${currentPage}`);
          currentPage = null;
        }
        if (name === null) return;
        const link = row(name);
        if (!link) throw new Error(`Missing ${name} navigation row`);
        await click(link);
        await settle();
        if (!row(pageMarker[name])) throw new Error(`${name} page did not open`);
        currentPage = name;
      };
      const openPalette = () => goto('Color palette');
      const closePalette = () => goto(null);
      const pageNames = ['Color palette', 'Backgrounds', 'Links and emphasis', 'Typography', 'Headings', 'Advanced', 'Import / Export'];
      // Root summary: entry rows for every page; no grouped sections live on the root.
      const rootSummary = () => ({
        pages: pageNames.filter((name) => Boolean(row(name))),
        headedGroups: [...content().querySelectorAll('.setting-group')].filter((el) => el.querySelector('.setting-item-heading')).length,
        sections: content().querySelectorAll('.theme-basics-section').length,
      });
      const h1Row = () => [...content().querySelectorAll('.setting-item')].find((el) => el.querySelector('.setting-item-description')?.textContent.includes('Text color for H1 headings.'));

      await goto('Backgrounds');
      const reopen = { beforeHide: await opensChoices(selectButton(row('Primary background'))) };
      const hiddenButton = selectButton(row('Primary background'));
      reopenTab();
      await goto('Backgrounds');
      reopen.afterReopen = await opensChoices(selectButton(row('Primary background')));
      reopen.hiddenButton = await opensChoices(hiddenButton);
      reopenTab();
      await goto('Backgrounds');
      reopen.afterSecondReopen = await opensChoices(selectButton(row('Primary background')));
      reopen.saves = saves;
      render();
      await goto(null);
      const root = { hasPaletteLink: Boolean(row('Color palette')),
        pickers: content().querySelectorAll('input[type=color]').length,
        base16: Boolean(row('Base16 YAML')), profile: Boolean(row('Profile to edit')), ...rootSummary() };
      const rootRefreshers = tab.colorControlRefreshers.size;
      await goto('Import / Export');
      const staleRootActions = ['Export settings', 'Import settings', 'Export as CSS snippet']
        .map((name) => row(name).querySelector('button'));
      await goto('Headings');
      const headings = { levels: [...content().querySelectorAll('.setting-item-heading .setting-item-name')]
        .map((el) => el.textContent).filter((name) => /^H[1-6]$/.test(name)), h1Color: Boolean(h1Row()) };
      await goto(null);
      headings.backRoot = rootSummary();
      await goto('Headings');
      let h1row = h1Row();
      let h1button = selectButton(h1row);
      const h2Row = () => [...content().querySelectorAll('.setting-item')].find((el) => el.querySelector('.setting-item-description')?.textContent.includes('Text color for H2 headings.'));
      const legacy = { label: h1button.textContent, swatch: swatch(h1button),
        resolved: plugin.getResolvedProfile('light').h1Color,
        computed: getComputedStyle(h1button.querySelector('.theme-basics-color-swatch')).backgroundColor,
        picker: h1row.querySelector('input[type=color]').value,
        modern: plugin.getProfile('light').h2Color, modernPicker: h2Row().querySelector('input[type=color]').value,
        initialSaves: saves };
      const legacyModal = await openChoices(h1row);
      const legacyChoices = choiceElements(legacyModal).map((el) => ({ label: el.textContent.trim(), swatch: swatch(el) }));
      await choose(legacyModal, 'Custom');
      legacy.afterCustom = plugin.getProfile('light').h1Color;
      legacy.afterCustomSaves = saves;
      const commitPreview = [...h1row.querySelectorAll('.theme-basics-custom-color button')].find((el) => el.textContent === 'Set');
      legacy.hasCommit = Boolean(commitPreview);
      if (!commitPreview) throw new Error('Missing Set control for the custom color');
      await click(commitPreview);
      h1row = h1Row();
      h1button = selectButton(h1row);
      legacy.afterApply = plugin.getResolvedProfile('light').h1Color;
      legacy.afterApplySaves = saves;
      legacy.afterApplyButton = Boolean(h1row.querySelector('.theme-basics-custom-color button'));
      legacy.modernAfterApply = plugin.getProfile('light').h2Color;
      await choose(await openChoices(h1row), 'Color 2 (not set)');
      const emptySlot = { assignment: plugin.settings.colorAssignments.light.h1Color,
        literal: plugin.settings.profiles.light.h1Color, resolved: plugin.getResolvedProfile('light').h1Color,
        swatch: swatch(h1button) };
      const leavingModal = await openChoices(h1row);
      const staleRootChoice = leavingModal.getSuggestions('').find((choice) => choice.value === '12');
      await openPalette();
      leavingModal.onChooseSuggestion(staleRootChoice);
      await tick();
      const page = { profile: Boolean(row('Profile to edit')), base16: Boolean(row('Base16 YAML')),
        rootSettingsVisible: Boolean(row('Primary background')), refreshers: tab.colorControlRefreshers.size,
        nativePage: host.pageStack.length, modalClosed: tab.activeColorModal === null,
        staleRootAssignment: plugin.settings.colorAssignments.light.h1Color,
        // Section descriptions need top spacing on the subpage too (it renders outside the tab container).
        sectionIntroPadding: [...content().querySelectorAll('.setting-items > .setting-item-heading:first-child')]
          .map((el) => getComputedStyle(el).paddingTop) };
      await click(h1button);
      page.staleRootModalOpened = Boolean(tab.activeColorModal);
      for (const action of staleRootActions) await click(action);
      page.staleRootActions = [...rootActions];
      const rows = [...content().querySelectorAll('.setting-item')].filter((el) => /^Color \d+$/.test(el.querySelector('.setting-item-name')?.textContent ?? ''));
      const initial = {
        labels: rows.map((el) => el.querySelector('.setting-item-name').textContent),
        pickers: rows.filter((el) => el.querySelector('input[type=color]')).length,
        unset: rows.filter((el) => el.querySelector('.setting-item-description')?.textContent.includes('Not set.')).length,
        setButtons: rows.filter((el) => [...el.querySelectorAll('button')].some((button) => button.textContent === 'Set')).length,
        palette: [...plugin.settings.palettes.light],
      };
      const color2 = row('Color 2');
      const color2Shown = color2.querySelector('input[type=color]').value;
      const setButton = [...color2.querySelectorAll('button')].find((button) => button.textContent === 'Set');
      await click(setButton);
      const color1 = row('Color 1');
      const stalePicker = color1.querySelector('input[type=color]');
      const staleProfile = row('Profile to edit').querySelector('select');
      const staleTextarea = row('Base16 YAML').querySelector('textarea');
      stalePicker.value = '#123456';
      await fire(stalePicker, 'input');
      await fire(stalePicker, 'change');
      const afterEdit = { value: plugin.settings.palettes.light[0], description: color1.querySelector('.setting-item-description').textContent };
      await closePalette();
      stalePicker.value = '#999999';
      await fire(stalePicker, 'input');
      await fire(stalePicker, 'change');
      staleProfile.value = 'dark';
      await fire(staleProfile);
      staleTextarea.value = 'base00: "999999"';
      await fire(staleTextarea, 'input');
      const stalePage = { color: plugin.settings.palettes.light[0], mode: plugin.settings.uiProfile,
        yaml: tab.base16Yaml, refreshers: tab.colorControlRefreshers.size };
      await goto('Headings');
      const afterSet = { shown: color2Shown, stored: plugin.settings.palettes.light[1],
        resolved: plugin.getResolvedProfile('light').h1Color, swatch: swatch(selectButton(h1Row())) };
      await goto('Backgrounds');
      const bg = row('Primary background');
      const bgButton = selectButton(bg);
      const modal = await openChoices(bg);
      const options = choiceElements(modal).map((option) => ({ label: option.textContent.trim(), swatch: swatch(option) }));
      await choose(modal, 'Color 1');
      const afterSelect = { assignment: plugin.settings.colorAssignments.light.backgroundPrimary,
        resolved: plugin.getResolvedProfile('light').backgroundPrimary, selected: bgButton.textContent, swatch: swatch(bgButton),
        accessible: bgButton.getAttribute('aria-label'),
        computed: getComputedStyle(bgButton.querySelector('.theme-basics-color-swatch')).backgroundColor };
      await openPalette();
      const updateInput = row('Color 1').querySelector('input[type=color]');
      updateInput.value = '#345678';
      await fire(updateInput, 'input');
      await fire(updateInput, 'change');
      await goto('Backgrounds');
      const afterUpdate = { swatch: swatch(selectButton(row('Primary background'))), resolved: plugin.getResolvedProfile('light').backgroundPrimary };
      const currentModal = await openChoices(row('Primary background'));
      const current = choiceElements(currentModal).filter((el) => el.querySelector('.theme-basics-color-current'))
        .map((el) => ({ label: el.textContent.trim(), swatch: swatch(el) }));
      currentModal.close();
      const keyboardModal = await openChoices(row('Primary background'));
      keyboardModal.inputEl.value = 'Color 13';
      await fire(keyboardModal.inputEl, 'input');
      keyboardModal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      const keyboard = { assignment: plugin.settings.colorAssignments.light.backgroundPrimary,
        open: Boolean(tab.activeColorModal), selected: selectButton(row('Primary background')).textContent };
      if (tab.activeColorModal) tab.activeColorModal.close();
      await choose(await openChoices(row('Primary background')), 'Inherit');
      const afterInherit = { assignment: plugin.settings.colorAssignments.light.backgroundPrimary ?? null,
        resolved: plugin.getResolvedProfile('light').backgroundPrimary, selected: selectButton(row('Primary background')).textContent,
        swatch: swatch(selectButton(row('Primary background'))) };
      await choose(await openChoices(row('Primary background')), 'Color 1');
      await openPalette();
      const profile = row('Profile to edit').querySelector('select');
      profile.value = 'dark';
      await fire(profile);
      const dark = { mode: plugin.settings.uiProfile, picker: row('Color 1').querySelector('input[type=color]').value,
        description: row('Color 1').querySelector('.setting-item-description').textContent,
        pageStillOpen: Boolean(row('Base16 YAML')) };
      await goto('Backgrounds');
      dark.assignment = selectButton(row('Primary background')).textContent;
      await openPalette();
      const back = row('Profile to edit').querySelector('select');
      back.value = 'light';
      await fire(back);
      const light = { picker: row('Color 1').querySelector('input[type=color]').value,
        pageStillOpen: Boolean(row('Base16 YAML')) };
      await goto('Backgrounds');
      light.assignment = selectButton(row('Primary background')).textContent;
      await goto('Headings');
      light.heading = selectButton(h1Row()).textContent;
      await openPalette();
      const textarea = row('Base16 YAML').querySelector('textarea');
      textarea.value = 'base00: "abcdef"\nbase0C: "fedcba"';
      await fire(textarea, 'input');
      const apply = [...content().querySelectorAll('button')].find((el) => el.textContent === 'Apply to Light profile');
      await click(apply);
      const imported = { palette: [plugin.settings.palettes.light[0], plugin.settings.palettes.light[12]],
        picker1: row('Color 1').querySelector('input[type=color]').value,
        picker13: row('Color 13').querySelector('input[type=color]').value,
        untouched: plugin.settings.palettes.light[1],
        headingAssignment: plugin.settings.colorAssignments.light.h1Color,
        darkPalette: plugin.settings.palettes.dark[0],
        textareaResize: getComputedStyle(row('Base16 YAML').querySelector('textarea')).resize,
        pageStillOpen: Boolean(row('Base16 YAML')) };
      await goto('Backgrounds');
      imported.assignment = selectButton(row('Primary background')).textContent;
      imported.resolved = plugin.getResolvedProfile('light').backgroundPrimary;
      imported.swatch = swatch(selectButton(row('Primary background')));

      // Exercise custom tag border independently from a shared palette slot.
      await goto('Advanced');
      const tagRow = () => row('Tag border color');
      await choose(await openChoices(tagRow()), 'Color 1');
      await choose(await openChoices(tagRow()), 'Custom');
      const customInput = tagRow().querySelector('input[type=color]');
      const custom = { seed: customInput.value, seededLiteral: plugin.getProfile('light').tagBorderColor,
        seededAssignment: plugin.settings.colorAssignments.light.tagBorderColor ?? null,
        pickerLabel: customInput.getAttribute('aria-label') };
      customInput.value = '#89abcd';
      await fire(customInput, 'input');
      await fire(customInput, 'change');
      custom.beforeCommit = plugin.getResolvedProfile('light').tagBorderColor;
      custom.paletteBeforeCommit = plugin.settings.palettes.light.length;
      await click([...tagRow().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      custom.edited = plugin.getResolvedProfile('light').tagBorderColor;
      custom.paletteAfterCommit = plugin.settings.palettes.light.length;
      await plugin.setPaletteColor('light', 0, '#445566');
      await plugin.applyBase16Theme('base00: "778899"', 'light');
      custom.afterPalette = plugin.getResolvedProfile('light').tagBorderColor;
      custom.sharedAfterPalette = plugin.getResolvedProfile('light').backgroundPrimary;
      const profileRoot = row('Profile to edit').querySelector('select');
      profileRoot.value = 'dark';
      await fire(profileRoot);
      const savesBeforeCustom = saves;
      await choose(await openChoices(tagRow()), 'Custom');
      const darkInput = tagRow().querySelector('input[type=color]');
      custom.darkUnset = { literal: plugin.getProfile('dark').tagBorderColor, writes: saves - savesBeforeCustom,
        hasSet: Boolean([...tagRow().querySelectorAll('button')].find((el) => el.textContent === 'Set')) };
      darkInput.value = '#000000';
      await click([...tagRow().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      custom.darkSet = { color: plugin.getResolvedProfile('dark').tagBorderColor, shown: darkInput.value,
        light: plugin.getResolvedProfile('light').tagBorderColor };
      await choose(await openChoices(tagRow()), 'Color 8 (not set)');
      await choose(await openChoices(tagRow()), 'Custom');
      custom.emptySlot = { literal: plugin.getProfile('dark').tagBorderColor,
        assignment: plugin.settings.colorAssignments.dark.tagBorderColor ?? null,
        hasSet: Boolean([...tagRow().querySelectorAll('button')].find((el) => el.textContent === 'Set')) };
      tagRow().querySelector('input[type=color]').value = '#000000';
      await click([...tagRow().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      custom.emptySlotSet = plugin.getResolvedProfile('dark').tagBorderColor;
      const profileBack = row('Profile to edit').querySelector('select');
      profileBack.value = 'light';
      await fire(profileBack);
      custom.restored = { color: plugin.getResolvedProfile('light').tagBorderColor,
        picker: Boolean(tagRow().querySelector('input[type=color]')) };
      customInput.value = '#999999';
      await fire(customInput, 'input');
      await fire(customInput, 'change');
      custom.staleAfterProfileSwitch = plugin.getResolvedProfile('light').tagBorderColor;
      const previousPicker = customInput;
      await choose(await openChoices(tagRow()), 'Color 1');
      custom.slot = { assignment: plugin.settings.colorAssignments.light.tagBorderColor,
        literal: plugin.getProfile('light').tagBorderColor, picker: Boolean(tagRow().querySelector('input[type=color]')) };
      previousPicker.value = '#111111';
      await fire(previousPicker, 'input');
      await fire(previousPicker, 'change');
      custom.staleAfterSlot = { assignment: plugin.settings.colorAssignments.light.tagBorderColor,
        literal: plugin.getProfile('light').tagBorderColor };
      await plugin.setPaletteColor('light', 0, '#abcdef');
      await choose(await openChoices(tagRow()), 'Custom');
      custom.reseeded = tagRow().querySelector('input[type=color]').value;
      previousPicker.value = '#222222';
      await fire(previousPicker, 'input');
      await fire(previousPicker, 'change');
      custom.staleAfterReselect = plugin.getResolvedProfile('light').tagBorderColor;
      await click(tagRow().querySelector('.extra-setting-button'));
      custom.reset = { literal: plugin.getProfile('light').tagBorderColor,
        assignment: plugin.settings.colorAssignments.light.tagBorderColor ?? null,
        picker: Boolean(tagRow().querySelector('input[type=color]')),
        label: selectButton(tagRow()).textContent };

      await goto('Backgrounds');
      const importedModal = await openChoices(row('Primary background'));
      const importedChoices = choiceElements(importedModal).map((el) => ({ label: el.textContent.trim(), swatch: swatch(el) }));
      const modalAccessibility = { filterLabel: importedModal.inputEl.getAttribute('aria-label'),
        selectLabel: selectButton(row('Primary background')).getAttribute('aria-label'),
        expanded: selectButton(row('Primary background')).getAttribute('aria-expanded') };
      const staleChoice = importedModal.getSuggestions('').find((choice) => choice.value === '12');
      const buttonBeforeHide = selectButton(row('Primary background'));
      hideTab();
      importedModal.onChooseSuggestion(staleChoice);
      await tick();
      const afterHide = { modalClosed: tab.activeColorModal === null,
        assignment: plugin.settings.colorAssignments.light.backgroundPrimary,
        expanded: buttonBeforeHide.getAttribute('aria-expanded') };
      render();
      await openPalette();
      const commands = new Map();
      plugin.addCommand = (command) => commands.set(command.id, command);
      plugin.registerCommands();
      await commands.get('reset-current-profile-overrides').callback();
      await tick();
      const afterReset = { pageStillOpen: Boolean(row('Base16 YAML')),
        palette: plugin.settings.palettes.light[0], assignment: plugin.settings.colorAssignments.light.backgroundPrimary ?? null,
        setButton: Boolean([...row('Color 1').querySelectorAll('button')].find((button) => button.textContent === 'Set')) };
      await plugin.setPaletteColor('light', 0, '#123456');
      await plugin.setPaletteColor('dark', 0, '#abcdef');
      await commands.get('reset-all-overrides').callback();
      await tick();
      const afterAllReset = { pageStillOpen: Boolean(row('Base16 YAML')),
        light: plugin.settings.palettes.light[0], dark: plugin.settings.palettes.dark[0],
        setButton: Boolean([...row('Color 1').querySelectorAll('button')].find((button) => button.textContent === 'Set')) };
      await closePalette();
      await openPalette();
      await closePalette();
      const afterRepeat = { refreshers: tab.colorControlRefreshers.size, rootRefreshers };
      await openPalette();
      const hiddenPicker = row('Color 1').querySelector('input[type=color]');
      hideTab();
      hiddenPicker.value = '#fedcba';
      await fire(hiddenPicker, 'input');
      await fire(hiddenPicker, 'change');
      const afterPageHide = { color: plugin.settings.palettes.light[0] };
      if (!tab.containerEl.isConnected) hostEl.append(tab.containerEl);
      render();
      afterPageHide.rootRestored = Boolean(row('Color palette')) && !row('Color 1');
      await openPalette();
      const disposedPicker = row('Color 1').querySelector('input[type=color]');
      tab.dispose();
      disposedPicker.value = '#fedcba';
      await fire(disposedPicker, 'input');
      await fire(disposedPicker, 'change');
      const afterDispose = { color: plugin.settings.palettes.light[0] };

      // Unset Custom is UI state, retained across row rebuilds but never saved
      // as the native input's implicit preview color.
      hideTab();
      if (!tab.containerEl.isConnected) hostEl.append(tab.containerEl);
      render();
      await goto('Advanced');
      const pendingTag = () => row('Tag border color');
      const pendingState = () => ({
        label: selectButton(pendingTag()).textContent,
        picker: Boolean(pendingTag().querySelector('input[type=color]')),
        set: Boolean([...pendingTag().querySelectorAll('button')].find((el) => el.textContent === 'Set')),
        literal: plugin.getProfile(plugin.settings.uiProfile).tagBorderColor,
        assignment: plugin.settings.colorAssignments[plugin.settings.uiProfile].tagBorderColor ?? null,
      });
      const switchProfile = async (mode) => {
        const control = row('Profile to edit').querySelector('select');
        control.value = mode;
        await fire(control);
      };
      const pending = {};
      const beforePending = saves;
      await choose(await openChoices(pendingTag()), 'Custom');
      pending.fromInherit = pendingState();
      pending.fromInheritWrites = saves - beforePending;
      pending.noPersistedState = !Object.hasOwn(plugin.settings, 'pendingCustom');
      await choose(await openChoices(pendingTag()), 'Color 8 (not set)');
      pending.slotSelection = pendingState();
      await choose(await openChoices(pendingTag()), 'Inherit');
      pending.inheritSelection = pendingState();
      await choose(await openChoices(pendingTag()), 'Custom');
      await switchProfile('dark');
      pending.otherProfileInitially = pendingState();
      await choose(await openChoices(pendingTag()), 'Custom');
      await switchProfile('light');
      pending.afterProfileSwitch = pendingState();
      await openPalette();
      await goto('Advanced');
      pending.afterPageNavigation = pendingState();
      await switchProfile('dark');
      pending.darkAfterSwitch = pendingState();
      const darkPendingPicker = pendingTag().querySelector('input[type=color]');
      darkPendingPicker.value = '#000000';
      await click([...pendingTag().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      pending.darkExplicitBlack = pendingState();
      await switchProfile('light');
      pending.lightAfterDarkSet = pendingState();
      await click(pendingTag().querySelector('.extra-setting-button'));
      pending.settingReset = pendingState();
      await choose(await openChoices(pendingTag()), 'Color 8 (not set)');
      await choose(await openChoices(pendingTag()), 'Custom');
      pending.fromUnsetSlot = pendingState();
      await openPalette();
      await goto('Advanced');
      pending.unsetSlotAfterPage = pendingState();
      const unsetPicker = pendingTag().querySelector('input[type=color]');
      unsetPicker.value = '#000000';
      await click([...pendingTag().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      pending.unsetSlotExplicitBlack = pendingState();
      await click(pendingTag().querySelector('.extra-setting-button'));
      await choose(await openChoices(pendingTag()), 'Custom');
      await switchProfile('dark');
      await click(pendingTag().querySelector('.extra-setting-button'));
      await choose(await openChoices(pendingTag()), 'Custom');
      await switchProfile('light');
      await goto(null);
      await click(row('Reset Light profile').querySelector('button'));
      await goto('Advanced');
      pending.profileResetLight = pendingState();
      await switchProfile('dark');
      pending.profileResetOther = pendingState();
      await goto(null);
      await click(row('Reset both profiles').querySelector('button'));
      await goto('Advanced');
      pending.bothResetDark = pendingState();
      await switchProfile('light');
      pending.bothResetLight = pendingState();
      await choose(await openChoices(pendingTag()), 'Custom');
      try { await plugin.importSettings('{}'); } catch { /* Invalid imports must not clear pending choices. */ }
      await switchProfile('dark');
      await switchProfile('light');
      pending.failedImport = pendingState();
      await switchProfile('dark');
      await choose(await openChoices(pendingTag()), 'Custom');
      await plugin.importSettings(JSON.stringify(plugin.settings));
      await tick();
      pending.jsonImportDark = pendingState();
      await switchProfile('light');
      pending.jsonImportLight = pendingState();
      await choose(await openChoices(pendingTag()), 'Custom');
      await switchProfile('dark');
      await choose(await openChoices(pendingTag()), 'Custom');
      await switchProfile('light');
      await plugin.copyProfile('light', 'dark');
      await switchProfile('dark');
      pending.copyTarget = pendingState();
      await choose(await openChoices(pendingTag()), 'Custom');
      await switchProfile('light');
      pending.copySource = pendingState();
      await openPalette();
      const pendingTextarea = row('Base16 YAML').querySelector('textarea');
      pendingTextarea.value = 'base00: "123456"';
      await fire(pendingTextarea, 'input');
      await click([...content().querySelectorAll('button')].find((el) => el.textContent === 'Apply to Light profile'));
      await goto('Advanced');
      pending.base16ImportLight = pendingState();
      await switchProfile('dark');
      pending.base16ImportOther = pendingState();
      await switchProfile('light');
      await choose(await openChoices(pendingTag()), 'Custom');
      hideTab();
      if (!tab.containerEl.isConnected) hostEl.append(tab.containerEl);
      render();
      await goto('Advanced');
      pending.tabHide = pendingState();

      // Interactive background uses the same palette/custom control as other colors.
      await goto('Backgrounds');
      const interactiveRow = () => row('Interactive background');
      const interactive = { description: interactiveRow().querySelector('.setting-item-description').textContent,
        initial: selectButton(interactiveRow()).textContent };
      await plugin.setPaletteColor('light', 9, '#aabbcc');
      await choose(await openChoices(interactiveRow()), 'Color 10');
      interactive.lightPalette = { assignment: plugin.settings.colorAssignments.light.interactiveBackground,
        color: plugin.getResolvedProfile('light').interactiveBackground };
      await choose(await openChoices(interactiveRow()), 'Custom');
      const interactivePicker = interactiveRow().querySelector('input[type=color]');
      interactive.seed = interactivePicker.value;
      interactivePicker.value = '#445566';
      await fire(interactivePicker, 'input');
      await fire(interactivePicker, 'change');
      await click([...interactiveRow().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      interactive.lightCustom = plugin.getResolvedProfile('light').interactiveBackground;
      await switchProfile('dark');
      interactive.darkInitial = selectButton(interactiveRow()).textContent;
      await choose(await openChoices(interactiveRow()), 'Custom');
      const darkInteractivePicker = interactiveRow().querySelector('input[type=color]');
      darkInteractivePicker.value = '#778899';
      await fire(darkInteractivePicker, 'input');
      await fire(darkInteractivePicker, 'change');
      await click([...interactiveRow().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      interactive.darkCustom = plugin.getResolvedProfile('dark').interactiveBackground;
      await switchProfile('light');
      interactive.lightRestored = plugin.getResolvedProfile('light').interactiveBackground;
      await click(interactiveRow().querySelector('.extra-setting-button'));
      interactive.reset = { label: selectButton(interactiveRow()).textContent,
        light: plugin.getResolvedProfile('light').interactiveBackground,
        dark: plugin.getResolvedProfile('dark').interactiveBackground };

      // Form field background is independently editable using the same controls.
      const formRow = () => row('Form field background');
      const formField = { description: formRow().querySelector('.setting-item-description').textContent,
        initial: selectButton(formRow()).textContent };
      await choose(await openChoices(formRow()), 'Color 10');
      formField.lightPalette = { assignment: plugin.settings.colorAssignments.light.formFieldBackground,
        color: plugin.getResolvedProfile('light').formFieldBackground };
      await choose(await openChoices(formRow()), 'Custom');
      const formPicker = formRow().querySelector('input[type=color]');
      formField.seed = formPicker.value;
      formPicker.value = '#112233';
      await fire(formPicker, 'input');
      await fire(formPicker, 'change');
      await click([...formRow().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      formField.lightCustom = plugin.getResolvedProfile('light').formFieldBackground;
      await switchProfile('dark');
      formField.darkInitial = selectButton(formRow()).textContent;
      await choose(await openChoices(formRow()), 'Custom');
      const darkFormPicker = formRow().querySelector('input[type=color]');
      darkFormPicker.value = '#334455';
      await fire(darkFormPicker, 'input');
      await fire(darkFormPicker, 'change');
      await click([...formRow().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      formField.darkCustom = plugin.getResolvedProfile('dark').formFieldBackground;
      formField.darkInteractive = plugin.getResolvedProfile('dark').interactiveBackground;
      await switchProfile('light');
      formField.lightRestored = plugin.getResolvedProfile('light').formFieldBackground;
      await click(formRow().querySelector('.extra-setting-button'));
      formField.reset = { label: selectButton(formRow()).textContent,
        light: plugin.getResolvedProfile('light').formFieldBackground,
        dark: plugin.getResolvedProfile('dark').formFieldBackground };

      // Exercise expanded slots, color text, list import, validation and reuse
      // through the actual controls without touching the installed plugin's data.
      await goto(null);
      await plugin.resetAllSettings();
      tab.refreshDisplayPreserveScroll();
      await tick();
      await openPalette();
      const expanded = {};
      await click(row('Add palette color').querySelector('button'));
      expanded.afterAdd = { count: plugin.settings.palettes.light.length, present: Boolean(row('Color 17')) };
      const manualInput = row('Color 17').querySelector('.theme-basics-palette-text');
      manualInput.value = 'oklch(60% 0.2 30 / 0.5)';
      await fire(manualInput, 'input');
      expanded.beforeManualSet = plugin.settings.palettes.light[16];
      await click([...row('Color 17').querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      expanded.manual = { value: plugin.settings.palettes.light[16], swatch: swatch(row('Color 17')) };
      await goto('Headings');
      await choose(await openChoices(h1Row()), 'Color 17');
      await choose(await openChoices(h2Row()), 'Color 1 (not set)');
      await openPalette();
      const setList = async (format, value) => {
        const formatControl = row('Color list format').querySelector('select');
        formatControl.value = format;
        await fire(formatControl);
        const input = row('Color list').querySelector('textarea');
        input.value = value;
        await fire(input, 'input');
      };
      const importList = async (label) => click([...row('Import colors').querySelectorAll('button')].find((el) => el.textContent === label));
      await setList('csv', '#123456, rgba(1, 2, 3, 0.5)');
      await importList('Append colors');
      expanded.append = { count: plugin.settings.palettes.light.length, last: plugin.settings.palettes.light.slice(-2),
        h1: plugin.getResolvedProfile('light').h1Color, assignment: plugin.settings.colorAssignments.light.h1Color };
      await setList('json', '["#abcdef", "oklch(70% 0.1 40)"]');
      await importList('Replace by position');
      expanded.replace = { count: plugin.settings.palettes.light.length, first: plugin.settings.palettes.light.slice(0, 2),
        h1: plugin.getResolvedProfile('light').h1Color, h2: plugin.getResolvedProfile('light').h2Color,
        assignment: plugin.settings.colorAssignments.light.h1Color, last: plugin.settings.palettes.light.slice(-2) };
      await setList('csv', '#ffffff, invalid-color');
      const beforeInvalid = JSON.stringify(plugin.settings);
      const beforeInvalidSaves = saves;
      await importList('Replace by position');
      expanded.invalid = { unchanged: JSON.stringify(plugin.settings) === beforeInvalid,
        writes: saves - beforeInvalidSaves, notice: notices[notices.length - 1] };
      await setList('csv', '#abcdef');
      const save = plugin.saveData;
      plugin.saveData = async () => { throw new Error('Disk full'); };
      await importList('Append colors');
      plugin.saveData = save;
      expanded.failedSave = { unchanged: JSON.stringify(plugin.settings) === beforeInvalid, notice: notices[notices.length - 1] };
      await goto('Advanced');
      await choose(await openChoices(tagRow()), 'Color 17');
      await choose(await openChoices(tagRow()), 'Custom');
      const customText = () => tagRow().querySelector('.theme-basics-palette-text');
      expanded.seed = { text: customText().value, count: plugin.settings.palettes.light.length,
        color: plugin.getResolvedProfile('light').tagBorderColor };
      customText().value = 'rgb(1 2 3 / 50%)';
      await fire(customText(), 'input');
      expanded.draft = { count: plugin.settings.palettes.light.length,
        color: plugin.getResolvedProfile('light').tagBorderColor };
      await click([...tagRow().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      expanded.reuse = { count: plugin.settings.palettes.light.length, assignment: plugin.settings.colorAssignments.light.tagBorderColor,
        color: plugin.getResolvedProfile('light').tagBorderColor };
      await choose(await openChoices(tagRow()), 'Custom');
      customText().value = 'rgb(1 2 3 / 50.01%)';
      await fire(customText(), 'input');
      expanded.alphaDraft = { count: plugin.settings.palettes.light.length, color: plugin.getResolvedProfile('light').tagBorderColor };
      await click([...tagRow().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      expanded.alphaCommit = { count: plugin.settings.palettes.light.length,
        assignment: plugin.settings.colorAssignments.light.tagBorderColor, color: plugin.getResolvedProfile('light').tagBorderColor,
        shared: plugin.settings.palettes.light[18] };

      // Exercise failures and overlapping UI edits while saves are deferred.
      const races = {};
      const originalSave = plugin.saveData;
      let profileSelect = row('Profile to edit').querySelector('select');
      plugin.saveData = async () => { throw new Error('Disk full'); };
      profileSelect.value = 'dark';
      await fire(profileSelect);
      races.failedProfile = { selected: profileSelect.value, committed: plugin.getEditedProfileMode(), notice: notices.at(-1) };
      plugin.saveData = originalSave;

      // While the profile save is pending the displayed mode must match the
      // still-editable rows, including after a settings rebuild.
      const pendingSwitch = Promise.withResolvers();
      plugin.saveData = () => pendingSwitch.promise;
      profileSelect = row('Profile to edit').querySelector('select');
      profileSelect.value = 'dark';
      await fire(profileSelect);
      const visibleDuringSwitch = { selected: profileSelect.value, disabled: profileSelect.disabled,
        committed: plugin.getEditedProfileMode() };
      tab.refreshDisplayPreserveScroll();
      await tick();
      const rebuiltDuringSwitch = row('Profile to edit').querySelector('select');
      const rebuiltState = { selected: rebuiltDuringSwitch.value, disabled: rebuiltDuringSwitch.disabled,
        committed: plugin.getEditedProfileMode() };
      await choose(await openChoices(tagRow()), 'Color 1');
      pendingSwitch.resolve();
      await tick();
      await tick();
      const committedSelect = row('Profile to edit').querySelector('select');
      races.pendingSwitch = { before: visibleDuringSwitch, rebuilt: rebuiltState,
        after: { selected: committedSelect.value, disabled: committedSelect.disabled, committed: plugin.getEditedProfileMode() },
        lightAssignment: plugin.settings.colorAssignments.light.tagBorderColor,
        darkAssignment: plugin.settings.colorAssignments.dark.tagBorderColor ?? null };
      plugin.saveData = originalSave;
      await switchProfile('light');
      profileSelect = row('Profile to edit').querySelector('select');

      // A failed older switch must not override a later queued selection.
      const switchWrites = [];
      plugin.saveData = () => new Promise((resolve, reject) => switchWrites.push({ resolve, reject }));
      for (const mode of ['dark', 'light', 'dark']) {
        profileSelect.value = mode;
        await fire(profileSelect);
      }
      switchWrites[0].reject(new Error('First switch failed'));
      await tick();
      const selectedAfterOldFailure = row('Profile to edit').querySelector('select');
      const intermediateSelection = { value: selectedAfterOldFailure.value, disabled: selectedAfterOldFailure.disabled };
      switchWrites[1].resolve();
      await tick();
      switchWrites[2].resolve();
      await tick();
      const finalSelection = row('Profile to edit').querySelector('select');
      races.overlappingProfiles = { afterOldFailure: intermediateSelection,
        selected: finalSelection.value, disabled: finalSelection.disabled, committed: plugin.getEditedProfileMode() };
      plugin.saveData = originalSave;
      await switchProfile('light');

      // Rebuilding the row during a pending switch must still refresh the latest mode.
      const rebuildingSwitch = Promise.withResolvers();
      plugin.saveData = () => rebuildingSwitch.promise;
      const oldProfileSelect = row('Profile to edit').querySelector('select');
      oldProfileSelect.value = 'dark';
      await fire(oldProfileSelect);
      tab.refreshDisplayPreserveScroll();
      await tick();
      rebuildingSwitch.resolve();
      await tick();
      races.rebuiltProfile = { selected: row('Profile to edit').querySelector('select').value,
        committed: plugin.getEditedProfileMode() };
      plugin.saveData = originalSave;
      await switchProfile('light');

      await openPalette();
      const pendingPalette = Promise.withResolvers();
      plugin.saveData = () => pendingPalette.promise;
      const thirdColor = row('Color 3');
      const thirdInput = thirdColor.querySelector('.theme-basics-palette-text');
      thirdInput.value = '#334455';
      await fire(thirdInput, 'input');
      thirdColor.querySelector('button').click();
      await tick();
      thirdInput.value = '#667788';
      await fire(thirdInput, 'input');
      pendingPalette.resolve();
      await tick();
      races.palette = { saved: plugin.settings.palettes.light[2], draft: thirdInput.value,
        swatch: swatch(thirdColor), description: thirdColor.querySelector('.setting-item-description').textContent };
      plugin.saveData = async () => { throw new Error('Picker save failed'); };
      const failedPicker = thirdColor.querySelector('input[type=color]');
      failedPicker.value = '#abcdef';
      await fire(failedPicker, 'input');
      await fire(failedPicker, 'change');
      races.failedPicker = { saved: plugin.settings.palettes.light[2], picker: failedPicker.value,
        draft: thirdInput.value, swatch: swatch(thirdColor), notice: notices.at(-1) };
      plugin.saveData = originalSave;
      await click(thirdColor.querySelector('button'));
      races.failedPicker.retry = plugin.settings.palettes.light[2];
      await goto('Advanced');

      await choose(await openChoices(tagRow()), 'Custom');
      let customDraft = tagRow().querySelector('.theme-basics-palette-text');
      customDraft.value = '#334455';
      await fire(customDraft, 'input');
      const pendingCustom = Promise.withResolvers();
      plugin.saveData = () => pendingCustom.promise;
      [...tagRow().querySelectorAll('button')].find((el) => el.textContent === 'Set').click();
      await tick();
      customDraft.value = '#667788';
      await fire(customDraft, 'input');
      pendingCustom.resolve();
      await tick();
      customDraft = tagRow().querySelector('.theme-basics-palette-text');
      races.custom = { saved: plugin.getResolvedProfile('light').tagBorderColor,
        draft: customDraft?.value ?? null, label: selectButton(tagRow()).textContent };
      plugin.saveData = originalSave;

      // A pending palette assignment must not clear a newer Custom draft.
      const pendingAssignment = Promise.withResolvers();
      plugin.saveData = () => pendingAssignment.promise;
      await choose(await openChoices(tagRow()), 'Color 1');
      customDraft = tagRow().querySelector('.theme-basics-palette-text');
      customDraft.value = '#aabbcc';
      await fire(customDraft, 'input');
      pendingAssignment.resolve();
      await tick();
      races.assignmentDraft = { assignment: plugin.settings.colorAssignments.light.tagBorderColor,
        draft: tagRow().querySelector('.theme-basics-palette-text')?.value ?? null,
        label: selectButton(tagRow()).textContent };
      plugin.saveData = originalSave;
      const pendingReset = Promise.withResolvers();
      plugin.saveData = () => pendingReset.promise;
      tagRow().querySelector('.extra-setting-button').click();
      await tick();
      customDraft = tagRow().querySelector('.theme-basics-palette-text');
      customDraft.value = '#ddeeff';
      await fire(customDraft, 'input');
      pendingReset.resolve();
      await tick();
      races.resetDraft = { assignment: plugin.settings.colorAssignments.light.tagBorderColor ?? null,
        draft: tagRow().querySelector('.theme-basics-palette-text')?.value ?? null,
        label: selectButton(tagRow()).textContent };
      plugin.saveData = originalSave;
      await click(tagRow().querySelector('.extra-setting-button'));

      // Intercept only creation of detached file inputs; never open a real OS
      // dialog or change the user's live plugin settings.
      await openPalette();
      const descriptor = Object.getOwnPropertyDescriptor(activeDocument, 'createElement');
      const createElement = activeDocument.createElement;
      const captureFileInput = async (open, expectedTag = 'input') => {
        let captured;
        activeDocument.createElement = function (tag, options) {
          const element = createElement.call(this, tag, options);
          if (tag === expectedTag) element.click = () => {
            if (tag === 'a' || element.type === 'file') captured = element;
          };
          return element;
        };
        try { await open(); }
        finally {
          if (descriptor) Object.defineProperty(activeDocument, 'createElement', descriptor);
          else delete activeDocument.createElement;
        }
        if (!captured) throw new Error('File input was not created');
        return captured;
      };
      try {
        const loadFile = async (name, contents) => {
          const fileInput = await captureFileInput(() =>
            click([...row('Color list').querySelectorAll('button')].find((el) => el.textContent === 'Load file')));
          const files = new DataTransfer();
          files.items.add(new File([contents], name));
          fileInput.files = files.files;
          await fire(fileInput);
        };
        const fileResults = {};
        await loadFile('colors.csv', '#010203, rgba(1, 2, 3, 0.5)');
        fileResults.csv = { format: row('Color list format').querySelector('select').value,
          text: row('Color list').querySelector('textarea').value };
        await click([...row('Import colors').querySelectorAll('button')].find((el) => el.textContent === 'Append colors'));
        fileResults.append = plugin.settings.palettes.light.slice(-2);
        await loadFile('colors.json', '["#abcdef", "#123456"]');
        fileResults.json = { format: row('Color list format').querySelector('select').value,
          text: row('Color list').querySelector('textarea').value };
        await click([...row('Import colors').querySelectorAll('button')].find((el) => el.textContent === 'Replace by position'));
        fileResults.replace = plugin.settings.palettes.light.slice(0, 2);
        const beforeBadFile = JSON.stringify(plugin.settings);
        await loadFile('bad.json', '["#abcdef", "not-a-color"]');
        await click([...row('Import colors').querySelectorAll('button')].find((el) => el.textContent === 'Append colors'));
        fileResults.invalid = { unchanged: JSON.stringify(plugin.settings) === beforeBadFile, notice: notices.at(-1) };
        const delayedFile = Promise.withResolvers();
        const delayedInput = await captureFileInput(() =>
          click([...row('Color list').querySelectorAll('button')].find((el) => el.textContent === 'Load file')));
        Object.defineProperty(delayedInput, 'files', { configurable: true,
          value: [{ name: 'old.csv', text: () => delayedFile.promise }] });
        delayedInput.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        const newerList = row('Color list').querySelector('textarea');
        newerList.value = '["#654321"]';
        await fire(newerList, 'input');
        const newerFormat = row('Color list format').querySelector('select');
        newerFormat.value = 'json';
        await fire(newerFormat);
        delayedFile.resolve('#abcdef');
        await tick();
        fileResults.newerDraft = { format: row('Color list format').querySelector('select').value,
          text: row('Color list').querySelector('textarea').value };
        const delayedFile2 = Promise.withResolvers();
        const delayedInput2 = await captureFileInput(() =>
          click([...row('Color list').querySelectorAll('button')].find((el) => el.textContent === 'Load file')));
        Object.defineProperty(delayedInput2, 'files', { configurable: true,
          value: [{ name: 'older.csv', text: () => delayedFile2.promise }] });
        delayedInput2.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        await loadFile('newer.json', '["#fedcba"]');
        delayedFile2.resolve('#111111');
        await tick();
        fileResults.newerFile = { format: row('Color list format').querySelector('select').value,
          text: row('Color list').querySelector('textarea').value };
        races.files = fileResults;

        // Exercise the actual settings-file handler with a >1 MB backup, but do
        // not render 110,000 controls in the detached fixture.
        const largeSettings = structuredClone(plugin.settings);
        largeSettings.palettes.dark = Array(110000).fill('#abcdef');
        const largeFile = new File([JSON.stringify(largeSettings)], 'settings.json', { type: 'application/json' });
        const settingsInput = await captureFileInput(() => importSettingsFile());
        const settingsFiles = new DataTransfer();
        settingsFiles.items.add(largeFile);
        settingsInput.files = settingsFiles.files;
        const refresh = tab.refreshDisplayPreserveScroll;
        tab.refreshDisplayPreserveScroll = () => {};
        try {
          settingsInput.dispatchEvent(new Event('change', { bubbles: true }));
          for (let attempts = 0; attempts < 150 && plugin.settings.palettes.dark.length !== 110000; attempts++) await tick();
          races.largeSettingsFile = { size: largeFile.size, colors: plugin.settings.palettes.dark.length,
            last: plugin.settings.palettes.dark.at(-1), notice: notices.at(-1) };
        } finally { tab.refreshDisplayPreserveScroll = refresh; }
        const exportAnchor = await captureFileInput(() => exportSettingsFile(), 'a');
        races.settingsExport = { download: exportAnchor.download, attached: exportAnchor.isConnected,
          activeDocument: exportAnchor.ownerDocument === activeDocument, blob: exportAnchor.href.startsWith('blob:') };
      } finally {
        if (descriptor) Object.defineProperty(activeDocument, 'createElement', descriptor);
        else delete activeDocument.createElement;
      }

      results[path] = { reopen, root, headings, page, stalePage, afterReset, afterAllReset, afterRepeat, afterPageHide, afterDispose, initial, legacy, legacyChoices, emptySlot,
        afterSet, afterEdit, options, afterSelect, afterUpdate, current, keyboard, afterInherit, dark, light,
        imported, importedChoices, modalAccessibility, afterHide, custom, pending, interactive, formField, expanded, races };
    } finally { host.clearPageStack(); tab.dispose(); colorResolver.cleanup(); hostEl.remove(); stylesheet.remove(); }
  }
  return { results };
}
const bundle = await bundlePlugin();
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const code = `JSON.stringify(await (${rendererChecks.toString()})(${JSON.stringify(bundle)}, ${JSON.stringify(styles)}))`;
const output = execFileSync('obsidian', [`vault=${vault}`, 'eval', `code=${code}`], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 }).trim();
const lines = output.split('\n');
const resultLine = lines.findLast((line) => line.startsWith('=> '));
const diagnostics = lines.filter((line) => line !== resultLine);
// Duplicate setting keys make Obsidian's re-render reuse the wrong rows.
if (!resultLine || diagnostics.length) throw new Error(`Obsidian renderer checks failed: ${output}`);
const { results } = JSON.parse(resultLine.slice(3));
for (const path of ['declarative']) {
  test(`${path}: palette opens as a separate page and returns cleanly`, () => {
    assert.deepEqual(results[path].reopen, { beforeHide: true, afterReopen: true, hiddenButton: false,
      afterSecondReopen: true, saves: 0 });
    // Colour rows now live on sub-pages; the root has only profile controls and page entries.
    assert.deepEqual(results[path].root, { hasPaletteLink: true, pickers: 0, base16: false, profile: true,
      pages: ['Color palette', 'Backgrounds', 'Links and emphasis', 'Typography', 'Headings', 'Advanced', 'Import / Export'],
      headedGroups: 0, sections: 0 });
    assert.deepEqual(results[path].headings, { levels: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'], h1Color: true,
      backRoot: { pages: ['Color palette', 'Backgrounds', 'Links and emphasis', 'Typography', 'Headings', 'Advanced', 'Import / Export'],
        headedGroups: 0, sections: 0 } });
    assert.deepEqual(results[path].page, { profile: true, base16: true, rootSettingsVisible: false, refreshers: 0,
      nativePage: 1, modalClosed: true, staleRootAssignment: 1,
      sectionIntroPadding: ['24px', '24px', '24px'],
      staleRootModalOpened: false, staleRootActions: [] });
    assert.equal(results[path].stalePage.color, '#123456');
    assert.equal(results[path].stalePage.mode, 'light');
    assert.equal(results[path].stalePage.yaml, '');
    assert.equal(results[path].stalePage.refreshers, results[path].afterRepeat.rootRefreshers);
    assert.deepEqual(results[path].afterReset, { pageStillOpen: true, palette: '', assignment: null, setButton: true });
    assert.deepEqual(results[path].afterAllReset, { pageStillOpen: true, light: '', dark: '', setButton: true });
    assert.equal(results[path].afterRepeat.refreshers, results[path].afterRepeat.rootRefreshers);
    assert.deepEqual(results[path].afterPageHide, { color: '', rootRestored: true });
    assert.deepEqual(results[path].afterDispose, { color: '' });
  });
  test(`${path}: palette slots use neutral labels, including a newly committed custom color`, () => {
    assert.deepEqual(results[path].initial.labels, Array.from({ length: 17 }, (_, i) => `Color ${i + 1}`));
    assert.equal(results[path].initial.pickers, 17);
    assert.equal(results[path].initial.unset, 16);
    assert.equal(results[path].initial.setButtons, 17);
    assert.deepEqual(results[path].initial.palette, [...Array(16).fill(''), 'rgba(1, 2, 3, 0.3)']);
  });
  test(`${path}: legacy colors persist until selecting an unset slot, then Set activates it`, () => {
    assert.deepEqual(results[path].legacy, { label: 'Custom: rgba(1, 2, 3, 0.3)',
      swatch: { color: 'rgba(1, 2, 3, 0.3)', unset: false }, resolved: 'rgba(1, 2, 3, 0.3)', computed: 'rgba(1, 2, 3, 0.3)',
      picker: '#010203', modern: 'oklch(60% 0.2 30)', modernPicker: '#de3e2d', initialSaves: 0,
      afterCustom: 'rgba(1, 2, 3, 0.3)', afterCustomSaves: 0, hasCommit: true,
      afterApply: 'rgba(1, 2, 3, 0.3)', afterApplySaves: 1, afterApplyButton: false, modernAfterApply: 'oklch(60% 0.2 30)' });
    assert.deepEqual(results[path].legacyChoices[1], { label: 'Custom Current',
      swatch: { color: 'rgba(1, 2, 3, 0.3)', unset: false } });
    assert.deepEqual(results[path].emptySlot, { assignment: 1, literal: '', resolved: '', swatch: { color: '', unset: true } });
    assert.match(results[path].afterSet.shown, /^#[0-9a-f]{6}$/);
    assert.equal(results[path].afterSet.stored, results[path].afterSet.shown);
    assert.equal(results[path].afterSet.resolved, results[path].afterSet.shown);
    assert.deepEqual(results[path].afterSet.swatch, { color: results[path].afterSet.shown, unset: false });
  });
  test(`${path}: Set commits an unchanged translucent custom color as-is`, () => {
    const legacy = results[path].legacy;
    assert.equal(legacy.resolved, 'rgba(1, 2, 3, 0.3)');
    assert.equal(legacy.afterCustom, 'rgba(1, 2, 3, 0.3)');
    assert.equal(legacy.afterCustomSaves, 0);
    assert.equal(legacy.picker, '#010203');
    assert.equal(legacy.hasCommit, true);
    assert.equal(legacy.afterApply, 'rgba(1, 2, 3, 0.3)');
    assert.equal(legacy.afterApplySaves, 1);
    assert.equal(legacy.afterApplyButton, false);
    assert.equal(legacy.modernAfterApply, 'oklch(60% 0.2 30)');
  });
  test(`${path}: picker edit, swatches, assignment and inherit`, () => {
    assert.equal(results[path].afterEdit.value, '#123456');
    assert.match(results[path].afterEdit.description, /All settings assigned/);
    assert.equal(results[path].options.length, 19);
    assert.deepEqual(results[path].options[0], { label: 'Inherit Current', swatch: { color: '', unset: true } });
    assert.deepEqual(results[path].options[1], { label: 'Custom', swatch: { color: '', unset: true } });
    assert.deepEqual(results[path].options[2], { label: 'Color 1', swatch: { color: '#123456', unset: false } });
    assert.deepEqual(results[path].options[3], { label: 'Color 2', swatch: { color: results[path].afterSet.shown, unset: false } });
    for (let i = 3; i <= 16; i++) {
      assert.deepEqual(results[path].options[i + 1], { label: `Color ${i} (not set)`, swatch: { color: '', unset: true } });
    }
    assert.deepEqual(results[path].options[18], { label: 'Color 17', swatch: { color: 'rgba(1, 2, 3, 0.3)', unset: false } });
    assert.deepEqual(results[path].afterSelect, { assignment: 0, resolved: '#123456', selected: 'Color 1',
      swatch: { color: '#123456', unset: false }, accessible: 'Main note and app background. Color 1', computed: 'rgb(18, 52, 86)' });
    assert.deepEqual(results[path].afterUpdate, { swatch: { color: '#345678', unset: false }, resolved: '#345678' });
    assert.deepEqual(results[path].current, [{ label: 'Color 1 Current', swatch: { color: '#345678', unset: false } }]);
    assert.deepEqual(results[path].keyboard, { assignment: 12, open: false, selected: 'Color 13 (not set)' });
    assert.deepEqual(results[path].afterInherit, { assignment: null, resolved: '', selected: 'Inherit',
      swatch: { color: '', unset: true } });
  });
  test(`${path}: custom colors seed from a slot and stay independent`, () => {
    const custom = results[path].custom;
    assert.equal(custom.seed, '#abcdef');
    assert.equal(custom.seededLiteral, '');
    assert.equal(custom.seededAssignment, 0);
    assert.match(custom.pickerLabel, /Custom color for Border color for tags/);
    assert.equal(custom.beforeCommit, '#abcdef');
    assert.equal(custom.paletteBeforeCommit, 17);
    assert.equal(custom.paletteAfterCommit, 18);
    assert.equal(custom.edited, '#89abcd');
    assert.equal(custom.afterPalette, '#89abcd');
    assert.equal(custom.sharedAfterPalette, '#778899');
    assert.deepEqual(custom.darkUnset, { literal: '', writes: 0, hasSet: true });
    assert.equal(custom.darkSet.shown, '#000000');
    assert.equal(custom.darkSet.color, '#000000');
    assert.equal(custom.darkSet.light, '#89abcd');
    assert.deepEqual(custom.emptySlot, { literal: '', assignment: 7, hasSet: true });
    assert.equal(custom.emptySlotSet, '#000000');
    assert.deepEqual(custom.restored, { color: '#89abcd', picker: false });
    assert.equal(custom.staleAfterProfileSwitch, '#89abcd');
    assert.deepEqual(custom.slot, { assignment: 0, literal: '', picker: false });
    assert.deepEqual(custom.staleAfterSlot, { assignment: 0, literal: '' });
    assert.equal(custom.reseeded, '#abcdef');
    assert.equal(custom.staleAfterReselect, '#abcdef');
    assert.deepEqual(custom.reset, { literal: '', assignment: null, picker: false, label: 'Inherit' });
  });
  test(`${path}: interactive background supports palette, custom, profile and reset`, () => {
    assert.match(results[path].interactive.description, /buttons and dropdowns throughout Obsidian/);
    assert.equal(results[path].interactive.initial, 'Inherit');
    assert.deepEqual(results[path].interactive.lightPalette, { assignment: 9, color: '#aabbcc' });
    assert.equal(results[path].interactive.seed, '#aabbcc');
    assert.equal(results[path].interactive.lightCustom, '#445566');
    assert.equal(results[path].interactive.darkInitial, 'Inherit');
    assert.equal(results[path].interactive.darkCustom, '#778899');
    assert.equal(results[path].interactive.lightRestored, '#445566');
    assert.deepEqual(results[path].interactive.reset, { label: 'Inherit', light: '', dark: '#778899' });
  });
  test(`${path}: form field background supports palette, custom, profile and reset`, () => {
    assert.match(results[path].formField.description, /search and other text fields throughout Obsidian/);
    assert.equal(results[path].formField.initial, 'Inherit');
    assert.deepEqual(results[path].formField.lightPalette, { assignment: 9, color: '#aabbcc' });
    assert.equal(results[path].formField.seed, '#aabbcc');
    assert.equal(results[path].formField.lightCustom, '#112233');
    assert.equal(results[path].formField.darkInitial, 'Inherit');
    assert.equal(results[path].formField.darkCustom, '#334455');
    assert.equal(results[path].formField.darkInteractive, '#778899');
    assert.equal(results[path].formField.lightRestored, '#112233');
    assert.deepEqual(results[path].formField.reset, { label: 'Inherit', light: '', dark: '#334455' });
  });
  test(`${path}: pending Custom survives navigation without persisting a color`, () => {
    const pending = results[path].pending;
    const unsetCustom = { label: 'Custom', picker: true, set: true, literal: '', assignment: null };
    const inherit = { label: 'Inherit', picker: false, set: false, literal: '', assignment: null };
    const black = { label: 'Color 17', picker: false, set: false, literal: '', assignment: 16 };
    const unsetSlotCustom = { label: 'Custom', picker: true, set: true, literal: '', assignment: 7 };
    assert.deepEqual(pending.fromInherit, unsetCustom);
    assert.equal(pending.fromInheritWrites, 0);
    assert.equal(pending.noPersistedState, true);
    assert.deepEqual(pending.slotSelection, { label: 'Color 8 (not set)', picker: false, set: false, literal: '', assignment: 7 });
    assert.deepEqual(pending.inheritSelection, inherit);
    assert.deepEqual(pending.otherProfileInitially, inherit);
    assert.deepEqual(pending.afterProfileSwitch, unsetCustom);
    assert.deepEqual(pending.afterPageNavigation, unsetCustom);
    assert.deepEqual(pending.darkAfterSwitch, unsetCustom);
    assert.deepEqual(pending.darkExplicitBlack, black);
    assert.deepEqual(pending.lightAfterDarkSet, unsetCustom);
    assert.deepEqual(pending.settingReset, inherit);
    assert.deepEqual(pending.fromUnsetSlot, unsetSlotCustom);
    assert.deepEqual(pending.unsetSlotAfterPage, unsetSlotCustom);
    assert.deepEqual(pending.unsetSlotExplicitBlack, black);
    assert.deepEqual(pending.profileResetLight, inherit);
    assert.deepEqual(pending.profileResetOther, unsetCustom);
    assert.deepEqual(pending.bothResetDark, inherit);
    assert.deepEqual(pending.bothResetLight, inherit);
    assert.deepEqual(pending.failedImport, unsetCustom);
    assert.deepEqual(pending.jsonImportDark, inherit);
    assert.deepEqual(pending.jsonImportLight, inherit);
    assert.deepEqual(pending.copyTarget, inherit);
    assert.deepEqual(pending.copySource, unsetCustom);
    assert.deepEqual(pending.base16ImportLight, unsetCustom);
    assert.deepEqual(pending.base16ImportOther, unsetCustom);
    assert.deepEqual(pending.tabHide, inherit);
  });
  test(`${path}: expanded palette UI adds, imports, validates and reuses CSS colors`, () => {
    const expanded = results[path].expanded;
    assert.deepEqual(expanded.afterAdd, { count: 17, present: true });
    assert.equal(expanded.beforeManualSet, '');
    assert.deepEqual(expanded.manual, { value: 'oklch(60% 0.2 30 / 0.5)',
      swatch: { color: 'oklch(60% 0.2 30 / 0.5)', unset: false } });
    assert.deepEqual(expanded.append, { count: 19, last: ['#123456', 'rgba(1, 2, 3, 0.5)'],
      h1: 'oklch(60% 0.2 30 / 0.5)', assignment: 16 });
    assert.deepEqual(expanded.replace, { count: 19, first: ['#abcdef', 'oklch(70% 0.1 40)'],
      h1: 'oklch(60% 0.2 30 / 0.5)', h2: '#abcdef', assignment: 16,
      last: ['#123456', 'rgba(1, 2, 3, 0.5)'] });
    assert.equal(expanded.invalid.unchanged, true);
    assert.equal(expanded.invalid.writes, 0);
    assert.match(expanded.invalid.notice, /Invalid color at position 2/);
    assert.equal(expanded.failedSave.unchanged, true);
    assert.match(expanded.failedSave.notice, /Disk full/);
    assert.deepEqual(expanded.seed, { text: 'oklch(60% 0.2 30 / 0.5)', count: 19,
      color: 'oklch(60% 0.2 30 / 0.5)' });
    assert.deepEqual(expanded.draft, { count: 19, color: 'oklch(60% 0.2 30 / 0.5)' });
    assert.deepEqual(expanded.reuse, { count: 19, assignment: 18, color: 'rgba(1, 2, 3, 0.5)' });
    assert.deepEqual(expanded.alphaDraft, { count: 19, color: 'rgba(1, 2, 3, 0.5)' });
    assert.deepEqual(expanded.alphaCommit, { count: 20, assignment: 19,
      color: 'rgb(1 2 3 / 50.01%)', shared: 'rgba(1, 2, 3, 0.5)' });
  });
  test(`${path}: failed profile switch and newer drafts remain consistent`, () => {
    const { failedProfile, palette, custom } = results[path].races;
    assert.equal(failedProfile.selected, 'light');
    assert.equal(failedProfile.committed, 'light');
    assert.match(failedProfile.notice, /Disk full/);
    assert.equal(palette.saved, '#334455');
    assert.equal(palette.draft, '#667788');
    assert.deepEqual(palette.swatch, { color: '#334455', unset: false });
    assert.match(palette.description, /All settings assigned/);
    assert.equal(custom.saved, '#334455');
    assert.equal(custom.draft, '#667788');
    assert.match(custom.label, /Custom: #667788/);
    assert.deepEqual(results[path].races.pendingSwitch, {
      before: { selected: 'light', disabled: true, committed: 'light' },
      rebuilt: { selected: 'light', disabled: true, committed: 'light' },
      after: { selected: 'dark', disabled: false, committed: 'dark' },
      lightAssignment: 0, darkAssignment: null,
    });
    assert.deepEqual(results[path].races.overlappingProfiles, {
      afterOldFailure: { value: 'light', disabled: true }, selected: 'dark', disabled: false, committed: 'dark',
    });
    assert.deepEqual(results[path].races.rebuiltProfile, { selected: 'dark', committed: 'dark' });
    assert.deepEqual(results[path].races.failedPicker, { saved: '#334455', picker: '#abcdef', draft: '#abcdef',
      swatch: { color: '#334455', unset: false }, notice: 'Unable to set color: Picker save failed', retry: '#abcdef' });
    assert.equal(results[path].races.assignmentDraft.assignment, 0);
    assert.equal(results[path].races.assignmentDraft.draft, '#aabbcc');
    assert.match(results[path].races.assignmentDraft.label, /Custom: #aabbcc/);
    assert.equal(results[path].races.resetDraft.assignment, null);
    assert.equal(results[path].races.resetDraft.draft, '#ddeeff');
    assert.match(results[path].races.resetDraft.label, /Custom: #ddeeff/);
  });
  test(`${path}: palette CSV and JSON file inputs populate import controls`, () => {
    const { files } = results[path].races;
    assert.deepEqual(files.csv, { format: 'csv', text: '#010203, rgba(1, 2, 3, 0.5)' });
    assert.deepEqual(files.append, ['#010203', 'rgba(1, 2, 3, 0.5)']);
    assert.deepEqual(files.json, { format: 'json', text: '["#abcdef", "#123456"]' });
    assert.deepEqual(files.replace, ['#abcdef', '#123456']);
    assert.equal(files.invalid.unchanged, true);
    assert.match(files.invalid.notice, /Invalid color/);
    assert.deepEqual(files.newerDraft, { format: 'json', text: '["#654321"]' });
    assert.deepEqual(files.newerFile, { format: 'json', text: '["#fedcba"]' });
    assert.ok(results[path].races.largeSettingsFile.size > 1024 * 1024);
    assert.equal(results[path].races.largeSettingsFile.colors, 110000);
    assert.equal(results[path].races.largeSettingsFile.last, '#abcdef');
    assert.match(results[path].races.largeSettingsFile.notice, /success/i);
    assert.deepEqual(results[path].races.settingsExport, { download: 'theme-basics-settings.json',
      attached: false, activeDocument: true, blob: true });
  });
  test(`${path}: mode switching and Base16 refresh preserve assignment`, () => {
    assert.equal(results[path].dark.mode, 'dark');
    assert.match(results[path].dark.description, /Not set/);
    assert.equal(results[path].dark.assignment, 'Inherit');
    assert.equal(results[path].dark.pageStillOpen, true);
    assert.deepEqual(results[path].light, { picker: '#345678', pageStillOpen: true,
      assignment: 'Color 1', heading: 'Color 2' });
    assert.deepEqual(results[path].imported, { palette: ['#abcdef', '#fedcba'], picker1: '#abcdef', picker13: '#fedcba',
      untouched: results[path].afterSet.shown, headingAssignment: 1, darkPalette: '', textareaResize: 'vertical', pageStillOpen: true,
      assignment: 'Color 1', resolved: '#abcdef', swatch: { color: '#abcdef', unset: false } });
    assert.deepEqual(results[path].importedChoices[2], { label: 'Color 1 Current', swatch: { color: '#abcdef', unset: false } });
    assert.deepEqual(results[path].importedChoices[14], { label: 'Color 13', swatch: { color: '#fedcba', unset: false } });
    assert.deepEqual(results[path].modalAccessibility, { filterLabel: 'Filter palette colors',
      selectLabel: 'Main note and app background. Color 1', expanded: 'true' });
    assert.deepEqual(results[path].afterHide, { modalClosed: true, assignment: 0, expanded: 'false' });
  });
}

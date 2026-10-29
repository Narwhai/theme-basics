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
  if (!liveTab || typeof liveTab.addRow !== 'function') throw new Error('Enable Theme Basics in the test vault before running this test.');
  const probe = activeDocument.body.createDiv({ cls: 'theme-basics-offscreen' });
  let Setting, ColorComponent, ButtonComponent;
  try { liveTab.addRow(probe, 'probe', '', (setting) => {
    Setting = setting.constructor;
    setting.addColorPicker((picker) => { ColorComponent = picker.constructor; });
    setting.addButton((button) => { ButtonComponent = button.constructor; });
  }); }
  finally { probe.remove(); }
  if (!Setting || !ColorComponent || !ButtonComponent) throw new Error('Could not obtain Obsidian UI constructors.');
  const RealPluginSettingTab = Object.getPrototypeOf(Object.getPrototypeOf(liveTab)).constructor;
  const quickSwitcher = app.internalPlugins.plugins.switcher?.instance?.QuickSwitcherModal;
  if (!quickSwitcher) throw new Error('Enable the Quick Switcher core plugin to run palette modal checks.');
  const SuggestModal = Object.getPrototypeOf(Object.getPrototypeOf(quickSwitcher));
  const fakeApi = {
    Setting, SuggestModal, ColorComponent, ButtonComponent,
    debounce: (fn) => Object.assign(fn, { cancel() {} }),
    Notice: class {},
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
  const supportsDeclarative = typeof RealPluginSettingTab.prototype.update === 'function';
  for (const path of supportsDeclarative ? ['declarative', 'legacy'] : ['legacy']) {
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
    const rootActions = [];
    plugin.exportSettingsJson = () => rootActions.push('export');
    plugin.importSettingsJson = () => rootActions.push('import');
    plugin.exportCssSnippet = async () => { rootActions.push('snippet'); };
    const colorResolver = new StyleManager(plugin);
    plugin.styleManager = {
      applyStyles() {}, getDefaultNumericValue(_m, _k, _v, fallback) { return fallback; },
      ensureWithinRange(value) { return value; },
      tryToPickerHex(value) { return colorResolver.tryToPickerHex(value); },
    };
    const tab = new SettingsTab(plugin.app, plugin);
    plugin.settingsTab = tab;
    if (path === 'legacy') tab.update = undefined;
    tab.containerEl.isShown = () => true;
    hostEl.append(tab.containerEl);
    host.activeTab = tab;
    const render = () => path === 'legacy' ? tab.display() : tab.update();
    const content = () => path === 'legacy' ? tab.containerEl : host.getCurrentPageEl();
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
    // eslint-disable-next-line obsidianmd/no-forbidden-elements -- isolated renderer fixture loads the checked-out CSS without reloading the installed plugin
    const stylesheet = activeDocument.head.createEl('style');
    stylesheet.textContent = styles;
    try {
      render();
      const root = { hasPaletteLink: Boolean(row('Color palette')),
        pickers: content().querySelectorAll('input[type=color]').length,
        base16: Boolean(row('Base16 YAML')), profile: Boolean(row('Profile to edit')) };
      const rootRefreshers = tab.colorControlRefreshers.size;
      const staleRootActions = ['Export settings', 'Import settings', 'Export as CSS snippet']
        .map((name) => row(name).querySelector('button'));
      const h1Row = () => [...content().querySelectorAll('.setting-item')].find((el) => el.querySelector('.setting-item-description')?.textContent.includes('Text color for H1 headings.'));
      const openPalette = async () => {
        const link = row('Color palette');
        if (!link) throw new Error('Missing palette navigation row');
        await click(path === 'legacy' ? link.querySelector('button') : link);
        if (path === 'declarative') await new Promise((resolve) => activeWindow.setTimeout(resolve, 350));
        if (!row('Color 1')) throw new Error('Palette page did not open');
      };
      const closePalette = async () => {
        const backButton = path === 'legacy' ? row('Back to settings')?.querySelector('button') : content().querySelector('.setting-page-back-button');
        if (!backButton) throw new Error('Palette page has no back button');
        await click(backButton);
        if (path === 'declarative') {
          await new Promise((resolve) => activeWindow.setTimeout(resolve, 350));
          // This minimal detached host lacks the full settings modal's container
          // restoration; attach the real renderer's returned tab for CSS checks.
          if (!tab.containerEl.isConnected) hostEl.append(tab.containerEl);
        }
        if (!row('Primary background')) throw new Error('Back did not restore main settings');
      };
      const h1row = h1Row();
      const h1button = selectButton(h1row);
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
      const applyPreview = h1row.querySelector('.theme-basics-custom-color button');
      legacy.hasApplyPreview = applyPreview?.textContent === 'Set';
      if (!applyPreview) throw new Error('Missing button to apply the displayed picker color');
      await click(applyPreview);
      legacy.afterApply = plugin.getProfile('light').h1Color;
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
        nativePage: path === 'legacy' ? null : host.pageStack.length, modalClosed: tab.activeColorModal === null,
        staleRootAssignment: plugin.settings.colorAssignments.light.h1Color };
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
      const afterSet = { shown: color2Shown, stored: plugin.settings.palettes.light[1],
        resolved: plugin.getResolvedProfile('light').h1Color, swatch: swatch(selectButton(h1Row())) };
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
      await closePalette();
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
      await choose(await openChoices(row('Primary background')), 'Inherit theme default');
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
      await closePalette();
      dark.assignment = selectButton(row('Primary background')).textContent;
      await openPalette();
      const back = row('Profile to edit').querySelector('select');
      back.value = 'light';
      await fire(back);
      const light = { picker: row('Color 1').querySelector('input[type=color]').value,
        pageStillOpen: Boolean(row('Base16 YAML')) };
      await closePalette();
      light.assignment = selectButton(row('Primary background')).textContent;
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
      await closePalette();
      imported.assignment = selectButton(row('Primary background')).textContent;
      imported.resolved = plugin.getResolvedProfile('light').backgroundPrimary;
      imported.swatch = swatch(selectButton(row('Primary background')));

      // Exercise custom tag border independently from a shared palette slot.
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
      custom.edited = plugin.getProfile('light').tagBorderColor;
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
      custom.darkSet = { literal: plugin.getProfile('dark').tagBorderColor, shown: darkInput.value,
        light: plugin.getProfile('light').tagBorderColor };
      await choose(await openChoices(tagRow()), 'Color 8 (not set)');
      await choose(await openChoices(tagRow()), 'Custom');
      custom.emptySlot = { literal: plugin.getProfile('dark').tagBorderColor,
        assignment: plugin.settings.colorAssignments.dark.tagBorderColor ?? null,
        hasSet: Boolean([...tagRow().querySelectorAll('button')].find((el) => el.textContent === 'Set')) };
      tagRow().querySelector('input[type=color]').value = '#000000';
      await click([...tagRow().querySelectorAll('button')].find((el) => el.textContent === 'Set'));
      custom.emptySlotSet = plugin.getProfile('dark').tagBorderColor;
      const profileBack = row('Profile to edit').querySelector('select');
      profileBack.value = 'light';
      await fire(profileBack);
      custom.restored = { literal: plugin.getProfile('light').tagBorderColor,
        picker: tagRow().querySelector('input[type=color]').value };
      customInput.value = '#999999';
      await fire(customInput, 'input');
      await fire(customInput, 'change');
      custom.staleAfterProfileSwitch = plugin.getProfile('light').tagBorderColor;
      const previousPicker = tagRow().querySelector('input[type=color]');
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
      custom.staleAfterReselect = plugin.getProfile('light').tagBorderColor;
      await click(tagRow().querySelector('.extra-setting-button'));
      custom.reset = { literal: plugin.getProfile('light').tagBorderColor,
        assignment: plugin.settings.colorAssignments.light.tagBorderColor ?? null,
        picker: Boolean(tagRow().querySelector('input[type=color]')),
        label: selectButton(tagRow()).textContent };

      const importedModal = await openChoices(row('Primary background'));
      const importedChoices = choiceElements(importedModal).map((el) => ({ label: el.textContent.trim(), swatch: swatch(el) }));
      const modalAccessibility = { filterLabel: importedModal.inputEl.getAttribute('aria-label'),
        selectLabel: selectButton(row('Primary background')).getAttribute('aria-label'),
        expanded: selectButton(row('Primary background')).getAttribute('aria-expanded') };
      const staleChoice = importedModal.getSuggestions('').find((choice) => choice.value === '12');
      const buttonBeforeHide = selectButton(row('Primary background'));
      tab.hide();
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
      tab.hide();
      host.clearPageStack();
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
      tab.hide();
      host.clearPageStack();
      if (!tab.containerEl.isConnected) hostEl.append(tab.containerEl);
      render();
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
      await choose(await openChoices(pendingTag()), 'Inherit theme default');
      pending.inheritSelection = pendingState();
      await choose(await openChoices(pendingTag()), 'Custom');
      await switchProfile('dark');
      pending.otherProfileInitially = pendingState();
      await choose(await openChoices(pendingTag()), 'Custom');
      await switchProfile('light');
      pending.afterProfileSwitch = pendingState();
      await openPalette();
      await closePalette();
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
      await closePalette();
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
      await click(row('Reset Light profile').querySelector('button'));
      pending.profileResetLight = pendingState();
      await switchProfile('dark');
      pending.profileResetOther = pendingState();
      await click(row('Reset both profiles').querySelector('button'));
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
      await closePalette();
      pending.base16ImportLight = pendingState();
      await switchProfile('dark');
      pending.base16ImportOther = pendingState();
      await switchProfile('light');
      await choose(await openChoices(pendingTag()), 'Custom');
      tab.hide();
      host.clearPageStack();
      if (!tab.containerEl.isConnected) hostEl.append(tab.containerEl);
      render();
      pending.tabHide = pendingState();

      // Interactive background uses the same palette/custom control as other colors.
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
      interactive.lightCustom = plugin.getProfile('light').interactiveBackground;
      await switchProfile('dark');
      interactive.darkInitial = selectButton(interactiveRow()).textContent;
      await choose(await openChoices(interactiveRow()), 'Custom');
      const darkInteractivePicker = interactiveRow().querySelector('input[type=color]');
      darkInteractivePicker.value = '#778899';
      await fire(darkInteractivePicker, 'input');
      await fire(darkInteractivePicker, 'change');
      interactive.darkCustom = plugin.getProfile('dark').interactiveBackground;
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
      formField.lightCustom = plugin.getProfile('light').formFieldBackground;
      await switchProfile('dark');
      formField.darkInitial = selectButton(formRow()).textContent;
      await choose(await openChoices(formRow()), 'Custom');
      const darkFormPicker = formRow().querySelector('input[type=color]');
      darkFormPicker.value = '#334455';
      await fire(darkFormPicker, 'input');
      await fire(darkFormPicker, 'change');
      formField.darkCustom = plugin.getProfile('dark').formFieldBackground;
      formField.darkInteractive = plugin.getProfile('dark').interactiveBackground;
      await switchProfile('light');
      formField.lightRestored = plugin.getResolvedProfile('light').formFieldBackground;
      await click(formRow().querySelector('.extra-setting-button'));
      formField.reset = { label: selectButton(formRow()).textContent,
        light: plugin.getResolvedProfile('light').formFieldBackground,
        dark: plugin.getResolvedProfile('dark').formFieldBackground };

      results[path] = { root, page, stalePage, afterReset, afterAllReset, afterRepeat, afterPageHide, afterDispose, initial, legacy, legacyChoices, emptySlot,
        afterSet, afterEdit, options, afterSelect, afterUpdate, current, keyboard, afterInherit, dark, light,
        imported, importedChoices, modalAccessibility, afterHide, custom, pending, interactive, formField };
    } finally { host.clearPageStack(); tab.dispose(); colorResolver.cleanup(); hostEl.remove(); stylesheet.remove(); }
  }
  return { results, supportsDeclarative };
}
const bundle = await bundlePlugin();
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const code = `JSON.stringify(await (${rendererChecks.toString()})(${JSON.stringify(bundle)}, ${JSON.stringify(styles)}))`;
const output = execFileSync('obsidian', [`vault=${vault}`, 'eval', `code=${code}`], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }).trim();
const lines = output.split('\n');
const resultLine = lines.findLast((line) => line.startsWith('=> '));
const diagnostics = lines.filter((line) => line !== resultLine);
const unexpected = diagnostics.filter((line) => !/^\[error\] Theme Basics UI Test: duplicate setting key /.test(line));
if (!resultLine || unexpected.length) throw new Error(`Obsidian renderer checks failed: ${output}`);
if (diagnostics.length) console.warn(`Obsidian reported ${diagnostics.length} duplicate setting-key warnings in the fixture.`);
const { results, supportsDeclarative } = JSON.parse(resultLine.slice(3));
for (const path of ['declarative', 'legacy']) {
  const options = { skip: path === 'declarative' && !supportsDeclarative ? 'Obsidian has no declarative settings API' : false };
  test(`${path}: palette opens as a separate page and returns cleanly`, options, () => {
    assert.deepEqual(results[path].root, { hasPaletteLink: true, pickers: 2, base16: false, profile: true });
    assert.deepEqual(results[path].page, { profile: true, base16: true, rootSettingsVisible: false, refreshers: 0,
      nativePage: path === 'legacy' ? null : 1, modalClosed: true, staleRootAssignment: 1,
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
  test(`${path}: palette controls initialize unset with 16 neutral labels`, options, () => {
    assert.deepEqual(results[path].initial.labels, Array.from({ length: 16 }, (_, i) => `Color ${i + 1}`));
    assert.equal(results[path].initial.pickers, 16);
    assert.equal(results[path].initial.unset, 16);
    assert.equal(results[path].initial.setButtons, 16);
    assert.deepEqual(results[path].initial.palette, Array(16).fill(''));
  });
  test(`${path}: legacy colors persist until selecting an unset slot, then Set activates it`, options, () => {
    assert.deepEqual(results[path].legacy, { label: 'Custom: rgba(1, 2, 3, 0.3)▾',
      swatch: { color: 'rgba(1, 2, 3, 0.3)', unset: false }, resolved: 'rgba(1, 2, 3, 0.3)', computed: 'rgba(1, 2, 3, 0.3)',
      picker: '#010203', modern: 'oklch(60% 0.2 30)', modernPicker: '#de3e2d', initialSaves: 0,
      afterCustom: 'rgba(1, 2, 3, 0.3)', afterCustomSaves: 0, hasApplyPreview: true,
      afterApply: '#010203', afterApplySaves: 1, afterApplyButton: false, modernAfterApply: 'oklch(60% 0.2 30)' });
    assert.deepEqual(results[path].legacyChoices[1], { label: 'Custom Current',
      swatch: { color: 'rgba(1, 2, 3, 0.3)', unset: false } });
    assert.deepEqual(results[path].emptySlot, { assignment: 1, literal: '', resolved: '', swatch: { color: '', unset: true } });
    assert.match(results[path].afterSet.shown, /^#[0-9a-f]{6}$/);
    assert.equal(results[path].afterSet.stored, results[path].afterSet.shown);
    assert.equal(results[path].afterSet.resolved, results[path].afterSet.shown);
    assert.deepEqual(results[path].afterSet.swatch, { color: results[path].afterSet.shown, unset: false });
  });
  test(`${path}: explicitly apply the unchanged opaque preview of a translucent color`, options, () => {
    const legacy = results[path].legacy;
    assert.equal(legacy.resolved, 'rgba(1, 2, 3, 0.3)');
    assert.equal(legacy.afterCustom, 'rgba(1, 2, 3, 0.3)');
    assert.equal(legacy.afterCustomSaves, 0);
    assert.equal(legacy.picker, '#010203');
    assert.equal(legacy.hasApplyPreview, true);
    assert.equal(legacy.afterApply, '#010203');
    assert.equal(legacy.afterApplySaves, 1);
    assert.equal(legacy.afterApplyButton, false);
    assert.equal(legacy.modernAfterApply, 'oklch(60% 0.2 30)');
  });
  test(`${path}: picker edit, swatches, assignment and inherit`, options, () => {
    assert.equal(results[path].afterEdit.value, '#123456');
    assert.match(results[path].afterEdit.description, /All settings assigned/);
    assert.equal(results[path].options.length, 18);
    assert.deepEqual(results[path].options[0], { label: 'Inherit theme default Current', swatch: { color: '', unset: true } });
    assert.deepEqual(results[path].options[1], { label: 'Custom', swatch: { color: '', unset: true } });
    assert.deepEqual(results[path].options[2], { label: 'Color 1', swatch: { color: '#123456', unset: false } });
    assert.deepEqual(results[path].options[3], { label: 'Color 2', swatch: { color: results[path].afterSet.shown, unset: false } });
    for (let i = 3; i <= 16; i++) {
      assert.deepEqual(results[path].options[i + 1], { label: `Color ${i} (not set)`, swatch: { color: '', unset: true } });
    }
    assert.deepEqual(results[path].afterSelect, { assignment: 0, resolved: '#123456', selected: 'Color 1▾',
      swatch: { color: '#123456', unset: false }, accessible: 'Main note and app background. Color 1', computed: 'rgb(18, 52, 86)' });
    assert.deepEqual(results[path].afterUpdate, { swatch: { color: '#345678', unset: false }, resolved: '#345678' });
    assert.deepEqual(results[path].current, [{ label: 'Color 1 Current', swatch: { color: '#345678', unset: false } }]);
    assert.deepEqual(results[path].keyboard, { assignment: 12, open: false, selected: 'Color 13 (not set)▾' });
    assert.deepEqual(results[path].afterInherit, { assignment: null, resolved: '', selected: 'Inherit theme default▾',
      swatch: { color: '', unset: true } });
  });
  test(`${path}: custom colors seed from a slot and stay independent`, options, () => {
    const custom = results[path].custom;
    assert.equal(custom.seed, '#abcdef');
    assert.equal(custom.seededLiteral, '#abcdef');
    assert.equal(custom.seededAssignment, null);
    assert.match(custom.pickerLabel, /Custom color for Border color for tags/);
    assert.equal(custom.edited, '#89abcd');
    assert.equal(custom.afterPalette, '#89abcd');
    assert.equal(custom.sharedAfterPalette, '#778899');
    assert.deepEqual(custom.darkUnset, { literal: '', writes: 0, hasSet: true });
    assert.equal(custom.darkSet.shown, '#000000');
    assert.equal(custom.darkSet.literal, '#000000');
    assert.equal(custom.darkSet.light, '#89abcd');
    assert.deepEqual(custom.emptySlot, { literal: '', assignment: null, hasSet: true });
    assert.equal(custom.emptySlotSet, '#000000');
    assert.deepEqual(custom.restored, { literal: '#89abcd', picker: '#89abcd' });
    assert.equal(custom.staleAfterProfileSwitch, '#89abcd');
    assert.deepEqual(custom.slot, { assignment: 0, literal: '', picker: false });
    assert.deepEqual(custom.staleAfterSlot, { assignment: 0, literal: '' });
    assert.equal(custom.reseeded, '#abcdef');
    assert.equal(custom.staleAfterReselect, '#abcdef');
    assert.deepEqual(custom.reset, { literal: '', assignment: null, picker: false, label: 'Inherit theme default▾' });
  });
  test(`${path}: interactive background supports palette, custom, profile and reset`, options, () => {
    assert.match(results[path].interactive.description, /buttons and dropdowns throughout Obsidian/);
    assert.equal(results[path].interactive.initial, 'Inherit theme default▾');
    assert.deepEqual(results[path].interactive.lightPalette, { assignment: 9, color: '#aabbcc' });
    assert.equal(results[path].interactive.seed, '#aabbcc');
    assert.equal(results[path].interactive.lightCustom, '#445566');
    assert.equal(results[path].interactive.darkInitial, 'Inherit theme default▾');
    assert.equal(results[path].interactive.darkCustom, '#778899');
    assert.equal(results[path].interactive.lightRestored, '#445566');
    assert.deepEqual(results[path].interactive.reset, { label: 'Inherit theme default▾', light: '', dark: '#778899' });
  });
  test(`${path}: form field background supports palette, custom, profile and reset`, options, () => {
    assert.match(results[path].formField.description, /search and other text fields throughout Obsidian/);
    assert.equal(results[path].formField.initial, 'Inherit theme default▾');
    assert.deepEqual(results[path].formField.lightPalette, { assignment: 9, color: '#aabbcc' });
    assert.equal(results[path].formField.seed, '#aabbcc');
    assert.equal(results[path].formField.lightCustom, '#112233');
    assert.equal(results[path].formField.darkInitial, 'Inherit theme default▾');
    assert.equal(results[path].formField.darkCustom, '#334455');
    assert.equal(results[path].formField.darkInteractive, '#778899');
    assert.equal(results[path].formField.lightRestored, '#112233');
    assert.deepEqual(results[path].formField.reset, { label: 'Inherit theme default▾', light: '', dark: '#334455' });
  });
  test(`${path}: pending Custom survives navigation without persisting a color`, options, () => {
    const pending = results[path].pending;
    const unsetCustom = { label: 'Custom▾', picker: true, set: true, literal: '', assignment: null };
    const inherit = { label: 'Inherit theme default▾', picker: false, set: false, literal: '', assignment: null };
    const black = { label: 'Custom: #000000▾', picker: true, set: false, literal: '#000000', assignment: null };
    assert.deepEqual(pending.fromInherit, unsetCustom);
    assert.equal(pending.fromInheritWrites, 0);
    assert.equal(pending.noPersistedState, true);
    assert.deepEqual(pending.slotSelection, { label: 'Color 8 (not set)▾', picker: false, set: false, literal: '', assignment: 7 });
    assert.deepEqual(pending.inheritSelection, inherit);
    assert.deepEqual(pending.otherProfileInitially, inherit);
    assert.deepEqual(pending.afterProfileSwitch, unsetCustom);
    assert.deepEqual(pending.afterPageNavigation, unsetCustom);
    assert.deepEqual(pending.darkAfterSwitch, unsetCustom);
    assert.deepEqual(pending.darkExplicitBlack, black);
    assert.deepEqual(pending.lightAfterDarkSet, unsetCustom);
    assert.deepEqual(pending.settingReset, inherit);
    assert.deepEqual(pending.fromUnsetSlot, unsetCustom);
    assert.deepEqual(pending.unsetSlotAfterPage, unsetCustom);
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
  test(`${path}: mode switching and Base16 refresh preserve assignment`, options, () => {
    assert.equal(results[path].dark.mode, 'dark');
    assert.match(results[path].dark.description, /Not set/);
    assert.equal(results[path].dark.assignment, 'Inherit theme default▾');
    assert.equal(results[path].dark.pageStillOpen, true);
    assert.deepEqual(results[path].light, { picker: '#345678', pageStillOpen: true,
      assignment: 'Color 1▾', heading: 'Color 2▾' });
    assert.deepEqual(results[path].imported, { palette: ['#abcdef', '#fedcba'], picker1: '#abcdef', picker13: '#fedcba',
      untouched: results[path].afterSet.shown, headingAssignment: 1, darkPalette: '', textareaResize: 'vertical', pageStillOpen: true,
      assignment: 'Color 1▾', resolved: '#abcdef', swatch: { color: '#abcdef', unset: false } });
    assert.deepEqual(results[path].importedChoices[2], { label: 'Color 1 Current', swatch: { color: '#abcdef', unset: false } });
    assert.deepEqual(results[path].importedChoices[14], { label: 'Color 13', swatch: { color: '#fedcba', unset: false } });
    assert.deepEqual(results[path].modalAccessibility, { filterLabel: 'Filter palette colors',
      selectLabel: 'Main note and app background. Color 1', expanded: 'true' });
    assert.deepEqual(results[path].afterHide, { modalClosed: true, assignment: 0, expanded: 'false' });
  });
}

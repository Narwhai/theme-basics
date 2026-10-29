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
  let Setting;
  try { liveTab.addRow(probe, 'probe', '', (setting) => { Setting = setting.constructor; }); }
  finally { probe.remove(); }
  if (!Setting) throw new Error('Could not obtain Obsidian Setting constructor.');
  const RealPluginSettingTab = Object.getPrototypeOf(Object.getPrototypeOf(liveTab)).constructor;
  const quickSwitcher = app.internalPlugins.plugins.switcher?.instance?.QuickSwitcherModal;
  if (!quickSwitcher) throw new Error('Enable the Quick Switcher core plugin to run palette modal checks.');
  const SuggestModal = Object.getPrototypeOf(Object.getPrototypeOf(quickSwitcher));
  const fakeApi = {
    Setting, SuggestModal,
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
  const { Plugin, SettingsTab, DEFAULT_SETTINGS } = module.exports;
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
    plugin.saveData = async () => {};
    const rootActions = [];
    plugin.exportSettingsJson = () => rootActions.push('export');
    plugin.importSettingsJson = () => rootActions.push('import');
    plugin.exportCssSnippet = async () => { rootActions.push('snippet'); };
    plugin.styleManager = {
      applyStyles() {}, getDefaultNumericValue(_m, _k, _v, fallback) { return fallback; },
      ensureWithinRange(value) { return value; },
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
      const legacy = { label: h1button.textContent, swatch: swatch(h1button),
        resolved: plugin.getResolvedProfile('light').h1Color,
        computed: getComputedStyle(h1button.querySelector('.theme-basics-color-swatch')).backgroundColor };
      const legacyModal = await openChoices(h1row);
      const legacyChoices = choiceElements(legacyModal).map((el) => ({ label: el.textContent.trim(), swatch: swatch(el) }));
      await choose(legacyModal, 'Color 2 (not set)');
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
      results[path] = { root, page, stalePage, afterReset, afterAllReset, afterRepeat, afterPageHide, afterDispose, initial, legacy, legacyChoices, emptySlot,
        afterSet, afterEdit, options, afterSelect, afterUpdate, current, keyboard, afterInherit, dark, light,
        imported, importedChoices, modalAccessibility, afterHide };
    } finally { host.clearPageStack(); tab.dispose(); hostEl.remove(); stylesheet.remove(); }
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
    assert.deepEqual(results[path].root, { hasPaletteLink: true, pickers: 0, base16: false, profile: true });
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
    assert.deepEqual(results[path].legacy, { label: 'Existing color: rgba(1, 2, 3, 0.3)▾',
      swatch: { color: 'rgba(1, 2, 3, 0.3)', unset: false }, resolved: 'rgba(1, 2, 3, 0.3)', computed: 'rgba(1, 2, 3, 0.3)' });
    assert.deepEqual(results[path].legacyChoices[1], { label: 'Existing color: rgba(1, 2, 3, 0.3) Current',
      swatch: { color: 'rgba(1, 2, 3, 0.3)', unset: false } });
    assert.deepEqual(results[path].emptySlot, { assignment: 1, literal: '', resolved: '', swatch: { color: '', unset: true } });
    assert.match(results[path].afterSet.shown, /^#[0-9a-f]{6}$/);
    assert.equal(results[path].afterSet.stored, results[path].afterSet.shown);
    assert.equal(results[path].afterSet.resolved, results[path].afterSet.shown);
    assert.deepEqual(results[path].afterSet.swatch, { color: results[path].afterSet.shown, unset: false });
  });
  test(`${path}: picker edit, swatches, assignment and inherit`, options, () => {
    assert.equal(results[path].afterEdit.value, '#123456');
    assert.match(results[path].afterEdit.description, /All settings assigned/);
    assert.equal(results[path].options.length, 17);
    assert.deepEqual(results[path].options[0], { label: 'Inherit theme default Current', swatch: { color: '', unset: true } });
    assert.deepEqual(results[path].options[1], { label: 'Color 1', swatch: { color: '#123456', unset: false } });
    assert.deepEqual(results[path].options[2], { label: 'Color 2', swatch: { color: results[path].afterSet.shown, unset: false } });
    for (let i = 3; i <= 16; i++) {
      assert.deepEqual(results[path].options[i], { label: `Color ${i} (not set)`, swatch: { color: '', unset: true } });
    }
    assert.deepEqual(results[path].afterSelect, { assignment: 0, resolved: '#123456', selected: 'Color 1▾',
      swatch: { color: '#123456', unset: false }, accessible: 'Main note and app background. Color 1', computed: 'rgb(18, 52, 86)' });
    assert.deepEqual(results[path].afterUpdate, { swatch: { color: '#345678', unset: false }, resolved: '#345678' });
    assert.deepEqual(results[path].current, [{ label: 'Color 1 Current', swatch: { color: '#345678', unset: false } }]);
    assert.deepEqual(results[path].keyboard, { assignment: 12, open: false, selected: 'Color 13 (not set)▾' });
    assert.deepEqual(results[path].afterInherit, { assignment: null, resolved: '', selected: 'Inherit theme default▾',
      swatch: { color: '', unset: true } });
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
    assert.deepEqual(results[path].importedChoices[1], { label: 'Color 1 Current', swatch: { color: '#abcdef', unset: false } });
    assert.deepEqual(results[path].importedChoices[13], { label: 'Color 13', swatch: { color: '#fedcba', unset: false } });
    assert.deepEqual(results[path].modalAccessibility, { filterLabel: 'Filter palette colors',
      selectLabel: 'Main note and app background. Color 1', expanded: 'true' });
    assert.deepEqual(results[path].afterHide, { modalClosed: true, assignment: 0, expanded: 'false' });
  });
}

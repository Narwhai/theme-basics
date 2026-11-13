import { debounce, normalizePath, Notice, Plugin } from "obsidian";

import { DEFAULT_PROFILE, DEFAULT_SETTINGS, isColorProfileKey, PALETTE_SIZE, PROFILE_KEYS, PROFILE_LABELS } from "./constants";
import { parsePaletteColorList } from "./palette-import";
import { DefaultThemeStyleTunerSettingTab } from "./settings-tab";
import { StyleManager } from "./style-manager";
import { cloneProfile, isObject, isValidCssColor, sanitizeCssValue } from "./utils";

import type {
  DefaultThemeStyleTunerProfile,
  DefaultThemeStyleTunerSettings,
  ProfileMode,
} from "./types";

export default class DefaultThemeStyleTunerPlugin extends Plugin {
  override settings!: DefaultThemeStyleTunerSettings;
  readonly styleManager = new StyleManager(this);
  private settingsTab: DefaultThemeStyleTunerSettingTab | null = null;
  private settingsQueue: Promise<void> = Promise.resolve();
  private settingsImportRevision = 0;

  private readonly debouncedCssChange = debounce(() => {
    this.styleManager.refreshThemeDefaults();
    this.styleManager.applyStyles();
    this.settingsTab?.refreshDisplayPreserveScroll();
  }, 50, false);

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.settingsTab = new DefaultThemeStyleTunerSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.register(() => { this.settingsTab?.dispose(); this.settingsTab = null; });
    this.registerCommands();

    this.register(() => this.styleManager.cleanup());
    this.register(() => this.debouncedCssChange.cancel());

    this.app.workspace.onLayoutReady(() => {
      this.styleManager.refreshThemeDefaults();
      this.styleManager.applyStyles();
    });

    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        this.debouncedCssChange();
      })
    );
  }

  getThemeMode(): ProfileMode {
    return this.app.isDarkMode() ? "dark" : "light";
  }

  getAppliedProfileMode(): ProfileMode {
    return this.getThemeMode();
  }

  getEditedProfileMode(): ProfileMode {
    return this.settings.uiProfile === "dark" ? "dark" : "light";
  }

  getProfile(mode: ProfileMode): DefaultThemeStyleTunerProfile {
    return this.settings.profiles[mode === "dark" ? "dark" : "light"];
  }

  async loadSettings(): Promise<void> {
    const loadedSettings: unknown = await this.loadData();
    if (isObject(loadedSettings) && typeof loadedSettings.version === "number") {
      if (loadedSettings.version > DEFAULT_SETTINGS.version) {
        throw new Error("Settings were created by a newer version of Theme Basics.");
      }
      // Do not silently erase malformed palette data when rewriting settings.
      if (loadedSettings.version === 3 || loadedSettings.version === 4) this.validateSettingsImport(loadedSettings);
    }
    this.settings = this.normalizeSettings(loadedSettings);
    await this.saveData(this.settings);
  }

  /** Serialize each write and compute its snapshot only after preceding writes settle. */
  private enqueueSettings<Result>(
    build: (current: DefaultThemeStyleTunerSettings) => { next: DefaultThemeStyleTunerSettings | null; result: Result }
  ): Promise<Result> {
    const operation = this.settingsQueue.then(async () => {
      const { next, result } = build(this.settings);
      if (next === null) return result;
      await this.saveData(next);
      this.settings = next;
      this.styleManager.applyStyles();
      return result;
    });
    // Keep the queue usable after a failed write; callers still receive the rejection.
    this.settingsQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async saveSettings(): Promise<void> {
    await this.enqueueSettings((current) => ({ next: { ...current }, result: undefined }));
  }

  async setEditedProfileMode(mode: ProfileMode): Promise<void> {
    await this.enqueueSettings((current) => ({ next: { ...current, uiProfile: mode }, result: undefined }));
  }

  async setProfileValue(
    mode: ProfileMode,
    key: keyof DefaultThemeStyleTunerProfile,
    value: string
  ): Promise<void> {
    const sanitized = sanitizeCssValue(value);
    const tab = this.settingsTab;
    const revision = tab?.getPendingCustomRevision(mode, key);
    await this.enqueueSettings((current) => {
      const profile = cloneProfile(current.profiles[mode]);
      profile[key] = sanitized;
      const assignments = { ...current.colorAssignments[mode] };
      delete assignments[key];
      return { next: {
        ...current,
        profiles: { ...current.profiles, [mode]: profile },
        colorAssignments: { ...current.colorAssignments, [mode]: assignments },
      }, result: undefined };
    });
    tab?.clearPendingCustomValueIfUnchanged(mode, key, revision);
  }

  async resetProfileValue(mode: ProfileMode, key: keyof DefaultThemeStyleTunerProfile): Promise<void> {
    await this.resetProfileValues(mode, [key]);
  }

  async resetProfileValues(
    mode: ProfileMode,
    keys: ReadonlyArray<keyof DefaultThemeStyleTunerProfile>
  ): Promise<void> {
    const tab = this.settingsTab;
    const revisions = tab?.getPendingCustomRevisions(mode);
    await this.enqueueSettings((current) => {
      const profile = cloneProfile(current.profiles[mode]);
      const assignments = { ...current.colorAssignments[mode] };
      for (const key of keys) {
        profile[key] = DEFAULT_PROFILE[key];
        delete assignments[key];
      }
      return { next: {
        ...current,
        profiles: { ...current.profiles, [mode]: profile },
        colorAssignments: { ...current.colorAssignments, [mode]: assignments },
      }, result: undefined };
    });
    if (tab && revisions) {
      for (const key of keys) tab.clearPendingCustomValueIfUnchanged(mode, key, revisions.get(key));
    }
  }

  async copyProfile(sourceMode: ProfileMode, targetMode: ProfileMode): Promise<void> {
    const tab = this.settingsTab;
    const revisions = tab?.getPendingCustomRevisions(targetMode);
    await this.enqueueSettings((current) => ({ next: {
      ...current,
      profiles: { ...current.profiles, [targetMode]: cloneProfile(current.profiles[sourceMode]) },
      palettes: { ...current.palettes, [targetMode]: [...current.palettes[sourceMode]] },
      colorAssignments: { ...current.colorAssignments, [targetMode]: { ...current.colorAssignments[sourceMode] } },
    }, result: undefined }));
    if (tab && revisions) tab.clearPendingCustomRevisions(targetMode, revisions);
  }

  async resetProfile(mode: ProfileMode): Promise<void> {
    const tab = this.settingsTab;
    const revisions = tab?.getPendingCustomRevisions(mode);
    await this.enqueueSettings((current) => ({ next: {
      ...current,
      profiles: { ...current.profiles, [mode]: { ...DEFAULT_PROFILE } },
      palettes: { ...current.palettes, [mode]: Array<string>(PALETTE_SIZE).fill("") },
      colorAssignments: { ...current.colorAssignments, [mode]: {} },
    }, result: undefined }));
    if (tab && revisions) tab.clearPendingCustomRevisions(mode, revisions);
  }

  async resetAllSettings(): Promise<void> {
    const tab = this.settingsTab;
    const lightRevisions = tab?.getPendingCustomRevisions("light");
    const darkRevisions = tab?.getPendingCustomRevisions("dark");
    await this.enqueueSettings((current) => ({ next: {
      ...DEFAULT_SETTINGS,
      uiProfile: current.uiProfile,
      profiles: { light: { ...DEFAULT_PROFILE }, dark: { ...DEFAULT_PROFILE } },
      palettes: { light: Array<string>(PALETTE_SIZE).fill(""), dark: Array<string>(PALETTE_SIZE).fill("") },
      colorAssignments: { light: {}, dark: {} },
    }, result: undefined }));
    if (tab && lightRevisions && darkRevisions) {
      tab.clearPendingCustomRevisions("light", lightRevisions);
      tab.clearPendingCustomRevisions("dark", darkRevisions);
    }
    new Notice("All overrides reset.");
  }

  exportSettingsJson(): void {
    const json = JSON.stringify(this.settings, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    // The factory creates in the main document; adopt into the active popout if needed.
    const anchor = activeDocument.adoptNode(createEl("a"));
    anchor.href = url;
    anchor.download = "theme-basics-settings.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  importSettingsJson(): void {
    // The factory creates in the main document; adopt into the active popout if needed.
    const input = activeDocument.adoptNode(createEl("input", { type: "file" }));
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const revision = ++this.settingsImportRevision;
      let importStarted = false;
      try {
        const json = await file.text();
        // A newer selected file takes precedence, but cancelling another dialog does not.
        if (revision !== this.settingsImportRevision) return;
        importStarted = true;
        const imported = await this.importSettingsIfCurrent(json, () => revision === this.settingsImportRevision);
        if (imported) new Notice("Settings imported successfully.");
      } catch (error) {
        // Ignore errors from reads superseded before import began, not failed saves.
        if (importStarted || revision === this.settingsImportRevision) {
          new Notice(`Failed to import settings: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    input.click();
  }

  async importSettings(json: string): Promise<void> {
    await this.importSettingsIfCurrent(json, () => true);
  }

  private async importSettingsIfCurrent(json: string, isCurrent: () => boolean): Promise<boolean> {
    const parsed: unknown = JSON.parse(json);
    this.validateSettingsImport(parsed);
    const tab = this.settingsTab;
    const lightRevisions = tab?.getPendingCustomRevisions("light");
    const darkRevisions = tab?.getPendingCustomRevisions("dark");
    // Recheck after earlier writes settle, before making or persisting the snapshot.
    const imported = await this.enqueueSettings(() => {
      if (!isCurrent()) return { next: null, result: false };
      return { next: this.normalizeSettings(parsed), result: true };
    });
    if (!imported) return false;
    if (tab && lightRevisions && darkRevisions) {
      tab.clearPendingCustomRevisions("light", lightRevisions);
      tab.clearPendingCustomRevisions("dark", darkRevisions);
    }
    // Definitions are cached even while the settings tab is closed (1.13+).
    this.settingsTab?.refreshDisplayPreserveScroll();
    return true;
  }

  async exportCssSnippet(): Promise<void> {
    let css: string;
    try {
      css = this.styleManager.generateSnippetCss();
    } catch (error) {
      new Notice(`Failed to generate CSS snippet: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const snippetsDir = normalizePath(`${this.app.vault.configDir}/snippets`);
    const snippetPath = normalizePath(`${snippetsDir}/theme-basics.css`);
    try {
      await this.app.vault.adapter.mkdir(snippetsDir);
    } catch {
      // Folder likely already exists — ignore
    }
    try {
      await this.app.vault.adapter.write(snippetPath, css);
      new Notice(
        `Snippet saved to ${snippetPath} — enable it in Appearance → CSS snippets.`
      );
    } catch (error) {
      new Notice("Failed to save CSS snippet. See console for details.");
      console.error("[Theme Basics] exportCssSnippet error:", error);
    }
  }

  async applyBase16Theme(
    yaml: string,
    mode: ProfileMode
  ): Promise<{ success: boolean; count: number }> {
    const colors = this.parseBase16Yaml(yaml);
    const count = Object.keys(colors).length;

    if (count === 0) {
      return { success: false, count: 0 };
    }

    await this.editPalette(mode, (palette) => {
      for (const [key, color] of Object.entries(colors)) {
        const index = Number.parseInt(key.slice(4), 16);
        palette[index] = color;
      }
    });
    return { success: true, count };
  }

  private async editPalette(mode: ProfileMode, edit: (palette: string[]) => void): Promise<void> {
    const changedLength = await this.enqueueSettings((current) => {
      const palette = [...current.palettes[mode]];
      edit(palette);
      return { next: { ...current, palettes: { ...current.palettes, [mode]: palette } },
        result: palette.length !== current.palettes[mode].length };
    });
    // Native declarative page definitions are cached, even if the user left the
    // row while persistence was pending. Rebuild them whenever slots were added.
    if (changedLength) this.settingsTab?.refreshDisplayPreserveScroll();
  }

  async addPaletteSlot(mode: ProfileMode): Promise<void> {
    await this.editPalette(mode, (palette) => { palette.push(""); });
  }

  async setPaletteColor(mode: ProfileMode, index: number, color: string): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || !isValidCssColor(color)) {
      throw new Error("Invalid palette color or slot.");
    }
    await this.editPalette(mode, (palette) => {
      if (index >= palette.length) throw new Error("Invalid palette color or slot.");
      palette[index] = color.trim();
    });
  }

  async importPaletteColors(
    mode: ProfileMode,
    input: string,
    format: "csv" | "json",
    operation: "append" | "replace"
  ): Promise<number> {
    const colors = parsePaletteColorList(input, format, isValidCssColor);
    if (operation !== "append" && operation !== "replace") throw new Error("Invalid palette import operation.");
    await this.editPalette(mode, (palette) => {
      if (operation === "append") {
        for (const color of colors) palette.push(color);
      } else {
        colors.forEach((color, index) => { palette[index] = color; });
      }
    });
    return colors.length;
  }

  async setColorAssignment(mode: ProfileMode, key: string, index: number): Promise<void> {
    if (!isColorProfileKey(key) || !Number.isInteger(index) || index < 0) throw new Error("Invalid color assignment.");
    const tab = this.settingsTab;
    const revision = tab?.getPendingCustomRevision(mode, key);
    await this.enqueueSettings((current) => {
      if (index >= current.palettes[mode].length) throw new Error("Invalid color assignment.");
      return { next: {
        ...current,
        profiles: { ...current.profiles, [mode]: { ...current.profiles[mode], [key]: "" } },
        colorAssignments: { ...current.colorAssignments, [mode]: { ...current.colorAssignments[mode], [key]: index } },
      }, result: undefined };
    });
    tab?.clearPendingCustomValueIfUnchanged(mode, key, revision);
  }

  /** Commit one custom draft to an existing matching slot or one new palette entry. */
  async commitCustomColor(mode: ProfileMode, key: string, color: string): Promise<number> {
    const value = color.trim();
    if (!isColorProfileKey(key) || !isValidCssColor(value)) throw new Error("Invalid custom color.");
    const result = await this.enqueueSettings((current) => {
      const palette = [...current.palettes[mode]];
      let slot = palette.findIndex((candidate) => candidate !== "" && this.styleManager.colorsMatch(candidate, value));
      const added = slot < 0;
      if (added) {
        slot = palette.length;
        palette.push(value);
      }
      return { next: {
        ...current,
        palettes: { ...current.palettes, [mode]: palette },
        profiles: { ...current.profiles, [mode]: { ...current.profiles[mode], [key]: "" } },
        colorAssignments: { ...current.colorAssignments, [mode]: { ...current.colorAssignments[mode], [key]: slot } },
      }, result: { slot, added } };
    });
    if (result.added) this.settingsTab?.refreshDisplayPreserveScroll();
    return result.slot;
  }

  getResolvedProfile(mode: ProfileMode): DefaultThemeStyleTunerProfile {
    const profile = cloneProfile(this.getProfile(mode));
    for (const [key, index] of Object.entries(this.settings.colorAssignments[mode])) {
      if (isColorProfileKey(key) && typeof index === "number") {
        profile[key] = this.settings.palettes[mode][index] ?? "";
      }
    }
    return profile;
  }

  private parseBase16Yaml(input: string): Record<string, string> {
    const colors: Record<string, string> = {};
    for (const line of input.split("\n")) {
      const match = line
        .trim()
        .match(/^(base0[0-9a-f])\s*:\s*(?:"(#?[0-9a-f]{6})"|'(#?[0-9a-f]{6})'|([0-9a-f]{6}))\s*(?:#.*)?$/i);
      const key = match?.[1];
      const hex = match?.[2] ?? match?.[3] ?? match?.[4];
      if (key && hex) {
        colors[key.toLowerCase()] = "#" + hex.replace(/^#/, "").toLowerCase();
      }
    }
    return colors;
  }

  private registerCommands(): void {
    this.addCommand({
      id: "reset-current-profile-overrides",
      name: "Reset current theme profile overrides",
      callback: async () => {
        const mode = this.getAppliedProfileMode();
        await this.resetProfile(mode);
        this.settingsTab?.refreshDisplayPreserveScroll();
        new Notice(`${PROFILE_LABELS[mode]} profile reset.`);
      },
    });

    this.addCommand({
      id: "reset-all-overrides",
      name: "Reset all style overrides",
      callback: async () => {
        await this.resetAllSettings();
        this.settingsTab?.refreshDisplayPreserveScroll();
      },
    });

    this.addCommand({
      id: "export-settings-json",
      name: "Export settings as JSON",
      callback: () => {
        this.exportSettingsJson();
      },
    });

    this.addCommand({
      id: "import-settings-json",
      name: "Import settings from JSON",
      callback: () => {
        this.importSettingsJson();
      },
    });

    this.addCommand({
      id: "export-css-snippet",
      name: "Export current styles as CSS snippet",
      callback: async () => {
        await this.exportCssSnippet();
      },
    });
  }

  private validateSettingsImport(loaded: unknown): void {
    if (!isObject(loaded)) {
      throw new Error("Expected a settings object.");
    }
    const validateProfile = (profile: unknown): void => {
      if (!isObject(profile) || PROFILE_KEYS.some((key) => key in profile && typeof profile[key] !== "string")) {
        throw new Error("Profiles must be objects containing string values.");
      }
      if (Object.keys(profile).length > 0 && !PROFILE_KEYS.some((key) => key in profile)) {
        throw new Error("No recognized profile settings found.");
      }
    };
    if ("version" in loaded || "profiles" in loaded) {
      if ((loaded.version !== 2 && loaded.version !== 3 && loaded.version !== 4) || !isObject(loaded.profiles)) {
        throw new Error("Unsupported settings version or missing profiles.");
      }
      if (loaded.uiProfile !== "light" && loaded.uiProfile !== "dark") {
        throw new Error("The profile to edit must be light or dark.");
      }
      validateProfile(loaded.profiles.light);
      validateProfile(loaded.profiles.dark);
      if (loaded.version === 3 || loaded.version === 4) {
        if (!isObject(loaded.palettes) || !isObject(loaded.colorAssignments)) {
          throw new Error("Missing palettes or color assignments.");
        }
        for (const mode of ["light", "dark"]) {
          const palette = loaded.palettes[mode];
          const assignments = loaded.colorAssignments[mode];
          if (!Array.isArray(palette) || palette.length < PALETTE_SIZE ||
              (loaded.version === 3 && palette.length !== PALETTE_SIZE) ||
              palette.some((color: unknown) => typeof color !== "string" || (color !== "" &&
                (loaded.version === 3 ? !/^#[0-9a-f]{6}$/i.test(color) : !isValidCssColor(color))))) {
            throw new Error("Each palette must contain at least 16 valid colors or empty slots.");
          }
          if (!isObject(assignments) || Object.entries(assignments).some(([key, index]) =>
            !isColorProfileKey(key) || typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= palette.length
          )) {
            throw new Error("Invalid color assignments.");
          }
        }
      }
      return;
    }
    if (!PROFILE_KEYS.some((key) => key in loaded)) {
      throw new Error("No recognized profile settings found.");
    }
    validateProfile(loaded);
  }

  private normalizeSettings(loaded: unknown): DefaultThemeStyleTunerSettings {
    const preferredProfile =
      isObject(loaded) && loaded.uiProfile === "dark"
        ? "dark"
        : isObject(loaded) && loaded.uiProfile === "light"
          ? "light"
          : this.getThemeMode();

    const profiles = isObject(loaded) && isObject(loaded.profiles) ? loaded.profiles : null;
    const legacy = isObject(loaded) && PROFILE_KEYS.some((key) => key in loaded) ? loaded : {};
    const paletteVersion = isObject(loaded) && (loaded.version === 3 || loaded.version === 4) ? loaded.version : null;
    const palettes = paletteVersion && isObject(loaded) && isObject(loaded.palettes) ? loaded.palettes : {};
    const assignments = paletteVersion && isObject(loaded) && isObject(loaded.colorAssignments) ? loaded.colorAssignments : {};
    const lightPalette = this.normalizePalette(palettes.light, paletteVersion);
    const darkPalette = this.normalizePalette(palettes.dark, paletteVersion);
    return {
      version: 4,
      uiProfile: preferredProfile,
      profiles: {
        light: this.normalizeProfile(profiles ? profiles.light : legacy),
        dark: this.normalizeProfile(profiles ? profiles.dark : legacy),
      },
      palettes: { light: lightPalette, dark: darkPalette },
      colorAssignments: {
        light: this.normalizeAssignments(assignments.light, lightPalette.length),
        dark: this.normalizeAssignments(assignments.dark, darkPalette.length),
      },
    };
  }

  private normalizePalette(source: unknown, version: number | null): string[] {
    if (!Array.isArray(source)) return Array<string>(PALETTE_SIZE).fill("");
    const colors: unknown[] = source;
    return colors.map((color) => {
      if (typeof color !== "string") throw new Error("Invalid palette color.");
      return version === 3 ? color.toLowerCase() : color;
    });
  }

  private normalizeAssignments(source: unknown, paletteLength: number): Partial<Record<keyof DefaultThemeStyleTunerProfile, number>> {
    const result: Partial<Record<keyof DefaultThemeStyleTunerProfile, number>> = {};
    if (!isObject(source)) return result;
    for (const [key, index] of Object.entries(source)) {
      if (isColorProfileKey(key) && typeof index === "number" && Number.isInteger(index) && index >= 0 && index < paletteLength) {
        result[key] = index;
      }
    }
    return result;
  }

  private normalizeProfile(source: unknown): DefaultThemeStyleTunerProfile {
    const normalizedProfile: DefaultThemeStyleTunerProfile = { ...DEFAULT_PROFILE };
    if (!isObject(source)) {
      return normalizedProfile;
    }

    const mutableProfile = normalizedProfile as Record<keyof DefaultThemeStyleTunerProfile, string>;

    for (const key of PROFILE_KEYS) {
      const nextValue = source[key];
      if (typeof nextValue !== "string") continue;
      const sanitized = sanitizeCssValue(nextValue);
      // Keep safe legacy values byte-for-byte; rejected or structurally unsafe CSS
      // must still pass through the existing sanitizer.
      mutableProfile[key] = sanitized && !/[;{}]/.test(nextValue) ? nextValue : sanitized;
    }

    return normalizedProfile;
  }
}

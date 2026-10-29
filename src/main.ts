import { debounce, normalizePath, Notice, Plugin } from "obsidian";

import { DEFAULT_PROFILE, DEFAULT_SETTINGS, isColorProfileKey, PALETTE_SIZE, PROFILE_KEYS, PROFILE_LABELS } from "./constants";
import { DefaultThemeStyleTunerSettingTab } from "./settings-tab";
import { StyleManager } from "./style-manager";
import { cloneProfile, isObject, sanitizeCssValue } from "./utils";

import type {
  DefaultThemeStyleTunerProfile,
  DefaultThemeStyleTunerSettings,
  ProfileMode,
} from "./types";

export default class DefaultThemeStyleTunerPlugin extends Plugin {
  override settings!: DefaultThemeStyleTunerSettings;
  readonly styleManager = new StyleManager(this);
  private settingsTab: DefaultThemeStyleTunerSettingTab | null = null;

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
      if (loadedSettings.version === 3) this.validateSettingsImport(loadedSettings);
    }
    this.settings = this.normalizeSettings(loadedSettings);
    await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.styleManager.applyStyles();
  }

  async setEditedProfileMode(mode: ProfileMode): Promise<void> {
    this.settings.uiProfile = mode;
    await this.saveData(this.settings);
  }

  async setProfileValue<Key extends keyof DefaultThemeStyleTunerProfile>(
    mode: ProfileMode,
    key: Key,
    value: DefaultThemeStyleTunerProfile[Key]
  ): Promise<void> {
    const profile = this.getProfile(mode);
    profile[key] = sanitizeCssValue(typeof value === "string" ? value : "") as DefaultThemeStyleTunerProfile[Key];
    delete this.settings.colorAssignments[mode][key];
    await this.saveSettings();
  }

  async resetProfileValue<Key extends keyof DefaultThemeStyleTunerProfile>(
    mode: ProfileMode,
    key: Key
  ): Promise<void> {
    const profile = this.getProfile(mode) as Record<keyof DefaultThemeStyleTunerProfile, string>;
    const defaultProfile = DEFAULT_PROFILE as Record<keyof DefaultThemeStyleTunerProfile, string>;
    profile[key] = defaultProfile[key];
    delete this.settings.colorAssignments[mode][key];
    await this.saveSettings();
  }

  async resetProfileValues(
    mode: ProfileMode,
    keys: ReadonlyArray<keyof DefaultThemeStyleTunerProfile>
  ): Promise<void> {
    const profile = this.getProfile(mode) as Record<keyof DefaultThemeStyleTunerProfile, string>;
    const defaultProfile = DEFAULT_PROFILE as Record<keyof DefaultThemeStyleTunerProfile, string>;

    for (const key of keys) {
      profile[key] = defaultProfile[key];
      delete this.settings.colorAssignments[mode][key];
    }

    await this.saveSettings();
  }

  async copyProfile(sourceMode: ProfileMode, targetMode: ProfileMode): Promise<void> {
    this.settings.profiles[targetMode] = cloneProfile(this.settings.profiles[sourceMode]);
    this.settings.palettes[targetMode] = [...this.settings.palettes[sourceMode]];
    this.settings.colorAssignments[targetMode] = { ...this.settings.colorAssignments[sourceMode] };
    await this.saveSettings();
  }

  async resetProfile(mode: ProfileMode): Promise<void> {
    this.settings.profiles[mode] = { ...DEFAULT_PROFILE };
    this.settings.palettes[mode] = Array<string>(PALETTE_SIZE).fill("");
    this.settings.colorAssignments[mode] = {};
    await this.saveSettings();
  }

  async resetAllSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      uiProfile: this.getEditedProfileMode(),
      profiles: {
        light: { ...DEFAULT_PROFILE },
        dark: { ...DEFAULT_PROFILE },
      },
      palettes: { light: Array<string>(PALETTE_SIZE).fill(""), dark: Array<string>(PALETTE_SIZE).fill("") },
      colorAssignments: { light: {}, dark: {} },
    };

    await this.saveSettings();
    new Notice("All overrides reset.");
  }

  exportSettingsJson(): void {
    const json = JSON.stringify(this.settings, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = activeDocument.createEl("a");
    anchor.href = url;
    anchor.download = "theme-basics-settings.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  importSettingsJson(): void {
    const input = activeDocument.createEl("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const MAX_IMPORT_SIZE = 1024 * 1024; // 1 MB
      if (file.size > MAX_IMPORT_SIZE) {
        new Notice("Import failed: file exceeds 1mb size limit.");
        return;
      }
      try {
        await this.importSettings(await file.text());
        new Notice("Settings imported successfully.");
      } catch (error) {
        new Notice(`Failed to import settings: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    input.click();
  }

  async importSettings(json: string): Promise<void> {
    const parsed: unknown = JSON.parse(json);
    this.validateSettingsImport(parsed);
    const settings = this.normalizeSettings(parsed);
    // Do not replace the current profiles until validation and persistence succeed.
    await this.saveData(settings);
    this.settings = settings;
    this.styleManager.applyStyles();
    // Definitions are cached even while the settings tab is closed (1.13+).
    this.settingsTab?.refreshDisplayPreserveScroll();
  }

  async exportCssSnippet(): Promise<void> {
    const css = this.styleManager.generateSnippetCss();
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

    for (const [key, color] of Object.entries(colors)) {
      const index = Number.parseInt(key.slice(4), 16);
      this.settings.palettes[mode][index] = color;
    }

    await this.saveSettings();
    return { success: true, count };
  }

  async setPaletteColor(mode: ProfileMode, index: number, color: string): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || index >= PALETTE_SIZE || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new Error("Invalid palette color or slot.");
    }
    this.settings.palettes[mode][index] = color.toLowerCase();
    await this.saveSettings();
  }

  async setColorAssignment(mode: ProfileMode, key: string, index: number): Promise<void> {
    if (!isColorProfileKey(key) || !Number.isInteger(index) || index < 0 || index >= PALETTE_SIZE) {
      throw new Error("Invalid color assignment.");
    }
    this.settings.colorAssignments[mode][key] = index;
    this.settings.profiles[mode][key] = "";
    await this.saveSettings();
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
      if ((loaded.version !== 2 && loaded.version !== 3) || !isObject(loaded.profiles)) {
        throw new Error("Unsupported settings version or missing profiles.");
      }
      if (loaded.uiProfile !== "light" && loaded.uiProfile !== "dark") {
        throw new Error("The profile to edit must be light or dark.");
      }
      validateProfile(loaded.profiles.light);
      validateProfile(loaded.profiles.dark);
      if (loaded.version === 3) {
        if (!isObject(loaded.palettes) || !isObject(loaded.colorAssignments)) {
          throw new Error("Missing palettes or color assignments.");
        }
        for (const mode of ["light", "dark"]) {
          const palette = loaded.palettes[mode];
          const assignments = loaded.colorAssignments[mode];
          if (!Array.isArray(palette) || palette.length !== PALETTE_SIZE ||
              palette.some((color: unknown) => typeof color !== "string" || (color !== "" && !/^#[0-9a-f]{6}$/i.test(color)))) {
            throw new Error("Each palette must contain 16 valid colors or empty slots.");
          }
          if (!isObject(assignments) || Object.entries(assignments).some(([key, index]) =>
            !isColorProfileKey(key) || typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= PALETTE_SIZE
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
    const palettes = isObject(loaded) && loaded.version === 3 && isObject(loaded.palettes) ? loaded.palettes : {};
    const assignments = isObject(loaded) && loaded.version === 3 && isObject(loaded.colorAssignments) ? loaded.colorAssignments : {};
    return {
      version: 3,
      uiProfile: preferredProfile,
      profiles: {
        light: this.normalizeProfile(profiles ? profiles.light : legacy),
        dark: this.normalizeProfile(profiles ? profiles.dark : legacy),
      },
      palettes: {
        light: this.normalizePalette(palettes.light),
        dark: this.normalizePalette(palettes.dark),
      },
      colorAssignments: {
        light: this.normalizeAssignments(assignments.light),
        dark: this.normalizeAssignments(assignments.dark),
      },
    };
  }

  private normalizePalette(source: unknown): string[] {
    return Array.from({ length: PALETTE_SIZE }, (_, index) => {
      const color: unknown = Array.isArray(source) ? source[index] : undefined;
      return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "";
    });
  }

  private normalizeAssignments(source: unknown): Partial<Record<keyof DefaultThemeStyleTunerProfile, number>> {
    const result: Partial<Record<keyof DefaultThemeStyleTunerProfile, number>> = {};
    if (!isObject(source)) return result;
    for (const [key, index] of Object.entries(source)) {
      if (isColorProfileKey(key) && typeof index === "number" && Number.isInteger(index) && index >= 0 && index < PALETTE_SIZE) {
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

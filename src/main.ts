import { debounce, normalizePath, Notice, Plugin } from "obsidian";

import { DEFAULT_PROFILE, DEFAULT_SETTINGS, PROFILE_KEYS, PROFILE_LABELS } from "./constants";
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
    this.register(() => { this.settingsTab = null; });
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
    await this.saveSettings();
  }

  async resetProfileValue<Key extends keyof DefaultThemeStyleTunerProfile>(
    mode: ProfileMode,
    key: Key
  ): Promise<void> {
    const profile = this.getProfile(mode) as Record<keyof DefaultThemeStyleTunerProfile, string>;
    const defaultProfile = DEFAULT_PROFILE as Record<keyof DefaultThemeStyleTunerProfile, string>;
    profile[key] = defaultProfile[key];
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
    }

    await this.saveSettings();
  }

  async copyProfile(sourceMode: ProfileMode, targetMode: ProfileMode): Promise<void> {
    this.settings.profiles[targetMode] = cloneProfile(this.settings.profiles[sourceMode]);
    await this.saveSettings();
  }

  async resetProfile(mode: ProfileMode): Promise<void> {
    this.settings.profiles[mode] = { ...DEFAULT_PROFILE };
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

    const profile = this.getProfile(mode);

    const apply = (key: keyof DefaultThemeStyleTunerProfile, hex: string | undefined): void => {
      if (!hex) return;
      profile[key] = sanitizeCssValue(hex);
    };

    // Backgrounds — base00 = primary, base01 = secondary surfaces, base02 = selection / alt
    apply("backgroundPrimary", colors["base00"]);
    apply("backgroundSecondary", colors["base01"]);
    apply("backgroundPrimaryAlt", colors["base01"]);
    apply("backgroundSecondaryAlt", colors["base02"]);

    // Text hierarchy — base03 = faint, base04 = muted, base05 = body text
    apply("textFaint", colors["base03"]);
    apply("textMuted", colors["base04"]);
    apply("textNormal", colors["base05"]);

    // Links
    apply("linkColor", colors["base0d"]);           // blue  — functions / links
    apply("externalLinkColor", colors["base0c"]);   // cyan  — support / escape chars
    apply("unresolvedLinkColor", colors["base03"]); // faint — unresolved links

    // Emphasis
    apply("italicColor", colors["base0e"]);          // purple — keywords / italic

    // Highlight — base0A (yellow) at ~30 % opacity via rgba()
    const highlightHex = colors["base0a"];
    if (highlightHex) {
      apply("highlightBackground", this.hexToRgba(highlightHex, 0.3));
    }

    // Horizontal rule
    apply("hrColor", colors["base02"]);

    // Blockquotes
    apply("blockquoteColor", colors["base05"]);
    apply("blockquoteBackgroundColor", colors["base01"]);
    apply("blockquoteBorderColor", colors["base0d"]);

    // Inline / fenced code — green (strings) on secondary background
    apply("codeNormal", colors["base0b"]);
    apply("codeBackground", colors["base01"]);

    // Tags
    apply("tagColor", colors["base0a"]);
    apply("tagBackground", colors["base01"]);
    apply("tagBorderColor", colors["base0a"]);

    // Headings — accent rainbow: blue → purple → cyan → green → orange → red
    apply("h1Color", colors["base0d"]);
    apply("h2Color", colors["base0e"]);
    apply("h3Color", colors["base0c"]);
    apply("h4Color", colors["base0b"]);
    apply("h5Color", colors["base09"]);
    apply("h6Color", colors["base08"]);

    await this.saveSettings();
    return { success: true, count };
  }

  private hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
        new Notice(`${PROFILE_LABELS[mode]} profile reset.`);
      },
    });

    this.addCommand({
      id: "reset-all-overrides",
      name: "Reset all style overrides",
      callback: async () => {
        await this.resetAllSettings();
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
      if (loaded.version !== DEFAULT_SETTINGS.version || !isObject(loaded.profiles)) {
        throw new Error("Unsupported settings version or missing profiles.");
      }
      if (loaded.uiProfile !== "light" && loaded.uiProfile !== "dark") {
        throw new Error("The profile to edit must be light or dark.");
      }
      validateProfile(loaded.profiles.light);
      validateProfile(loaded.profiles.dark);
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

    if (
      isObject(loaded) &&
      typeof loaded.version === "number" &&
      isObject(loaded.profiles)
    ) {
      return {
        version: 2,
        uiProfile: preferredProfile,
        profiles: {
          light: this.normalizeProfile(loaded.profiles.light),
          dark: this.normalizeProfile(loaded.profiles.dark),
        },
      };
    }

    // Treat bare objects that contain profile keys as a legacy single profile.
    if (isObject(loaded) && PROFILE_KEYS.some((k) => k in loaded)) {
      return {
        version: 2,
        uiProfile: preferredProfile,
        profiles: {
          light: this.normalizeProfile(loaded),
          dark: this.normalizeProfile(loaded),
        },
      };
    }

    return {
      version: 2,
      uiProfile: preferredProfile,
      profiles: {
        light: this.normalizeProfile({}),
        dark: this.normalizeProfile({}),
      },
    };
  }

  private normalizeProfile(source: unknown): DefaultThemeStyleTunerProfile {
    const normalizedProfile: DefaultThemeStyleTunerProfile = { ...DEFAULT_PROFILE };
    if (!isObject(source)) {
      return normalizedProfile;
    }

    const mutableProfile = normalizedProfile as Record<keyof DefaultThemeStyleTunerProfile, string>;

    for (const key of PROFILE_KEYS) {
      const nextValue = source[key];
      mutableProfile[key] = typeof nextValue === "string" ? sanitizeCssValue(nextValue) : "";
    }

    return normalizedProfile;
  }
}

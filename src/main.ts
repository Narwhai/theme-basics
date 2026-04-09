import { Notice, Plugin } from "obsidian";

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
  settings!: DefaultThemeStyleTunerSettings;
  readonly styleManager = new StyleManager(this);

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.styleManager.refreshThemeDefaults();
    this.styleManager.applyStyles();

    this.addSettingTab(new DefaultThemeStyleTunerSettingTab(this.app, this));
    this.registerCommands();

    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        this.styleManager.refreshThemeDefaults();
        this.styleManager.applyStyles();
      })
    );
  }

  override onunload(): void {
    this.styleManager.cleanup();
  }

  getThemeMode(): ProfileMode {
    return document.body.classList.contains("theme-dark") ? "dark" : "light";
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
    const defaultValue = DEFAULT_PROFILE[key];

    if (typeof defaultValue === "boolean") {
      profile[key] = (typeof value === "boolean" ? value : defaultValue) as DefaultThemeStyleTunerProfile[Key];
    } else {
      profile[key] = sanitizeCssValue(typeof value === "string" ? value : "") as DefaultThemeStyleTunerProfile[Key];
    }

    await this.saveSettings();
  }

  async resetProfileValue<Key extends keyof DefaultThemeStyleTunerProfile>(
    mode: ProfileMode,
    key: Key
  ): Promise<void> {
    const profile = this.getProfile(mode) as Record<keyof DefaultThemeStyleTunerProfile, string | boolean>;
    const defaultProfile = DEFAULT_PROFILE as Record<keyof DefaultThemeStyleTunerProfile, string | boolean>;
    profile[key] = defaultProfile[key];
    await this.saveSettings();
  }

  async resetProfileValues(
    mode: ProfileMode,
    keys: ReadonlyArray<keyof DefaultThemeStyleTunerProfile>
  ): Promise<void> {
    const profile = this.getProfile(mode) as Record<keyof DefaultThemeStyleTunerProfile, string | boolean>;
    const defaultProfile = DEFAULT_PROFILE as Record<keyof DefaultThemeStyleTunerProfile, string | boolean>;

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
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "theme-basics-settings.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  importSettingsJson(onSuccess: () => void): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed: unknown = JSON.parse(text);
        this.settings = this.normalizeSettings(parsed);
        await this.saveSettings();
        new Notice("Settings imported successfully.");
        onSuccess();
      } catch {
        new Notice("Failed to import settings: the file is not valid JSON.");
      }
    };
    input.click();
  }

  async exportCssSnippet(): Promise<void> {
    const css = this.styleManager.generateSnippetCss();
    const snippetPath = ".obsidian/snippets/theme-basics.css";
    try {
      await this.app.vault.adapter.mkdir(".obsidian/snippets");
    } catch {
      // Folder likely already exists — ignore
    }
    try {
      await this.app.vault.adapter.write(snippetPath, css);
      new Notice(
        "Snippet saved to .obsidian/snippets/theme-basics.css — enable it in Appearance → CSS snippets."
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

    const profile = this.getProfile(mode) as Record<
      keyof DefaultThemeStyleTunerProfile,
      string | boolean
    >;

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
        .match(/^(base[0-9A-Fa-f]{2})\s*:\s*["']?([0-9A-Fa-f]{6})["']?/i);
      if (match) {
        colors[match[1]!.toLowerCase()] = "#" + match[2]!.toLowerCase();
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
        this.importSettingsJson(() => {});
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

  private normalizeSettings(loaded: unknown): DefaultThemeStyleTunerSettings {
    const preferredProfile =
      isObject(loaded) && loaded.uiProfile === "dark"
        ? "dark"
        : isObject(loaded) && loaded.uiProfile === "light"
          ? "light"
          : this.getThemeMode();

    if (isObject(loaded) && isObject(loaded.profiles)) {
      return {
        version: 2,
        uiProfile: preferredProfile,
        profiles: {
          light: this.normalizeProfile(loaded.profiles.light),
          dark: this.normalizeProfile(loaded.profiles.dark),
        },
      };
    }

    return {
      version: 2,
      uiProfile: preferredProfile,
      profiles: {
        light: this.normalizeProfile(loaded),
        dark: this.normalizeProfile(loaded),
      },
    };
  }

  private normalizeProfile(source: unknown): DefaultThemeStyleTunerProfile {
    const normalizedProfile: DefaultThemeStyleTunerProfile = { ...DEFAULT_PROFILE };
    if (!isObject(source)) {
      return normalizedProfile;
    }

    const mutableProfile = normalizedProfile as Record<keyof DefaultThemeStyleTunerProfile, string | boolean>;
    const defaultProfile = DEFAULT_PROFILE as Record<keyof DefaultThemeStyleTunerProfile, string | boolean>;

    for (const key of PROFILE_KEYS) {
      const nextValue = source[key];
      const defaultValue = defaultProfile[key];

      if (typeof defaultValue === "boolean") {
        mutableProfile[key] = typeof nextValue === "boolean" ? nextValue : defaultValue;
        continue;
      }

      mutableProfile[key] = typeof nextValue === "string" ? sanitizeCssValue(nextValue) : "";
    }

    return normalizedProfile;
  }
}

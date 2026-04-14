import { BODY_CLASS, CSS_VARIABLE_NAMES, CSS_VARIABLES } from "./constants";
import { clamp, formatNumber, rgbToHsl, sanitizeCssValue } from "./utils";

import type DefaultThemeStyleTunerPlugin from "./main";
import type { ProfileMode, RgbColor, StringProfileKey } from "./types";

const CAPTURED_THEME_VARIABLE_NAMES = [
  ...CSS_VARIABLE_NAMES,
  "--tag-border-width",
] as const;

const APPLIED_STYLE_VARIABLE_NAMES = [
  ...CAPTURED_THEME_VARIABLE_NAMES,
  "--tag-color-hover",
  "--tag-background-hover",
  "--tag-border-color-hover",
] as const;

export class StyleManager {
  private themeDefaults: Record<ProfileMode, Record<string, string>> = {
    light: {},
    dark: {},
  };

  constructor(private readonly plugin: DefaultThemeStyleTunerPlugin) { }

  cleanup(): void {
    document.body.classList.remove(BODY_CLASS);
    this.clearCssVariables();
  }

  refreshThemeDefaults(): void {
    const wasLightTheme = document.body.classList.contains("theme-light");
    const wasDarkTheme = document.body.classList.contains("theme-dark");
    const hadPluginClass = document.body.classList.contains(BODY_CLASS);
    const previousInlineValues = this.captureInlineVariableValues(APPLIED_STYLE_VARIABLE_NAMES);

    if (hadPluginClass) {
      document.body.classList.remove(BODY_CLASS);
    }

    this.clearCssVariables();

    this.themeDefaults = {
      light: this.captureThemeDefaultsForMode("light"),
      dark: this.captureThemeDefaultsForMode("dark"),
    };

    document.body.classList.toggle("theme-light", wasLightTheme);
    document.body.classList.toggle("theme-dark", wasDarkTheme);
    this.restoreInlineVariableValues(previousInlineValues);

    if (hadPluginClass) {
      document.body.classList.add(BODY_CLASS);
    }
  }

  getThemeDefaultVariableValue(variableName: string, mode: ProfileMode): string {
    return this.themeDefaults[mode]?.[variableName] ?? "";
  }

  getDefaultNumericValue(
    mode: ProfileMode,
    key: StringProfileKey,
    variableName: string,
    fallbackNumber: number
  ): number {
    const explicitValue = this.plugin.getProfile(mode)[key];
    const parsedValue = Number.parseFloat(
      explicitValue || this.getThemeDefaultVariableValue(variableName, mode)
    );

    return Number.isFinite(parsedValue) ? parsedValue : fallbackNumber;
  }

  getDefaultColorValue(mode: ProfileMode, key: StringProfileKey, variableName: string): string {
    const pickerHex = this.tryToPickerHex(
      this.plugin.getProfile(mode)[key] || this.getThemeDefaultVariableValue(variableName, mode)
    );
    if (pickerHex) {
      return pickerHex;
    }

    // Some color variables (e.g. --h1-color, --bold-color) are not defined as
    // standalone custom properties by the theme.  The corresponding CSS rules
    // use `var(--h1-color)` without a fallback, which causes Obsidian to
    // treat the property as "invalid at computed-value time" and inherit from
    // the parent – effectively inheriting --text-normal.  Mirror that behaviour
    // in the picker so the swatch shows the correct inherited colour instead of
    // the hardcoded #000000 fallback.
    return this.tryToPickerHex(
      this.getThemeDefaultVariableValue("--text-normal", mode)
    ) ?? "#000000";
  }

  ensureWithinRange(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) {
      return fallback;
    }

    return clamp(value, min, max);
  }

  tryToPickerHex(value: string): string | null {
    const sanitizedValue = sanitizeCssValue(value);
    if (!sanitizedValue) {
      return null;
    }

    if (/^#[0-9a-f]{6}$/i.test(sanitizedValue)) {
      return sanitizedValue;
    }

    if (!CSS.supports("color", sanitizedValue)) {
      return null;
    }

    const probe = document.createElement("div");
    probe.setCssProps({ color: sanitizedValue });
    document.body.append(probe);
    const resolvedColor = getComputedStyle(probe).color;
    probe.remove();

    const match = resolvedColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) {
      return null;
    }

    const [, red, green, blue] = match;
    return `#${Number(red).toString(16).padStart(2, "0")}${Number(green)
      .toString(16)
      .padStart(2, "0")}${Number(blue).toString(16).padStart(2, "0")}`;
  }

  buildCssPropertiesForMode(mode: ProfileMode): Record<string, string> {
    const profile = this.plugin.getProfile(mode);
    const effectiveProfile = {
      ...profile,
      linkHoverColor: profile.linkColor
        ? this.computeAutoHoverColor(mode, profile.linkColor)
        : "",
      externalLinkHoverColor: profile.externalLinkColor
        ? this.computeAutoHoverColor(mode, profile.externalLinkColor)
        : "",
    };

    const cssProps: Record<string, string> = Object.fromEntries(
      Object.entries(CSS_VARIABLES)
        .map(([key, variableName]) => [
          variableName,
          sanitizeCssValue(effectiveProfile[key as StringProfileKey]),
        ] as const)
        .filter(([, value]) => Boolean(value))
    );

    const tagColor = sanitizeCssValue(profile.tagColor);
    const tagBackground = sanitizeCssValue(profile.tagBackground);
    const tagBorderColor = sanitizeCssValue(profile.tagBorderColor);
    const tagHoverBackground = tagBackground
      ? this.computeAutoHoverColor(mode, tagBackground)
      : "";

    if (tagColor) {
      cssProps["--tag-color-hover"] = tagColor;
    }

    if (tagHoverBackground) {
      cssProps["--tag-background-hover"] = tagHoverBackground;
    }

    if (tagBorderColor) {
      cssProps["--tag-border-color-hover"] = tagBorderColor;

      const themeBorderWidth = Number.parseFloat(
        this.getThemeDefaultVariableValue("--tag-border-width", mode)
      );
      if (!Number.isFinite(themeBorderWidth) || themeBorderWidth <= 0) {
        cssProps["--tag-border-width"] = "1px";
      }
    }

    return cssProps;
  }

  applyStyles(): void {
    document.body.classList.add(BODY_CLASS);
    this.clearCssVariables();
    const appliedMode = this.plugin.getAppliedProfileMode();
    document.body.setCssProps(this.buildCssPropertiesForMode(appliedMode));
  }

  generateSnippetCss(): string {
    const timestamp = new Date().toISOString().split("T")[0];
    const lines: string[] = [
      `/* Generated by Theme Basics plugin on ${timestamp} */`,
      `/* This snippet applies the same CSS variable overrides as the plugin. */`,
      `/* Disable the plugin and enable this snippet for a standalone equivalent. */`,
      "",
    ];

    const addBlock = (selector: string, props: Record<string, string>): void => {
      const entries = Object.entries(props);
      if (entries.length === 0) return;
      lines.push(`${selector} {`);
      for (const [prop, value] of entries) {
        lines.push(`  ${prop}: ${value};`);
      }
      lines.push(`}`, ``);
    };

    addBlock("body.theme-light", this.buildCssPropertiesForMode("light"));
    addBlock("body.theme-dark", this.buildCssPropertiesForMode("dark"));

    // If both profiles were empty, note that in the file
    if (lines.length === 4) {
      lines.push(`/* No overrides are currently set — nothing to export. */`, ``);
    }

    return lines.join("\n").trimEnd() + "\n";
  }

  private clearCssVariables(): void {
    for (const variableName of APPLIED_STYLE_VARIABLE_NAMES) {
      document.body.style.removeProperty(variableName);
    }
  }

  private captureThemeDefaultsForMode(mode: ProfileMode): Record<string, string> {
    document.body.classList.toggle("theme-light", mode === "light");
    document.body.classList.toggle("theme-dark", mode === "dark");

    const computedStyle = getComputedStyle(document.body);
    return Object.fromEntries(
      CAPTURED_THEME_VARIABLE_NAMES.map((variableName) => [
        variableName,
        computedStyle.getPropertyValue(variableName).trim(),
      ])
    );
  }

  private captureInlineVariableValues(variableNames: readonly string[]): Record<string, string> {
    return Object.fromEntries(
      variableNames.map((variableName) => [variableName, document.body.style.getPropertyValue(variableName)])
    );
  }

  private restoreInlineVariableValues(values: Record<string, string>): void {
    for (const [variableName, value] of Object.entries(values)) {
      if (value) {
        document.body.style.setProperty(variableName, value);
      } else {
        document.body.style.removeProperty(variableName);
      }
    }
  }

  private resolveColorToRgb(value: string): RgbColor | null {
    const sanitizedValue = sanitizeCssValue(value);
    if (!sanitizedValue || !CSS.supports("color", sanitizedValue)) {
      return null;
    }

    const probe = document.createElement("div");
    probe.setCssProps({ color: sanitizedValue });
    document.body.append(probe);
    const resolvedColor = getComputedStyle(probe).color;
    probe.remove();

    const match = resolvedColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
    if (!match) {
      return null;
    }

    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] ? Number(match[4]) : 1,
    };
  }

  private computeAutoHoverColor(mode: ProfileMode, baseValue: string): string {
    const rgbColor = this.resolveColorToRgb(baseValue);
    if (!rgbColor) {
      return "";
    }

    const hslColor = rgbToHsl(rgbColor.r, rgbColor.g, rgbColor.b);
    const hoverLightnessDelta = mode === "dark" ? 3.8 : 5;
    const hoverLightness = clamp(hslColor.l + hoverLightnessDelta, 0, 100);

    return `hsl(${formatNumber(hslColor.h, 1)}, ${formatNumber(hslColor.s, 1)}%, ${formatNumber(hoverLightness, 1)}%)`;
  }
}

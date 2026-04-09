import {
  App,
  ColorComponent,
  ExtraButtonComponent,
  Notice,
  PluginSettingTab,
  Setting,
  SliderComponent,
} from "obsidian";

import {
  ADVANCED_BLOCKQUOTE_OPTIONS,
  ADVANCED_CODE_COLOR_OPTIONS,
  ADVANCED_CODE_SLIDER_OPTIONS,
  ADVANCED_LIST_COLOR_OPTIONS,
  ADVANCED_LIST_OPTIONS,
  ADVANCED_TAG_OPTIONS,
  COLOR_OPTIONS_BY_KEY,
  HEADING_DEFAULTS,
  HEADING_LEVELS,
  PROFILE_LABELS,
  TYPOGRAPHY_COLOR_OPTIONS,
  TYPOGRAPHY_OPTIONS,
} from "./constants";
import { formatNumber } from "./utils";

import type DefaultThemeStyleTunerPlugin from "./main";
import type { ColorOption, HeadingLevel, ProfileMode, SliderOption } from "./types";

export class DefaultThemeStyleTunerSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DefaultThemeStyleTunerPlugin) {
    super(app, plugin);
  }

  refreshDisplayPreserveScroll(): void {
    const containers = [this.containerEl, this.containerEl.parentElement].filter(
      (element): element is HTMLElement => element instanceof HTMLElement
    );
    const scrollPositions = containers.map((element) => ({
      element,
      top: element.scrollTop,
    }));

    this.display();

    const restoreScrollPosition = (): void => {
      for (const { element, top } of scrollPositions) {
        element.scrollTop = top;
      }
    };

    restoreScrollPosition();
    requestAnimationFrame(() => {
      restoreScrollPosition();
      requestAnimationFrame(() => {
        restoreScrollPosition();
      });
    });
  }

  override display(): void {
    const { containerEl } = this;
    const editedMode = this.plugin.getEditedProfileMode();
    const otherMode = editedMode === "light" ? "dark" : "light";

    containerEl.empty();
    containerEl.addClass("theme-basics-settings");

    // ── Profile controls ──────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Profile to edit")
      .setDesc("Choose whether you are editing the light or dark profile.")
      .addButton((button) => {
        button
          .setButtonText("Light")
          .setClass("theme-basics-profile-button")
          .onClick(async () => {
            await this.plugin.setEditedProfileMode("light");
            this.refreshDisplayPreserveScroll();
          });

        if (editedMode === "light") {
          button.buttonEl.addClass("is-active");
          button.setCta();
        }
      })
      .addButton((button) => {
        button
          .setButtonText("Dark")
          .setClass("theme-basics-profile-button")
          .onClick(async () => {
            await this.plugin.setEditedProfileMode("dark");
            this.refreshDisplayPreserveScroll();
          });

        if (editedMode === "dark") {
          button.buttonEl.addClass("is-active");
          button.setCta();
        }
      });

    new Setting(containerEl)
      .setName("Copy edited profile")
      .setDesc(
        `Copy all ${PROFILE_LABELS[editedMode]} values into the ${PROFILE_LABELS[otherMode]} profile.`
      )
      .addButton((button) =>
        button.setButtonText(`Copy to ${PROFILE_LABELS[otherMode]}`).onClick(async () => {
          await this.plugin.copyProfile(editedMode, otherMode);
          new Notice(`Copied ${PROFILE_LABELS[editedMode]} profile to ${PROFILE_LABELS[otherMode]}.`);
          this.refreshDisplayPreserveScroll();
        })
      );

    new Setting(containerEl)
      .setName(`Reset ${PROFILE_LABELS[editedMode]} profile`)
      .setDesc(`Clear every override in the ${PROFILE_LABELS[editedMode]} profile.`)
      .addButton((button) =>
        button.setWarning().setButtonText("Reset profile").onClick(async () => {
          await this.plugin.resetProfile(editedMode);
          new Notice(`${PROFILE_LABELS[editedMode]} profile reset.`);
          this.refreshDisplayPreserveScroll();
        })
      );

    new Setting(containerEl)
      .setName("Reset both profiles")
      .setDesc("Clear every override in both light and dark profiles.")
      .addButton((button) =>
        button.setWarning().setButtonText("Reset both").onClick(async () => {
          await this.plugin.resetAllSettings();
          this.refreshDisplayPreserveScroll();
        })
      );

    // ── Import / Export ──────────────────────────────────────────────────
    const ioSection = this.createSection(
      containerEl,
      "Import / Export",
      "Share your settings or generate a standalone CSS snippet."
    );

    new Setting(ioSection)
      .setName("Export settings")
      .setDesc("Download your current settings as a JSON file that can be imported later or shared with others.")
      .addButton((button) =>
        button
          .setButtonText("Export JSON")
          .setIcon("lucide-download")
          .onClick(() => {
            this.plugin.exportSettingsJson();
          })
      );

    new Setting(ioSection)
      .setName("Import settings")
      .setDesc("Load settings from a previously exported JSON file. This will overwrite your current settings.")
      .addButton((button) =>
        button
          .setButtonText("Import JSON")
          .setIcon("lucide-upload")
          .onClick(() => {
            this.plugin.importSettingsJson(() => {
              this.refreshDisplayPreserveScroll();
            });
          })
      );

    new Setting(ioSection)
      .setName("Export as CSS snippet")
      .setDesc(
        "Save your current style overrides to .obsidian/snippets/theme-basics.css. " +
          "You can then enable it in Appearance → CSS snippets and use it without this plugin."
      )
      .addButton((button) =>
        button
          .setButtonText("Export snippet")
          .setIcon("lucide-file-code")
          .onClick(async () => {
            await this.plugin.exportCssSnippet();
          })
      );

    // ── Base16 import ──────────────────────────────────────────────────
    const base16Section = this.createSection(
      containerEl,
      "Import Base16 theme",
      `Seed the ${PROFILE_LABELS[editedMode]} profile from a Base16 YAML color scheme. ` +
        "The 16 base colors are mapped to backgrounds, text, links, headings, and more. " +
        "Results are approximate — treat this as a starting point and fine-tune individual values afterwards."
    );

    let base16Yaml = "";

    new Setting(base16Section)
      .setName("Base16 YAML")
      .setDesc(
        "Paste the full text of a Base16 .yaml file below. " +
          "Lines containing base00–base0F hex values are detected automatically; all other lines are ignored."
      )
      .addTextArea((textarea) => {
        textarea
          .setPlaceholder(
            'scheme: "Mexico Light"\nauthor: "Sheldon Johnson"\nbase00: "f8f8f8"\nbase01: "e8e8e8"\n...'
          )
          .onChange((value) => {
            base16Yaml = value;
          });
        textarea.inputEl.rows = 9;
        textarea.inputEl.style.minWidth = "22rem";
        textarea.inputEl.style.fontFamily = "var(--font-monospace)";
        textarea.inputEl.style.fontSize = "var(--font-smaller)";
        textarea.inputEl.style.resize = "vertical";
      });

    new Setting(base16Section).addButton((button) =>
      button
        .setButtonText(`Apply to ${PROFILE_LABELS[editedMode]} profile`)
        .setCta()
        .onClick(async () => {
          const result = await this.plugin.applyBase16Theme(base16Yaml, editedMode);
          if (result.success) {
            new Notice(
              `Applied ${result.count} Base16 colors to the ${PROFILE_LABELS[editedMode]} profile.`
            );
            this.refreshDisplayPreserveScroll();
          } else {
            new Notice(
              'No Base16 colors found. Make sure the YAML contains lines like: base00: "f8f8f8"'
            );
          }
        })
    );

    // ── Style settings ────────────────────────────────────────────────
    const backgroundsSection = this.createSection(
      containerEl,
      "Backgrounds",
      "App chrome, note surfaces, and editor background colors."
    );
    for (const option of [
      COLOR_OPTIONS_BY_KEY.backgroundPrimary,
      COLOR_OPTIONS_BY_KEY.backgroundSecondary,
      COLOR_OPTIONS_BY_KEY.backgroundPrimaryAlt,
      COLOR_OPTIONS_BY_KEY.backgroundSecondaryAlt,
    ]) {
      if (option) {
        this.addColorSetting(backgroundsSection, editedMode, option);
      }
    }

    const linksSection = this.createSection(
      containerEl,
      "Links and emphasis",
      "Internal links, external links, bold, italic, and highlighted text. Link hover colors are computed automatically."
    );
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.linkColor);
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.externalLinkColor);
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.unresolvedLinkColor);
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.boldColor);
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.italicColor);
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.highlightBackground);

    const typographySection = this.createSection(
      containerEl,
      "Typography",
      "Base text size and line spacing for note content in both modes."
    );
    for (const option of TYPOGRAPHY_COLOR_OPTIONS) {
      this.addColorSetting(typographySection, editedMode, option);
    }
    for (const option of TYPOGRAPHY_OPTIONS) {
      this.addSliderSetting(typographySection, editedMode, option);
    }

    const headingsSection = this.createSection(
      containerEl,
      "Headings",
      "Per-level heading colors, sizes, weights, and line heights."
    );
    for (const level of HEADING_LEVELS) {
      this.addHeadingSetting(headingsSection, editedMode, level);
    }

    const advancedSection = this.createSection(
      containerEl,
      "Advanced",
      "Additional default-theme note styling controls."
    );

    this.addSubheading(
      advancedSection,
      "Lists and rules",
      "Adjust list spacing, indentation, and horizontal rule styling."
    );
    for (const option of ADVANCED_LIST_OPTIONS) {
      this.addSliderSetting(advancedSection, editedMode, option);
    }
    for (const option of ADVANCED_LIST_COLOR_OPTIONS) {
      this.addColorSetting(advancedSection, editedMode, option);
    }

    this.addSubheading(
      advancedSection,
      "Blockquotes",
      "Customize blockquote text, background, and border colors."
    );
    for (const option of ADVANCED_BLOCKQUOTE_OPTIONS) {
      this.addColorSetting(advancedSection, editedMode, option);
    }

    this.addSubheading(
      advancedSection,
      "Code",
      "Control inline code and code block colors and font size."
    );
    for (const option of ADVANCED_CODE_COLOR_OPTIONS) {
      this.addColorSetting(advancedSection, editedMode, option);
    }
    for (const option of ADVANCED_CODE_SLIDER_OPTIONS) {
      this.addSliderSetting(advancedSection, editedMode, option);
    }

    this.addSubheading(advancedSection, "Tags", "Style tags in Reading mode and Live Preview.");
    for (const option of ADVANCED_TAG_OPTIONS) {
      this.addColorSetting(advancedSection, editedMode, option);
    }
  }

  private createSection(containerEl: HTMLElement, title: string, description: string): HTMLElement {
    const groupEl = containerEl.createDiv("setting-group");
    new Setting(groupEl).setName(title).setDesc(description).setHeading();
    return groupEl.createDiv("setting-items");
  }

  private addSubheading(containerEl: HTMLElement, title: string, description: string): void {
    new Setting(containerEl).setName(title).setDesc(description).setHeading();
  }

  private addOptionalColorSetting(
    containerEl: HTMLElement,
    mode: ProfileMode,
    option?: ColorOption
  ): void {
    if (option) {
      this.addColorSetting(containerEl, mode, option);
    }
  }

  private addColorSetting(containerEl: HTMLElement, mode: ProfileMode, option: ColorOption): void {
    let colorPickerComponent: ColorComponent | null = null;
    let resetButton: ExtraButtonComponent | null = null;
    const hasOverride = Boolean(this.plugin.getProfile(mode)[option.key]);
    let isSyncing = false;

    new Setting(containerEl)
      .setName(option.name)
      .setDesc(`${option.description} Reset to inherit the theme default.`)
      .addExtraButton((button) => {
        resetButton = button;
        button
          .setIcon("lucide-rotate-ccw")
          .setTooltip("Reset to theme default")
          .setDisabled(!hasOverride)
          .onClick(async () => {
            await this.plugin.resetProfileValue(mode, option.key);
            resetButton?.setDisabled(true);
            const themeDefault = this.plugin.styleManager.getThemeDefaultVariableValue(
              option.variableName
            );
            const pickerHex = this.plugin.styleManager.tryToPickerHex(themeDefault) ?? "#000000";
            isSyncing = true;
            colorPickerComponent?.setValue(pickerHex);
            isSyncing = false;
          });
      })
      .addColorPicker((picker) => {
        colorPickerComponent = picker;
        picker
          .setValue(
            this.plugin.styleManager.getDefaultColorValue(mode, option.key, option.variableName)
          )
          .onChange(async (value) => {
            if (isSyncing) return;
            await this.plugin.setProfileValue(mode, option.key, value);
            resetButton?.setDisabled(false);
          });
      });
  }

  private addSliderSetting(containerEl: HTMLElement, mode: ProfileMode, option: SliderOption): void {
    let sliderComponent: SliderComponent | null = null;
    let resetButton: ExtraButtonComponent | null = null;
    const hasOverride = Boolean(this.plugin.getProfile(mode)[option.key]);
    let isSyncing = false;

    const fallbackValue = this.plugin.styleManager.getDefaultNumericValue(
      mode,
      option.key,
      option.variableName,
      option.defaultValue
    );

    new Setting(containerEl)
      .setName(option.name)
      .setDesc(`${option.description} Reset to inherit the theme default.`)
      .addExtraButton((button) => {
        resetButton = button;
        button
          .setIcon("lucide-rotate-ccw")
          .setTooltip("Reset to theme default")
          .setDisabled(!hasOverride)
          .onClick(async () => {
            await this.plugin.resetProfileValue(mode, option.key);
            resetButton?.setDisabled(true);
            const resetValue = this.plugin.styleManager.getDefaultNumericValue(
              mode,
              option.key,
              option.variableName,
              option.defaultValue
            );
            isSyncing = true;
            sliderComponent?.setValue(
              this.plugin.styleManager.ensureWithinRange(
                resetValue,
                option.min,
                option.max,
                option.defaultValue
              )
            );
            isSyncing = false;
          });
      })
      .addSlider((slider) => {
        sliderComponent = slider;
        slider
          .setLimits(option.min, option.max, option.step)
          .setDynamicTooltip()
          .setValue(
            this.plugin.styleManager.ensureWithinRange(
              fallbackValue,
              option.min,
              option.max,
              option.defaultValue
            )
          )
          .onChange(async (value) => {
            if (isSyncing) return;
            await this.plugin.setProfileValue(
              mode,
              option.key,
              `${formatNumber(value)}${option.unit}`
            );
            resetButton?.setDisabled(false);
          });
      });
  }

  private addHeadingSetting(containerEl: HTMLElement, mode: ProfileMode, level: HeadingLevel): void {
    const defaults = HEADING_DEFAULTS[level];

    new Setting(containerEl).setName(`H${level}`).setHeading();

    this.addColorSetting(containerEl, mode, {
      key: `h${level}Color`,
      name: "Color",
      description: `Text color for H${level} headings.`,
      variableName: `--h${level}-color`,
    });

    this.addSliderSetting(containerEl, mode, {
      key: `h${level}Size`,
      name: "Size",
      description: `Font size for H${level} headings.`,
      variableName: `--h${level}-size`,
      min: 0.8,
      max: 3,
      step: 0.01,
      unit: "em",
      defaultValue: defaults.size,
    });

    this.addSliderSetting(containerEl, mode, {
      key: `h${level}Weight`,
      name: "Weight",
      description: `Font weight for H${level} headings.`,
      variableName: `--h${level}-weight`,
      min: 100,
      max: 900,
      step: 100,
      unit: "",
      defaultValue: defaults.weight,
    });

    this.addSliderSetting(containerEl, mode, {
      key: `h${level}LineHeight`,
      name: "Line height",
      description: `Line height for H${level} headings.`,
      variableName: `--h${level}-line-height`,
      min: 1,
      max: 2.2,
      step: 0.05,
      unit: "",
      defaultValue: defaults.lineHeight,
    });
  }
}

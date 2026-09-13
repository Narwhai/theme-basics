import {
  App,
  ColorComponent,
  DropdownComponent,
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
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type { ColorOption, HeadingLevel, ProfileMode, SliderOption } from "./types";

/**
 * A unique token minted whenever the tab's rows or definitions are rebuilt.
 * Each async handler captures the token that was current when it was
 * created.  Before touching the UI the handler compares its token with the
 * live one – if they differ, the settings tab has been re-rendered since the
 * handler was created and the handler should bail out instead of operating on
 * stale DOM.
 *
 * On Obsidian 1.13+ the token is replaced when definitions are rebuilt instead.
 */
type DisplayToken = symbol;

export class DefaultThemeStyleTunerSettingTab extends PluginSettingTab {
  /**
   * The current display token. Replaced on display() or definition rebuilds.
   * Handlers compare their captured token against this to detect staleness.
   */
  private displayToken: DisplayToken = Symbol();

  /** Cached Base16 YAML text – lives on the instance so it survives re-renders. */
  private base16Yaml = "";

  constructor(app: App, private readonly plugin: DefaultThemeStyleTunerPlugin) {
    super(app, plugin);
    // Declarative rendering (Obsidian 1.13+) never calls display(), so the
    // container class cannot be applied from there.
    this.containerEl.addClass("theme-basics-settings");
  }

  override hide(): void {
    // On 1.13+ the base class tears down declaratively rendered rows; on
    // older versions hide() does nothing, so empty the container ourselves.
    super.hide();
    this.containerEl.empty();
  }

  refreshDisplayPreserveScroll(): void {
    if (!this.containerEl.isShown()) {
      // Hidden declarative tabs still need fresh definitions for reopening/search.
      // eslint-disable-next-line obsidianmd/no-unsupported-api -- runtime-guarded for pre-1.13 support
      if (typeof this.update === "function") this.update();
      return;
    }
    const containers = [this.containerEl, this.containerEl.parentElement].filter(
      (element): element is HTMLElement => element instanceof HTMLElement
    );
    const scrollPositions = containers.map((element) => ({
      element,
      top: element.scrollTop,
    }));

    this.rerender();

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

  /**
   * Declarative settings for Obsidian 1.13+.  When this returns a non-empty
   * array the framework renders the tab itself and skips {@link display}; on
   * older versions display() runs instead.  Both paths share the same row
   * configurators (e.g. {@link configureColorSetting}) so the two
   * implementations cannot drift apart.
   *
   * Must stay cheap: it runs on every update() and once when the tab is
   * registered for search indexing.  Expensive work (theme-default DOM
   * probes) lives in the render callbacks, which run only when a row is
   * drawn.
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    const token: DisplayToken = Symbol();
    this.displayToken = token;
    const editedMode = this.plugin.getEditedProfileMode();
    const otherMode = editedMode === "light" ? "dark" : "light";

    const backgroundOptions = [
      COLOR_OPTIONS_BY_KEY.backgroundPrimary,
      COLOR_OPTIONS_BY_KEY.backgroundSecondary,
      COLOR_OPTIONS_BY_KEY.backgroundPrimaryAlt,
      COLOR_OPTIONS_BY_KEY.backgroundSecondaryAlt,
    ].filter((option): option is ColorOption => option !== undefined);

    const linkOptions = [
      COLOR_OPTIONS_BY_KEY.linkColor,
      COLOR_OPTIONS_BY_KEY.externalLinkColor,
      COLOR_OPTIONS_BY_KEY.unresolvedLinkColor,
      COLOR_OPTIONS_BY_KEY.boldColor,
      COLOR_OPTIONS_BY_KEY.italicColor,
      COLOR_OPTIONS_BY_KEY.highlightBackground,
    ].filter((option): option is ColorOption => option !== undefined);

    return [
      // ── Profile controls ────────────────────────────────────────────
      {
        name: "Profile to edit",
        desc: "Choose whether you are editing the light or dark profile.",
        render: (setting) => {
          this.configureProfileRow(setting, editedMode, token);
        },
      },
      {
        name: "Copy edited profile",
        desc: `Copy all ${PROFILE_LABELS[editedMode]} values into the ${PROFILE_LABELS[otherMode]} profile.`,
        render: (setting) => {
          this.configureCopyProfileRow(setting, editedMode, token);
        },
      },
      {
        name: `Reset ${PROFILE_LABELS[editedMode]} profile`,
        desc: `Clear every override in the ${PROFILE_LABELS[editedMode]} profile.`,
        render: (setting) => {
          this.configureResetProfileRow(setting, editedMode, token);
        },
      },
      {
        name: "Reset both profiles",
        desc: "Clear every override in both light and dark profiles.",
        render: (setting) => {
          this.configureResetAllRow(setting, token);
        },
      },

      // ── Import / Export ─────────────────────────────────────────────
      this.sectionGroup("Import / Export", "Share your settings or generate a standalone CSS snippet.", [
        {
          name: "Export settings",
          desc: "Download your current settings as a JSON file that can be imported later or shared with others.",
          render: (setting) => {
            this.configureExportJsonRow(setting);
          },
        },
        {
          name: "Import settings",
          desc: "Load settings from a previously exported JSON file. This will overwrite your current settings.",
          render: (setting) => {
            this.configureImportJsonRow(setting);
          },
        },
        {
          name: "Export as CSS snippet",
          desc:
            `Save your current style overrides to ${this.app.vault.configDir}/snippets/theme-basics.css. ` +
            "You can then enable it in Appearance → CSS snippets and use it without this plugin.",
          render: (setting) => {
            this.configureExportSnippetRow(setting);
          },
        },
      ]),

      // ── Base16 import ───────────────────────────────────────────────
      this.sectionGroup(
        "Import Base16 theme",
        `Seed the ${PROFILE_LABELS[editedMode]} profile from a Base16 YAML color scheme. ` +
        "The 16 base colors are mapped to backgrounds, text, links, headings, and more. " +
        "Results are approximate — treat this as a starting point and fine-tune individual values afterwards.",
        [
          {
            name: "Base16 YAML",
            desc:
              "Paste the full text of a Base16 .yaml file below. " +
              "Lines containing base00–base0F hex values are detected automatically; all other lines are ignored.",
            render: (setting) => {
              this.configureBase16TextareaRow(setting);
            },
          },
          {
            name: `Apply Base16 theme to ${PROFILE_LABELS[editedMode]}`,
            searchable: false,
            render: (setting) => {
              this.configureBase16ApplyRow(setting, editedMode, token);
            },
          },
        ]
      ),

      // ── Style settings ──────────────────────────────────────────────
      this.sectionGroup("Backgrounds", "App chrome, note surfaces, and editor background colors.",
        backgroundOptions.map((option) => this.colorDef(editedMode, option, token))
      ),

      this.sectionGroup(
        "Links and emphasis",
        "Internal links, external links, bold, italic, and highlighted text. Link hover colors are computed automatically.",
        linkOptions.map((option) => this.colorDef(editedMode, option, token))
      ),

      this.sectionGroup("Typography", "Base text size and line spacing for note content in both modes.", [
        ...TYPOGRAPHY_COLOR_OPTIONS.map((option) => this.colorDef(editedMode, option, token)),
        ...TYPOGRAPHY_OPTIONS.map((option) => this.sliderDef(editedMode, option, token)),
      ]),

      this.sectionGroup("Headings", "Per-level heading colors, sizes, weights, and line heights.",
        HEADING_LEVELS.flatMap((level) => this.headingDefs(editedMode, level, token))
      ),

      this.sectionGroup("Advanced", "Additional default-theme note styling controls.", [
        this.subheadingDef("Lists and rules", "Adjust list spacing, indentation, and horizontal rule styling."),
        ...ADVANCED_LIST_OPTIONS.map((option) => this.sliderDef(editedMode, option, token)),
        ...ADVANCED_LIST_COLOR_OPTIONS.map((option) => this.colorDef(editedMode, option, token)),
        this.subheadingDef("Blockquotes", "Customize blockquote text, background, and border colors."),
        ...ADVANCED_BLOCKQUOTE_OPTIONS.map((option) => this.colorDef(editedMode, option, token)),
        this.subheadingDef("Code", "Control inline code and code block colors and font size."),
        ...ADVANCED_CODE_COLOR_OPTIONS.map((option) => this.colorDef(editedMode, option, token)),
        ...ADVANCED_CODE_SLIDER_OPTIONS.map((option) => this.sliderDef(editedMode, option, token)),
        this.subheadingDef("Tags", "Style tags in Reading mode and Live Preview."),
        ...ADVANCED_TAG_OPTIONS.map((option) => this.colorDef(editedMode, option, token)),
      ]),
    ];
  }

  override display(): void {
    // Mint a fresh token – any handler from a previous display() is now stale.
    const token: DisplayToken = Symbol();
    this.displayToken = token;

    const { containerEl } = this;
    const editedMode = this.plugin.getEditedProfileMode();
    const otherMode = editedMode === "light" ? "dark" : "light";

    containerEl.empty();
    containerEl.addClass("theme-basics-settings");

    // ── Profile controls ──────────────────────────────────────────────
    this.addRow(
      containerEl,
      "Profile to edit",
      "Choose whether you are editing the light or dark profile.",
      (setting) => this.configureProfileRow(setting, editedMode, token)
    );

    this.addRow(
      containerEl,
      "Copy edited profile",
      `Copy all ${PROFILE_LABELS[editedMode]} values into the ${PROFILE_LABELS[otherMode]} profile.`,
      (setting) => this.configureCopyProfileRow(setting, editedMode, token)
    );

    this.addRow(
      containerEl,
      `Reset ${PROFILE_LABELS[editedMode]} profile`,
      `Clear every override in the ${PROFILE_LABELS[editedMode]} profile.`,
      (setting) => this.configureResetProfileRow(setting, editedMode, token)
    );

    this.addRow(
      containerEl,
      "Reset both profiles",
      "Clear every override in both light and dark profiles.",
      (setting) => this.configureResetAllRow(setting, token)
    );

    // ── Import / Export ──────────────────────────────────────────────────
    const ioSection = this.createSection(
      containerEl,
      "Import / Export",
      "Share your settings or generate a standalone CSS snippet."
    );

    this.addRow(
      ioSection,
      "Export settings",
      "Download your current settings as a JSON file that can be imported later or shared with others.",
      (setting) => this.configureExportJsonRow(setting)
    );

    this.addRow(
      ioSection,
      "Import settings",
      "Load settings from a previously exported JSON file. This will overwrite your current settings.",
      (setting) => this.configureImportJsonRow(setting)
    );

    this.addRow(
      ioSection,
      "Export as CSS snippet",
      `Save your current style overrides to ${this.app.vault.configDir}/snippets/theme-basics.css. ` +
      "You can then enable it in Appearance → CSS snippets and use it without this plugin.",
      (setting) => this.configureExportSnippetRow(setting)
    );

    // ── Base16 import ──────────────────────────────────────────────────
    const base16Section = this.createSection(
      containerEl,
      "Import Base16 theme",
      `Seed the ${PROFILE_LABELS[editedMode]} profile from a Base16 YAML color scheme. ` +
      "The 16 base colors are mapped to backgrounds, text, links, headings, and more. " +
      "Results are approximate — treat this as a starting point and fine-tune individual values afterwards."
    );

    this.addRow(
      base16Section,
      "Base16 YAML",
      "Paste the full text of a Base16 .yaml file below. " +
      "Lines containing base00–base0F hex values are detected automatically; all other lines are ignored.",
      (setting) => this.configureBase16TextareaRow(setting)
    );

    this.configureBase16ApplyRow(new Setting(base16Section), editedMode, token);

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
        this.addColorSetting(backgroundsSection, editedMode, option, token);
      }
    }

    const linksSection = this.createSection(
      containerEl,
      "Links and emphasis",
      "Internal links, external links, bold, italic, and highlighted text. Link hover colors are computed automatically."
    );
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.linkColor, token);
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.externalLinkColor, token);
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.unresolvedLinkColor, token);
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.boldColor, token);
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.italicColor, token);
    this.addOptionalColorSetting(linksSection, editedMode, COLOR_OPTIONS_BY_KEY.highlightBackground, token);

    const typographySection = this.createSection(
      containerEl,
      "Typography",
      "Base text size and line spacing for note content in both modes."
    );
    for (const option of TYPOGRAPHY_COLOR_OPTIONS) {
      this.addColorSetting(typographySection, editedMode, option, token);
    }
    for (const option of TYPOGRAPHY_OPTIONS) {
      this.addSliderSetting(typographySection, editedMode, option, token);
    }

    const headingsSection = this.createSection(
      containerEl,
      "Headings",
      "Per-level heading colors, sizes, weights, and line heights."
    );
    for (const level of HEADING_LEVELS) {
      this.addHeadingSetting(headingsSection, editedMode, level, token);
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
      this.addSliderSetting(advancedSection, editedMode, option, token);
    }
    for (const option of ADVANCED_LIST_COLOR_OPTIONS) {
      this.addColorSetting(advancedSection, editedMode, option, token);
    }

    this.addSubheading(
      advancedSection,
      "Blockquotes",
      "Customize blockquote text, background, and border colors."
    );
    for (const option of ADVANCED_BLOCKQUOTE_OPTIONS) {
      this.addColorSetting(advancedSection, editedMode, option, token);
    }

    this.addSubheading(
      advancedSection,
      "Code",
      "Control inline code and code block colors and font size."
    );
    for (const option of ADVANCED_CODE_COLOR_OPTIONS) {
      this.addColorSetting(advancedSection, editedMode, option, token);
    }
    for (const option of ADVANCED_CODE_SLIDER_OPTIONS) {
      this.addSliderSetting(advancedSection, editedMode, option, token);
    }

    this.addSubheading(advancedSection, "Tags", "Style tags in Reading mode and Live Preview.");
    for (const option of ADVANCED_TAG_OPTIONS) {
      this.addColorSetting(advancedSection, editedMode, option, token);
    }
  }

  /**
   * Returns `true` when the given token no longer matches the live
   * {@link displayToken}, meaning the settings tab has been re-rendered and
   * any DOM references captured by the caller are stale.
   */
  private isStale(token: DisplayToken): boolean {
    return token !== this.displayToken;
  }

  /**
   * Re-renders the tab using whichever rendering path the running Obsidian
   * version supports: declarative update() on 1.13+, imperative display() on
   * older versions.
   */
  private rerender(): void {
    // eslint-disable-next-line obsidianmd/no-unsupported-api -- runtime-guarded: this branch is only taken when update() exists (Obsidian 1.13+)
    if (typeof this.update === "function") {
      // eslint-disable-next-line obsidianmd/no-unsupported-api -- guarded by the typeof check above
      this.update();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- dual support: display() is the only rendering path on Obsidian < 1.13
      this.display();
    }
  }

  // ── Definition builders (declarative path) ────────────────────────────

  /**
   * Builds a section group.  Declarative groups only accept a plain-text
   * heading, so the section description is prepended as a heading-styled
   * info row — the closest match to the imperative section headers.
   */
  private sectionGroup(
    heading: string,
    description: string,
    items: SettingGroupItem[]
  ): SettingDefinitionItem {
    return {
      type: "group",
      heading,
      items: [this.sectionIntro(description), ...items],
    };
  }

  /** A heading-styled row that only carries a section description. */
  private sectionIntro(description: string): SettingGroupItem {
    return {
      name: "",
      desc: description,
      searchable: false,
      render: (setting) => {
        setting.setHeading();
      },
    };
  }

  /** A heading-styled row used for subheadings inside a section. */
  private subheadingDef(name: string, description?: string): SettingGroupItem {
    return {
      name,
      ...(description === undefined ? {} : { desc: description }),
      searchable: false,
      render: (setting) => {
        setting.setHeading();
      },
    };
  }

  private colorDef(mode: ProfileMode, option: ColorOption, token: DisplayToken): SettingGroupItem {
    return {
      name: option.name,
      desc: `${option.description} Reset to inherit the theme default.`,
      render: (setting) => {
        this.configureColorSetting(setting, mode, option, token);
      },
    };
  }

  private sliderDef(mode: ProfileMode, option: SliderOption, token: DisplayToken): SettingGroupItem {
    return {
      name: option.name,
      desc: `${option.description} Reset to inherit the theme default.`,
      render: (setting) => {
        this.configureSliderSetting(setting, mode, option, token);
      },
    };
  }

  private headingDefs(mode: ProfileMode, level: HeadingLevel, token: DisplayToken): SettingGroupItem[] {
    const { color, sliders } = this.headingOptions(level);
    return [
      this.subheadingDef(`H${level}`),
      this.colorDef(mode, color, token),
      ...sliders.map((option) => this.sliderDef(mode, option, token)),
    ];
  }

  /** Option descriptors for one heading level, shared by both rendering paths. */
  private headingOptions(level: HeadingLevel): { color: ColorOption; sliders: SliderOption[] } {
    const defaults = HEADING_DEFAULTS[level];
    return {
      color: {
        key: `h${level}Color`,
        name: "Color",
        description: `Text color for H${level} headings.`,
        variableName: `--h${level}-color`,
      },
      sliders: [
        {
          key: `h${level}Size`,
          name: "Size",
          description: `Font size for H${level} headings.`,
          variableName: `--h${level}-size`,
          min: 0.8,
          max: 3,
          step: 0.01,
          unit: "em",
          defaultValue: defaults.size,
        },
        {
          key: `h${level}Weight`,
          name: "Weight",
          description: `Font weight for H${level} headings.`,
          variableName: `--h${level}-weight`,
          min: 100,
          max: 900,
          step: 100,
          unit: "",
          defaultValue: defaults.weight,
        },
        {
          key: `h${level}LineHeight`,
          name: "Line height",
          description: `Line height for H${level} headings.`,
          variableName: `--h${level}-line-height`,
          min: 1,
          max: 2.2,
          step: 0.05,
          unit: "",
          defaultValue: defaults.lineHeight,
        },
      ],
    };
  }

  // ── Row configurators (shared by both rendering paths) ────────────────

  private configureProfileRow(setting: Setting, editedMode: ProfileMode, token: DisplayToken): void {
    setting.addDropdown((dropdown: DropdownComponent) => {
      dropdown
        .addOption("light", "Light")
        .addOption("dark", "Dark")
        .setValue(editedMode)
        .onChange(async (value) => {
          if (this.isStale(token)) return;
          if ((value !== "light" && value !== "dark") || value === this.plugin.getEditedProfileMode()) {
            return;
          }

          await this.plugin.setEditedProfileMode(value);
          if (this.isStale(token)) return;
          this.refreshDisplayPreserveScroll();
        });
    });
  }

  private configureCopyProfileRow(setting: Setting, editedMode: ProfileMode, token: DisplayToken): void {
    const otherMode = editedMode === "light" ? "dark" : "light";
    setting.addButton((button) =>
      button.setButtonText(`Copy to ${PROFILE_LABELS[otherMode]}`).onClick(async () => {
        if (this.isStale(token)) return;
        await this.plugin.copyProfile(editedMode, otherMode);
        new Notice(`Copied ${PROFILE_LABELS[editedMode]} profile to ${PROFILE_LABELS[otherMode]}.`);
        if (this.isStale(token)) return;
        this.refreshDisplayPreserveScroll();
      })
    );
  }

  private configureResetProfileRow(setting: Setting, editedMode: ProfileMode, token: DisplayToken): void {
    setting.addButton((button) =>
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- setDestructive() requires Obsidian 1.13; setWarning() is the only destructive styling on our minAppVersion 1.10
      button.setWarning().setButtonText("Reset profile").onClick(async () => {
        if (this.isStale(token)) return;
        await this.plugin.resetProfile(editedMode);
        new Notice(`${PROFILE_LABELS[editedMode]} profile reset.`);
        if (this.isStale(token)) return;
        this.refreshDisplayPreserveScroll();
      })
    );
  }

  private configureResetAllRow(setting: Setting, token: DisplayToken): void {
    setting.addButton((button) =>
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- setDestructive() requires Obsidian 1.13; setWarning() is the only destructive styling on our minAppVersion 1.10
      button.setWarning().setButtonText("Reset both").onClick(async () => {
        if (this.isStale(token)) return;
        await this.plugin.resetAllSettings();
        if (this.isStale(token)) return;
        this.refreshDisplayPreserveScroll();
      })
    );
  }

  private configureExportJsonRow(setting: Setting): void {
    setting.addButton((button) =>
      button
        .setButtonText("Export JSON")
        .setIcon("lucide-download")
        .onClick(() => {
          this.plugin.exportSettingsJson();
        })
    );
  }

  private configureImportJsonRow(setting: Setting): void {
    setting.addButton((button) =>
      button
        .setButtonText("Import JSON")
        .setIcon("lucide-upload")
        .onClick(() => {
          this.plugin.importSettingsJson();
        })
    );
  }

  private configureExportSnippetRow(setting: Setting): void {
    setting.addButton((button) =>
      button
        .setButtonText("Export snippet")
        .setIcon("lucide-file-code")
        .onClick(async () => {
          await this.plugin.exportCssSnippet();
        })
    );
  }

  private configureBase16TextareaRow(setting: Setting): void {
    setting.addTextArea((textarea) => {
      textarea
        .setPlaceholder("Paste the base16 YAML here.")
        .setValue(this.base16Yaml)
        .onChange((value) => {
          this.base16Yaml = value;
        });
      textarea.inputEl.rows = 9;
      textarea.inputEl.addClass("theme-basics-base16-textarea");
    });
  }

  private configureBase16ApplyRow(setting: Setting, editedMode: ProfileMode, token: DisplayToken): void {
    setting.addButton((button) =>
      button
        .setButtonText(`Apply to ${PROFILE_LABELS[editedMode]} profile`)
        .setCta()
        .onClick(async () => {
          if (this.isStale(token)) return;
          const yaml = this.base16Yaml;
          const result = await this.plugin.applyBase16Theme(yaml, editedMode);
          if (result.success) {
            new Notice(
              `Applied ${result.count} Base16 colors to the ${PROFILE_LABELS[editedMode]} profile.`
            );
            if (this.isStale(token)) return;
            this.refreshDisplayPreserveScroll();
          } else {
            new Notice(
              'No base16 colors found. Make sure the YAML contains lines like: base00: "f8f8f8"'
            );
          }
        })
    );
  }

  /**
   * Adds the reset button and color picker controls of a color row.
   * The caller owns the row's name and description.
   */
  private configureColorSetting(
    setting: Setting,
    mode: ProfileMode,
    option: ColorOption,
    token: DisplayToken
  ): void {
    let colorPickerComponent: ColorComponent | null = null;
    let resetButton: ExtraButtonComponent | null = null;
    const hasOverride = Boolean(this.plugin.getProfile(mode)[option.key]);
    let isSyncing = false;

    setting
      .addExtraButton((button) => {
        resetButton = button;
        button
          .setIcon("lucide-rotate-ccw")
          .setTooltip("Reset to theme default")
          .setDisabled(!hasOverride)
          .onClick(async () => {
            if (this.isStale(token)) return;
            await this.plugin.resetProfileValue(mode, option.key);
            if (this.isStale(token)) return;
            resetButton?.setDisabled(true);
            const pickerHex = this.plugin.styleManager.getDefaultColorValue(
              mode,
              option.key,
              option.variableName
            );
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
            if (isSyncing || this.isStale(token)) return;
            await this.plugin.setProfileValue(mode, option.key, value);
            if (this.isStale(token)) return;
            resetButton?.setDisabled(false);
          });
      });
  }

  /**
   * Adds the reset button and slider controls of a slider row.
   * The caller owns the row's name and description.
   */
  private configureSliderSetting(
    setting: Setting,
    mode: ProfileMode,
    option: SliderOption,
    token: DisplayToken
  ): void {
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

    setting
      .addExtraButton((button) => {
        resetButton = button;
        button
          .setIcon("lucide-rotate-ccw")
          .setTooltip("Reset to theme default")
          .setDisabled(!hasOverride)
          .onClick(async () => {
            if (this.isStale(token)) return;
            await this.plugin.resetProfileValue(mode, option.key);
            if (this.isStale(token)) return;
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
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- still required for slider tooltips on Obsidian < 1.13, where the value is not shown inline
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
            if (isSyncing || this.isStale(token)) return;
            await this.plugin.setProfileValue(
              mode,
              option.key,
              `${formatNumber(value)}${option.unit}`
            );
            if (this.isStale(token)) return;
            resetButton?.setDisabled(false);
          });
      });
  }

  // ── Imperative helpers (pre-1.13 path) ────────────────────────────────

  /** Creates a named Setting row and lets {@link configure} attach its controls. */
  private addRow(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    configure: (setting: Setting) => void
  ): void {
    const setting = new Setting(containerEl).setName(name).setDesc(desc);
    configure(setting);
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
    option: ColorOption | undefined,
    token: DisplayToken
  ): void {
    if (option) {
      this.addColorSetting(containerEl, mode, option, token);
    }
  }

  private addColorSetting(
    containerEl: HTMLElement,
    mode: ProfileMode,
    option: ColorOption,
    token: DisplayToken
  ): void {
    this.addRow(
      containerEl,
      option.name,
      `${option.description} Reset to inherit the theme default.`,
      (setting) => this.configureColorSetting(setting, mode, option, token)
    );
  }

  private addSliderSetting(
    containerEl: HTMLElement,
    mode: ProfileMode,
    option: SliderOption,
    token: DisplayToken
  ): void {
    this.addRow(
      containerEl,
      option.name,
      `${option.description} Reset to inherit the theme default.`,
      (setting) => this.configureSliderSetting(setting, mode, option, token)
    );
  }

  private addHeadingSetting(
    containerEl: HTMLElement,
    mode: ProfileMode,
    level: HeadingLevel,
    token: DisplayToken
  ): void {
    const { color, sliders } = this.headingOptions(level);

    new Setting(containerEl).setName(`H${level}`).setHeading();
    this.addColorSetting(containerEl, mode, color, token);
    for (const option of sliders) {
      this.addSliderSetting(containerEl, mode, option, token);
    }
  }
}

import {
  App,
  ButtonComponent,
  ColorComponent,
  DropdownComponent,
  ExtraButtonComponent,
  Notice,
  PluginSettingTab,
  Setting,
  SliderComponent,
  SuggestModal,
  TextComponent,
  setIcon,
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
import { formatNumber, sanitizeCssValue } from "./utils";

import type DefaultThemeStyleTunerPlugin from "./main";
import type { SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from "obsidian";
import type { ColorOption, HeadingLevel, ProfileMode, SliderOption } from "./types";

const SECTION_CLASS = "theme-basics-section";
const PALETTE_LIST_FORMAT_DESC = "Choose CSV or a JSON array of color strings. " +
  "CSV example: #1e1e2e, #f38ba8, rgb(166, 227, 161). " +
  "JSON example: [\"#1e1e2e\", \"#f38ba8\", \"rgb(166, 227, 161)\"].";
const PALETTE_LIST_PLACEHOLDER = "CSV (commas or new lines):\n#1e1e2e, #f38ba8, rgb(166, 227, 161)\n\n" +
  "JSON (array of strings):\n[\"#1e1e2e\", \"#f38ba8\", \"rgb(166, 227, 161)\"]";

/** Settings sub-pages in root display order; both rendering paths build from this table. */
type SettingsPageId = "palette" | "backgrounds" | "links" | "typography" | "headings" | "advanced" | "importExport";

interface SettingsPage {
  id: SettingsPageId;
  name: string;
  desc: string;
  /** Whether the page starts with a "Profile to edit" row. */
  profileRow: boolean;
}

const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: "palette", name: "Color palette", desc: "Edit the palette or import colors.", profileRow: true },
  { id: "backgrounds", name: "Backgrounds", desc: "App chrome, note surfaces, and editor background colors.", profileRow: true },
  {
    id: "links", name: "Links and emphasis", profileRow: true,
    desc: "Internal links, external links, bold, italic, and highlighted text. Link hover colors are computed automatically.",
  },
  { id: "typography", name: "Typography", desc: "Base text size and line spacing for note content in both modes.", profileRow: true },
  { id: "headings", name: "Headings", desc: "Per-level heading colors, sizes, weights, and line heights.", profileRow: true },
  { id: "advanced", name: "Advanced", desc: "Additional default-theme note styling controls.", profileRow: true },
  { id: "importExport", name: "Import / Export", desc: "Share your settings or generate a standalone CSS snippet.", profileRow: false },
];

const BACKGROUND_OPTIONS: ColorOption[] = [
  COLOR_OPTIONS_BY_KEY.backgroundPrimary,
  COLOR_OPTIONS_BY_KEY.backgroundSecondary,
  COLOR_OPTIONS_BY_KEY.backgroundPrimaryAlt,
  COLOR_OPTIONS_BY_KEY.backgroundSecondaryAlt,
  COLOR_OPTIONS_BY_KEY.interactiveBackground,
  COLOR_OPTIONS_BY_KEY.formFieldBackground,
].filter((option): option is ColorOption => option !== undefined);

const LINK_OPTIONS: ColorOption[] = [
  COLOR_OPTIONS_BY_KEY.linkColor,
  COLOR_OPTIONS_BY_KEY.externalLinkColor,
  COLOR_OPTIONS_BY_KEY.unresolvedLinkColor,
  COLOR_OPTIONS_BY_KEY.boldColor,
  COLOR_OPTIONS_BY_KEY.italicColor,
  COLOR_OPTIONS_BY_KEY.highlightBackground,
].filter((option): option is ColorOption => option !== undefined);

interface PaletteChoice {
  value: string;
  label: string;
  color: string;
  selected: boolean;
}

/** The standard suggestion modal supplies keyboard navigation and focus management. */
class PaletteChoiceModal extends SuggestModal<PaletteChoice> {
  constructor(
    app: App,
    description: string,
    private readonly choices: PaletteChoice[],
    private readonly choose: (choice: PaletteChoice) => void,
    private readonly closed: (modal: PaletteChoiceModal) => void
  ) {
    super(app);
    this.setTitle(description);
    this.setPlaceholder("Filter palette colors");
    this.inputEl.setAttribute("aria-label", "Filter palette colors");
  }

  override getSuggestions(query: string): PaletteChoice[] {
    const needle = query.trim().toLowerCase();
    return this.choices.filter((choice) => choice.label.toLowerCase().includes(needle));
  }

  override renderSuggestion(choice: PaletteChoice, element: HTMLElement): void {
    element.addClass("theme-basics-color-suggestion");
    addColorSwatch(element, choice.color);
    element.createSpan({ text: choice.label });
    if (choice.selected) element.createSpan({ cls: "theme-basics-color-current", text: " Current" });
  }

  override onChooseSuggestion(choice: PaletteChoice): void {
    this.choose(choice);
  }

  override onClose(): void {
    super.onClose();
    this.closed(this);
  }
}

function addColorSwatch(container: HTMLElement, color: string): HTMLElement {
  const swatch = container.createSpan({ cls: "theme-basics-color-swatch" });
  swatch.setAttribute("aria-hidden", "true");
  const safeColor = sanitizeCssValue(color);
  if (safeColor) {
    swatch.setCssProps({ "--theme-basics-swatch-color": safeColor });
  } else {
    swatch.addClass("is-unset");
  }
  return swatch;
}

/**
 * A display token is replaced when the tab is rebuilt. Declarative rows get
 * child tokens that are also invalidated when the native page tears them down,
 * even when the parent tab's definitions haven't changed.
 */
interface DisplayToken {
  active: boolean;
  parent?: DisplayToken;
  /**
   * Visibility epoch at creation. Hiding the tab bumps the epoch so controls
   * from the hidden page go stale, while cached declarative definitions stay
   * valid: rows rendered from them after reopening get the new epoch.
   */
  visibility?: number;
}

export class DefaultThemeStyleTunerSettingTab extends PluginSettingTab {
  /**
   * The current display token. Replaced on each getSettingDefinitions() call.
   * Handlers compare their captured token against this to detect staleness.
   */
  private displayToken: DisplayToken = { active: true };
  /** Incremented by hide(); see {@link DisplayToken.visibility}. */
  private visibility = 0;

  /** Cached Base16 YAML text – lives on the instance so it survives re-renders. */
  private base16Yaml = "";
  private paletteList = "";
  private paletteListFormat: "csv" | "json" | "" = "";
  private paletteListRevision = 0;
  private profileSelectionRevision = 0;
  private profileSwitchesInFlight = 0;
  private activeColorModal: PaletteChoiceModal | null = null;
  private colorControlRefreshers = new Set<() => void>();
  /** Unset custom choices are transient UI state, not stored color values. */
  private readonly pendingCustom: Record<ProfileMode, Set<string>> = {
    light: new Set(),
    dark: new Set(),
  };
  private readonly customDrafts: Record<ProfileMode, Map<string, string>> = {
    light: new Map(),
    dark: new Map(),
  };
  private readonly customDraftRevisions: Record<ProfileMode, Map<string, number>> = {
    light: new Map(),
    dark: new Map(),
  };
  private nextCustomDraftRevision = 0;

  constructor(app: App, private readonly plugin: DefaultThemeStyleTunerPlugin) {
    super(app, plugin);
    // Applied here rather than in a display() override, which is never called on 1.13+.
    this.containerEl.addClass("theme-basics-settings");
  }

  dispose(): void {
    this.clearColorControls();
    this.clearPendingCustom();
    this.displayToken.active = false;
  }

  clearPendingCustomValue(mode: ProfileMode, key: string): void {
    this.pendingCustom[mode].delete(key);
    this.customDrafts[mode].delete(key);
    this.customDraftRevisions[mode].delete(key);
  }

  getPendingCustomRevision(mode: ProfileMode, key: string): number | undefined {
    return this.customDraftRevisions[mode].get(key);
  }

  clearPendingCustomValueIfUnchanged(mode: ProfileMode, key: string, revision: number | undefined): void {
    if (this.getPendingCustomRevision(mode, key) === revision) this.clearPendingCustomValue(mode, key);
  }

  getPendingCustomRevisions(mode: ProfileMode): ReadonlyMap<string, number> {
    return new Map(this.customDraftRevisions[mode]);
  }

  clearPendingCustomRevisions(mode: ProfileMode, revisions: ReadonlyMap<string, number>): void {
    for (const [key, revision] of revisions) this.clearPendingCustomValueIfUnchanged(mode, key, revision);
  }

  clearPendingCustom(mode?: ProfileMode): void {
    if (mode) {
      this.pendingCustom[mode].clear();
      this.customDrafts[mode].clear();
      this.customDraftRevisions[mode].clear();
    } else {
      this.pendingCustom.light.clear();
      this.pendingCustom.dark.clear();
      this.customDrafts.light.clear();
      this.customDrafts.dark.clear();
      this.customDraftRevisions.light.clear();
      this.customDraftRevisions.dark.clear();
    }
  }

  override hide(): void {
    // The settings modal tears down declaratively rendered rows via super.hide().
    // Do not replace the root token: Obsidian re-renders the cached
    // definitions on reopen without calling getSettingDefinitions() again.
    this.clearColorControls();
    this.clearPendingCustom();
    this.visibility++;
    super.hide();
  }

  refreshDisplayPreserveScroll(): void {
    if (!this.containerEl.isShown()) {
      // Hidden declarative tabs still need fresh definitions for reopening/search.
      this.update();
      return;
    }
    const containers = [this.containerEl, this.containerEl.parentElement].filter(
      (element): element is HTMLElement => element !== null && element.instanceOf(HTMLElement)
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
    window.requestAnimationFrame(() => {
      restoreScrollPosition();
      window.requestAnimationFrame(() => {
        restoreScrollPosition();
      });
    });
  }

  /**
   * Declarative settings for Obsidian 1.13+. Obsidian renders the tab from the
   * returned array; rows share their configurators (e.g. {@link configureColorSetting}).
   *
   * Must stay cheap: it runs on every update() and once when the tab is
   * registered for search indexing.  Expensive work (theme-default DOM
   * probes) lives in the render callbacks, which run only when a row is
   * drawn.
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    this.clearColorControls();
    const token: DisplayToken = { active: true };
    this.displayToken = token;
    const editedMode = this.plugin.getEditedProfileMode();
    const otherMode = editedMode === "light" ? "dark" : "light";

    return [
      // ── Profile controls ────────────────────────────────────────────
      {
        name: "Profile to edit",
        desc: "Choose whether you are editing the light or dark profile.",
        render: this.renderRow(token, (setting, rowToken) => {
          this.configureProfileRow(setting, editedMode, rowToken);
        }),
      },
      {
        name: "Copy edited profile",
        desc: `Copy all ${PROFILE_LABELS[editedMode]} values into the ${PROFILE_LABELS[otherMode]} profile.`,
        render: this.renderRow(token, (setting, rowToken) => {
          this.configureCopyProfileRow(setting, editedMode, rowToken);
        }),
      },
      {
        name: `Reset ${PROFILE_LABELS[editedMode]} profile`,
        desc: `Clear every override in the ${PROFILE_LABELS[editedMode]} profile.`,
        render: this.renderRow(token, (setting, rowToken) => {
          this.configureResetProfileRow(setting, editedMode, rowToken);
        }),
      },
      {
        name: "Reset both profiles",
        desc: "Clear every override in both light and dark profiles.",
        render: this.renderRow(token, (setting, rowToken) => {
          this.configureResetAllRow(setting, rowToken);
        }),
      },

      // ── Settings pages ──────────────────────────────────────────────
      ...SETTINGS_PAGES.map((page): SettingDefinitionPage => ({
        type: "page",
        name: page.name,
        desc: page.desc,
        items: this.pageDefinitions(page, editedMode, token),
      })),
    ];
  }

  private clearColorControls(): void {
    this.activeColorModal?.close();
    this.activeColorModal = null;
    this.colorControlRefreshers.clear();
  }

  private refreshColorControls(): void {
    for (const refresh of this.colorControlRefreshers) refresh();
  }

  /**
   * Returns `true` when the tab has been rebuilt or a declarative row has
   * been torn down, so its handlers must not use stale DOM references.
   */
  private isStale(token: DisplayToken): boolean {
    let current = token;
    while (current.parent) {
      if (!current.active || this.isHiddenSince(current)) return true;
      current = current.parent;
    }
    return !current.active || this.isHiddenSince(current) || current !== this.displayToken;
  }

  private isHiddenSince(token: DisplayToken): boolean {
    return token.visibility !== undefined && token.visibility !== this.visibility;
  }

  /** Declarative pages may tear down rows without rebuilding the tab's definitions. */
  private renderRow(
    token: DisplayToken,
    configure: (setting: Setting, rowToken: DisplayToken) => void | (() => void)
  ): (setting: Setting) => () => void {
    return (setting) => {
      const rowToken: DisplayToken = { active: true, parent: token, visibility: this.visibility };
      const cleanup = configure(setting, rowToken);
      return () => {
        rowToken.active = false;
        cleanup?.();
      };
    };
  }

  /** Re-renders the declarative settings tab. */
  private rerender(): void {
    this.update();
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
      // Native subpages render outside the tab's container class.
      cls: SECTION_CLASS,
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

  /** The "Profile to edit" row that leads each profile-dependent page. */
  private profileDef(mode: ProfileMode, token: DisplayToken): SettingGroupItem {
    return {
      name: "Profile to edit",
      desc: "Choose whether you are editing the light or dark profile.",
      render: this.renderRow(token, (setting, rowToken) => {
        this.configureProfileRow(setting, mode, rowToken);
      }),
    };
  }

  /** Items for one declarative page; profile-dependent pages lead with the profile row. */
  private pageDefinitions(page: SettingsPage, mode: ProfileMode, token: DisplayToken): SettingDefinitionItem[] {
    return [
      ...(page.profileRow ? [this.profileDef(mode, token)] : []),
      ...this.pageContentDefinitions(page, mode, token),
    ];
  }

  private pageContentDefinitions(page: SettingsPage, mode: ProfileMode, token: DisplayToken): SettingDefinitionItem[] {
    switch (page.id) {
      case "palette":
        return this.palettePageDefinitions(mode, token);
      case "backgrounds":
        return [this.pageGroup(page.desc, BACKGROUND_OPTIONS.map((option) => this.colorDef(mode, option, token)))];
      case "links":
        return [this.pageGroup(page.desc, LINK_OPTIONS.map((option) => this.colorDef(mode, option, token)))];
      case "typography":
        return [this.pageGroup(page.desc, [
          ...TYPOGRAPHY_COLOR_OPTIONS.map((option) => this.colorDef(mode, option, token)),
          ...TYPOGRAPHY_OPTIONS.map((option) => this.sliderDef(mode, option, token)),
        ])];
      case "headings":
        return HEADING_LEVELS.map((level) => this.headingGroupDef(mode, level, token));
      case "advanced":
        return [
          this.sectionGroup("Lists and rules", "Adjust list spacing, indentation, and horizontal rule styling.", [
            ...ADVANCED_LIST_OPTIONS.map((option) => this.sliderDef(mode, option, token)),
            ...ADVANCED_LIST_COLOR_OPTIONS.map((option) => this.colorDef(mode, option, token)),
          ]),
          this.sectionGroup("Blockquotes", "Customize blockquote text, background, and border colors.",
            ADVANCED_BLOCKQUOTE_OPTIONS.map((option) => this.colorDef(mode, option, token))
          ),
          this.sectionGroup("Code", "Control inline code and code block colors and font size.", [
            ...ADVANCED_CODE_COLOR_OPTIONS.map((option) => this.colorDef(mode, option, token)),
            ...ADVANCED_CODE_SLIDER_OPTIONS.map((option) => this.sliderDef(mode, option, token)),
          ]),
          this.sectionGroup("Tags", "Style tags in Reading mode and Live Preview.",
            ADVANCED_TAG_OPTIONS.map((option) => this.colorDef(mode, option, token))
          ),
        ];
      case "importExport":
        return [this.pageGroup(page.desc, [
          {
            name: "Export settings",
            desc: "Download your current settings as a JSON file that can be imported later or shared with others.",
            render: this.renderRow(token, (setting, rowToken) => {
              this.configureExportJsonRow(setting, rowToken);
            }),
          },
          {
            name: "Import settings",
            desc: "Load settings from a previously exported JSON file. This will overwrite your current settings.",
            render: this.renderRow(token, (setting, rowToken) => {
              this.configureImportJsonRow(setting, rowToken);
            }),
          },
          {
            name: "Export as CSS snippet",
            desc:
              `Save your current style overrides to ${this.app.vault.configDir}/snippets/theme-basics.css. ` +
              "You can then enable it in Appearance → CSS snippets and use it without this plugin.",
            render: this.renderRow(token, (setting, rowToken) => {
              this.configureExportSnippetRow(setting, rowToken);
            }),
          },
        ])];
    }
  }

  /** A heading-less group that opens a page with its section description. */
  private pageGroup(description: string, items: SettingGroupItem[]): SettingDefinitionItem {
    return {
      type: "group",
      cls: SECTION_CLASS,
      items: [this.sectionIntro(description), ...items],
    };
  }

  private palettePageDefinitions(mode: ProfileMode, token: DisplayToken): SettingDefinitionItem[] {
    return [
      this.sectionGroup("Colors", this.paletteDescription(mode),
        this.plugin.settings.palettes[mode].map((_, index) => this.paletteDef(mode, index, token))
      ),
      {
        name: "Add palette color",
        desc: "Add another editable color slot.",
        render: this.renderRow(token, (setting, rowToken) => {
          this.configureAddPaletteRow(setting, mode, rowToken);
        }),
      },
      this.sectionGroup("Import color list", this.paletteListDescription(mode), [
        {
          name: "Color list format",
          desc: PALETTE_LIST_FORMAT_DESC,
          render: this.renderRow(token, (setting, rowToken) => this.configurePaletteListFormat(setting, rowToken)),
        },
        {
          name: "Color list",
          desc: "Paste colors or load a CSV or JSON file.",
          render: this.renderRow(token, (setting, rowToken) => this.configurePaletteListInput(setting, rowToken)),
        },
        {
          name: "Import colors",
          desc: this.paletteListDescription(mode),
          render: this.renderRow(token, (setting, rowToken) => this.configurePaletteListActions(setting, mode, rowToken)),
        },
      ]),
      this.sectionGroup("Import Base16 theme", this.base16Description(mode), [
        {
          name: "Base16 YAML",
          desc: "Paste the full text of a Base16 .yaml file below. " +
            "Lines containing base00–base0F hex values are detected automatically; all other lines are ignored.",
          render: this.renderRow(token, (setting, rowToken) => {
            this.configureBase16TextareaRow(setting, rowToken);
          }),
        },
        {
          name: `Apply Base16 theme to ${PROFILE_LABELS[mode]}`,
          searchable: false,
          render: this.renderRow(token, (setting, rowToken) => {
            this.configureBase16ApplyRow(setting, mode, rowToken);
          }),
        },
      ]),
    ];
  }

  private paletteDescription(mode: ProfileMode): string {
    return `Edit the ${PROFILE_LABELS[mode]} palette, then select its colors in the main settings. ` +
      "An unset palette color inherits the theme until you set it. Color 1 corresponds to base00; Color 16 to base0F. " +
      "Enter any supported CSS color or use the picker; add more colors below.";
  }

  private paletteListDescription(mode: ProfileMode): string {
    return `Import colors into the ${PROFILE_LABELS[mode]} palette. Append adds new slots; ` +
      "replace updates slots by position while retaining remaining colors and assignments.";
  }

  private base16Description(mode: ProfileMode): string {
    return `Replace colors in the ${PROFILE_LABELS[mode]} palette from a Base16 YAML scheme. ` +
      "Existing color assignments stay attached to the same palette slots; missing colors are unchanged.";
  }

  private paletteSlotDescription(mode: ProfileMode, index: number): string {
    return this.plugin.settings.palettes[mode][index]
      ? "Edit this palette color. All settings assigned to it update together."
      : "Not set. Choose a color, or press Set to use the color shown by the picker.";
  }

  private paletteDef(mode: ProfileMode, index: number, token: DisplayToken): SettingGroupItem {
    return {
      name: `Color ${index + 1}`,
      desc: this.paletteSlotDescription(mode, index),
      render: this.renderRow(token, (setting, rowToken) => {
        this.configurePaletteSetting(setting, mode, index, rowToken);
      }),
    };
  }

  private configureAddPaletteRow(setting: Setting, mode: ProfileMode, token: DisplayToken): void {
    setting.addButton((button) => button.setButtonText("Add color").onClick(async () => {
      if (this.isStale(token)) return;
      try {
        await this.plugin.addPaletteSlot(mode);
        if (!this.isStale(token)) this.refreshDisplayPreserveScroll();
      } catch (error) {
        new Notice(`Unable to add color: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }

  private configurePaletteListFormat(setting: Setting, token: DisplayToken): void {
    setting.addDropdown((dropdown) => dropdown
      .addOption("", "Select a format")
      .addOption("csv", "CSV")
      .addOption("json", "JSON")
      .setValue(this.paletteListFormat)
      .onChange((value) => {
        if (!this.isStale(token) && (value === "" || value === "csv" || value === "json")) {
          this.paletteListFormat = value;
          this.paletteListRevision++;
        }
      }));
  }

  private configurePaletteListInput(setting: Setting, token: DisplayToken): void {
    setting.addTextArea((textarea) => {
      textarea.setPlaceholder(PALETTE_LIST_PLACEHOLDER).setValue(this.paletteList)
        .onChange((value) => {
          if (!this.isStale(token)) {
            this.paletteList = value;
            this.paletteListRevision++;
          }
        });
      textarea.inputEl.rows = 7;
      textarea.inputEl.addClass("theme-basics-base16-textarea");
    });
    setting.addButton((button) => button.setButtonText("Load file").onClick(() => {
      if (this.isStale(token)) return;
      const revision = ++this.paletteListRevision;
      // The factory creates in the main document; adopt into the active popout if needed.
      const input = activeDocument.adoptNode(createEl("input", { type: "file" }));
      input.accept = ".csv,.json,text/csv,application/json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file || this.isStale(token) || revision !== this.paletteListRevision) return;
        try {
          const contents = await file.text();
          if (this.isStale(token) || revision !== this.paletteListRevision) return;
          this.paletteList = contents;
          if (/\.csv$/i.test(file.name)) this.paletteListFormat = "csv";
          else if (/\.json$/i.test(file.name)) this.paletteListFormat = "json";
          this.refreshDisplayPreserveScroll();
        } catch (error) {
          if (!this.isStale(token) && revision === this.paletteListRevision) {
            new Notice(`Unable to read color list: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      };
      input.click();
    }));
  }

  private configurePaletteListActions(setting: Setting, mode: ProfileMode, token: DisplayToken): void {
    const apply = async (operation: "append" | "replace"): Promise<void> => {
      if (this.isStale(token)) return;
      if (!this.paletteListFormat) {
        new Notice("Choose CSV or JSON before importing colors.");
        return;
      }
      try {
        const count = await this.plugin.importPaletteColors(mode, this.paletteList, this.paletteListFormat, operation);
        new Notice(`Imported ${count} colors to the ${PROFILE_LABELS[mode]} palette.`);
        if (!this.isStale(token)) this.refreshDisplayPreserveScroll();
      } catch (error) {
        new Notice(`Unable to import colors: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    setting.addButton((button) => button.setButtonText("Append colors").onClick(() => apply("append")));
    setting.addButton((button) => button.setButtonText("Replace by position").onClick(() => apply("replace")));
  }

  private configurePaletteSetting(setting: Setting, mode: ProfileMode, index: number, token: DisplayToken): void {
    let picker: ColorComponent | null = null;
    let text: TextComponent | null = null;
    let current = this.plugin.settings.palettes[mode][index] ?? "";
    let draft = current;
    let edited = false;
    let syncing = false;
    let updateSequence = 0;
    const swatch = addColorSwatch(setting.controlEl, current);
    setting.setDesc(this.paletteSlotDescription(mode, index));
    const saveColor = async (value: string, syncPicker: boolean): Promise<void> => {
      if (this.isStale(token)) return;
      const sequence = ++updateSequence;
      try {
        await this.plugin.setPaletteColor(mode, index, value);
        if (this.isStale(token)) return;
        current = this.plugin.settings.palettes[mode][index] ?? "";
        swatch.removeClass("is-unset");
        swatch.setCssProps({ "--theme-basics-swatch-color": current });
        setting.setDesc(this.paletteSlotDescription(mode, index));
        this.refreshColorControls();
        // A newer text draft must not be replaced by this completed save.
        if (sequence !== updateSequence) return;
        draft = current;
        edited = false;
        syncing = true;
        try {
          text?.setValue(current);
          if (syncPicker) {
            const hex = this.plugin.styleManager.tryToPickerHex(current);
            if (hex && picker && picker.getValue().toLowerCase() !== hex.toLowerCase()) picker.setValue(hex);
          }
        } finally { syncing = false; }
      } catch (error) {
        new Notice(`Unable to set color: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    setting.addText((component) => {
      text = component;
      component.setPlaceholder("CSS color").setValue(current).onChange((value) => {
        if (syncing || this.isStale(token)) return;
        draft = value;
        edited = true;
        updateSequence++;
      });
      component.inputEl.addClass("theme-basics-palette-text");
      component.inputEl.setAttribute("aria-label", `CSS color for Color ${index + 1}`);
    });
    setting.addColorPicker((component) => {
      picker = component;
      const hex = current ? this.plugin.styleManager.tryToPickerHex(current) : null;
      if (hex) component.setValue(hex);
      component.onChange(async (value) => {
        if (syncing || this.isStale(token)) return;
        // Keep an attempted picker value as a retryable draft if persistence fails.
        draft = value;
        edited = true;
        syncing = true;
        try { text?.setValue(value); }
        finally { syncing = false; }
        await saveColor(value, false);
      });
      const input = setting.controlEl.querySelector<HTMLInputElement>("input[type=color]");
      if (!input) throw new Error("Palette color picker is unavailable.");
      input.setAttribute("aria-label", `Picker for Color ${index + 1}`);
    });
    setting.addButton((button) => button.setButtonText("Set").onClick(async () => {
      if (!draft.trim() && !current && !edited && picker) await saveColor(picker.getValue(), true);
      else await saveColor(draft, true);
    }));
  }

  private colorDef(mode: ProfileMode, option: ColorOption, token: DisplayToken): SettingGroupItem {
    return {
      name: option.name,
      desc: `${option.description} Reset to inherit the theme default.`,
      render: this.renderRow(token, (setting, rowToken) =>
        this.configureColorSetting(setting, mode, option, rowToken)
      ),
    };
  }

  private sliderDef(mode: ProfileMode, option: SliderOption, token: DisplayToken): SettingGroupItem {
    return {
      name: option.name,
      desc: `${option.description} Reset to inherit the theme default.`,
      render: this.renderRow(token, (setting, rowToken) => {
        this.configureSliderSetting(setting, mode, option, rowToken);
      }),
    };
  }

  /** Heading-per-level group for the declarative Headings page. */
  private headingGroupDef(mode: ProfileMode, level: HeadingLevel, token: DisplayToken): SettingDefinitionItem {
    const { color, sliders } = this.headingOptions(level);
    return {
      type: "group",
      heading: `H${level}`,
      cls: SECTION_CLASS,
      items: [
        this.colorDef(mode, color, token),
        ...sliders.map((option) => this.sliderDef(mode, option, token)),
      ],
    };
  }

  /** Option descriptors for one heading level, shared by both rendering paths. */
  private headingOptions(level: HeadingLevel): { color: ColorOption; sliders: SliderOption[] } {
    const defaults = HEADING_DEFAULTS[level];
    return {
      color: {
        key: `h${level}Color`,
        // Names key declarative rows and label search results, so they must be unique.
        name: `H${level} color`,
        description: `Text color for H${level} headings.`,
        variableName: `--h${level}-color`,
      },
      sliders: [
        {
          key: `h${level}Size`,
          name: `H${level} size`,
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
          name: `H${level} weight`,
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
          name: `H${level} line height`,
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
      let syncing = false;
      dropdown
        .addOption("light", "Light")
        .addOption("dark", "Dark")
        .setValue(editedMode)
        .setDisabled(this.profileSwitchesInFlight > 0)
        .onChange(async (value) => {
          if (syncing || this.isStale(token)) return;
          if (value !== "light" && value !== "dark") return;
          // The visible rows still edit editedMode until the write commits.
          // Keep the dropdown aligned with them and prevent another user switch.
          const revision = ++this.profileSelectionRevision;
          this.profileSwitchesInFlight++;
          syncing = true;
          try {
            dropdown.setValue(editedMode);
            dropdown.setDisabled(true);
          } finally { syncing = false; }
          try {
            await this.plugin.setEditedProfileMode(value);
          } catch (error) {
            if (revision === this.profileSelectionRevision) {
              new Notice(`Unable to change profile: ${error instanceof Error ? error.message : String(error)}`);
            }
          } finally {
            this.profileSwitchesInFlight--;
            // Refresh even after a stale row is torn down: a committed switch
            // must re-render handlers for the profile shown in the new dropdown.
            this.refreshDisplayPreserveScroll();
          }
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
      button.setDestructive().setButtonText("Reset profile").onClick(async () => {
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
      button.setDestructive().setButtonText("Reset both").onClick(async () => {
        if (this.isStale(token)) return;
        await this.plugin.resetAllSettings();
        if (this.isStale(token)) return;
        this.refreshDisplayPreserveScroll();
      })
    );
  }

  private configureExportJsonRow(setting: Setting, token: DisplayToken): void {
    setting.addButton((button) =>
      button
        .setButtonText("Export JSON")
        .setIcon("lucide-download")
        .onClick(() => {
          if (!this.isStale(token)) this.plugin.exportSettingsJson();
        })
    );
  }

  private configureImportJsonRow(setting: Setting, token: DisplayToken): void {
    setting.addButton((button) =>
      button
        .setButtonText("Import JSON")
        .setIcon("lucide-upload")
        .onClick(() => {
          if (!this.isStale(token)) this.plugin.importSettingsJson();
        })
    );
  }

  private configureExportSnippetRow(setting: Setting, token: DisplayToken): void {
    setting.addButton((button) =>
      button
        .setButtonText("Export snippet")
        .setIcon("lucide-file-code")
        .onClick(async () => {
          if (!this.isStale(token)) await this.plugin.exportCssSnippet();
        })
    );
  }

  private configureBase16TextareaRow(setting: Setting, token: DisplayToken): void {
    setting.addTextArea((textarea) => {
      textarea
        .setPlaceholder("Paste the base16 YAML here.")
        .setValue(this.base16Yaml)
        .onChange((value) => {
          if (!this.isStale(token)) this.base16Yaml = value;
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

  /** Palette selection preserves old literal colors until an explicit custom commit. */
  private configureColorSetting(
    setting: Setting,
    mode: ProfileMode,
    option: ColorOption,
    token: DisplayToken
  ): () => void {
    let resetButton: ExtraButtonComponent | null = null;
    let refreshSelection = (): void => {};
    let refreshCustomPicker = (): void => {};
    const isPending = (): boolean => this.pendingCustom[mode].has(option.key);
    const draft = (): string => this.customDrafts[mode].get(option.key) ?? this.plugin.getResolvedProfile(mode)[option.key];
    const setDraft = (value: string): void => {
      this.pendingCustom[mode].add(option.key);
      this.customDrafts[mode].set(option.key, value);
      this.customDraftRevisions[mode].set(option.key, ++this.nextCustomDraftRevision);
    };
    let rowModal: PaletteChoiceModal | null = null;
    const makeChoices = (): PaletteChoice[] => {
      const existing = this.plugin.getProfile(mode)[option.key];
      const assignment = this.plugin.settings.colorAssignments[mode][option.key];
      const isCustom = isPending() || (assignment === undefined && Boolean(existing));
      const choices: PaletteChoice[] = [{
        value: "", label: "Inherit", color: "",
        selected: !isPending() && assignment === undefined && !existing,
      }, {
        value: "custom", label: "Custom", color: isCustom ? draft() : "", selected: isCustom,
      }];
      const palette = this.plugin.settings.palettes[mode];
      for (let index = 0; index < palette.length; index++) {
        const color = palette[index] ?? "";
        choices.push({
          value: String(index), label: `Color ${index + 1}${color ? "" : " (not set)"}`,
          color, selected: !isPending() && assignment === index,
        });
      }
      return choices;
    };
    setting.addExtraButton((button) => {
      resetButton = button;
      button.setIcon("lucide-rotate-ccw").setTooltip("Reset to theme default")
        .onClick(async () => {
          if (this.isStale(token)) return;
          await this.plugin.resetProfileValue(mode, option.key);
          if (!this.isStale(token)) refreshSelection();
        });
    }).addButton((button) => {
      const element = button.buttonEl;
      element.addClass("theme-basics-color-select");
      element.setAttribute("aria-haspopup", "dialog");
      element.setAttribute("aria-expanded", "false");
      refreshSelection = () => {
        const selected = makeChoices().find((choice) => choice.selected);
        if (!selected) throw new Error("Color selection is invalid.");
        element.empty();
        addColorSwatch(element, selected.color);
        const label = selected.value === "custom" && selected.color
          ? `Custom: ${selected.color}` : selected.label;
        element.createSpan({ cls: "theme-basics-color-label", text: label });
        const arrow = element.createSpan({ cls: "theme-basics-color-arrow" });
        setIcon(arrow, "lucide-chevron-down");
        arrow.setAttribute("aria-hidden", "true");
        element.setAttribute("aria-label", `${option.description} ${label}`);
        resetButton?.setDisabled(selected.value === "");
        refreshCustomPicker();
      };
      refreshSelection();
      this.colorControlRefreshers.add(refreshSelection);
      button.onClick(() => {
        if (this.isStale(token)) return;
        this.activeColorModal?.close();
        const modal = new PaletteChoiceModal(this.app, option.description, makeChoices(), (choice) => {
          if (this.isStale(token)) return;
          const apply = async (): Promise<void> => {
            try {
              if (choice.value === "custom") {
                // Reselecting Custom is a newer intent even if its text is unchanged.
                setDraft(isPending() ? draft() : this.plugin.getResolvedProfile(mode)[option.key]);
              } else if (choice.value === "") {
                await this.plugin.resetProfileValue(mode, option.key);
              } else {
                await this.plugin.setColorAssignment(mode, option.key, Number(choice.value));
              }
              if (!this.isStale(token)) refreshSelection();
            } catch (error) {
              new Notice(`Unable to change color: ${error instanceof Error ? error.message : String(error)}`);
            }
          };
          void apply();
        }, (closed) => {
          element.setAttribute("aria-expanded", "false");
          if (this.activeColorModal === closed) this.activeColorModal = null;
          if (rowModal === closed) rowModal = null;
        });
        rowModal = modal;
        this.activeColorModal = modal;
        element.setAttribute("aria-expanded", "true");
        modal.open();
      });
    });

    const customContainer = setting.controlEl.createDiv({ cls: "theme-basics-custom-color" });
    let picker: ColorComponent | null = null;
    let text: TextComponent | null = null;
    let syncing = false;
    refreshCustomPicker = () => {
      const existing = this.plugin.getProfile(mode)[option.key];
      const assignment = this.plugin.settings.colorAssignments[mode][option.key];
      const isCustom = isPending() || (assignment === undefined && Boolean(existing));
      setting.controlEl.toggleClass("theme-basics-has-custom-color", isCustom);
      if (!isCustom) {
        customContainer.empty();
        picker = null;
        text = null;
        return;
      }
      if (!text) {
        const currentText = new TextComponent(customContainer).setPlaceholder("CSS color");
        text = currentText;
        currentText.inputEl.addClass("theme-basics-palette-text");
        currentText.inputEl.setAttribute("aria-label", `Custom CSS color for ${option.description}`);
        currentText.onChange((value) => {
          if (syncing || text !== currentText || this.isStale(token)) return;
          setDraft(value);
          refreshSelection();
        });
        const currentPicker = new ColorComponent(customContainer);
        picker = currentPicker;
        const input = customContainer.querySelector<HTMLInputElement>("input[type=color]");
        if (!input) throw new Error("Custom color picker is unavailable.");
        input.setAttribute("aria-label", `Custom color for ${option.description}`);
        currentPicker.onChange((value) => {
          if (syncing || picker !== currentPicker || this.isStale(token)) return;
          setDraft(value);
          refreshSelection();
        });
        new ButtonComponent(customContainer).setButtonText("Set")
          .setTooltip("Add or reuse this color in the palette")
          .onClick(async () => {
            if (picker !== currentPicker || this.isStale(token)) return;
            // Explicit Set also permits the picker’s displayed black on an empty draft.
            const value = draft().trim() || currentPicker.getValue();
            const revision = this.customDraftRevisions[mode].get(option.key);
            try {
              await this.plugin.commitCustomColor(mode, option.key, value);
              if (this.customDraftRevisions[mode].get(option.key) === revision) {
                this.clearPendingCustomValue(mode, option.key);
              }
              // A new palette slot may rebuild this row while the write is pending.
              // Refresh the current controls, not a detached control from that row.
              this.refreshColorControls();
            } catch (error) {
              new Notice(`Unable to set custom color: ${error instanceof Error ? error.message : String(error)}`);
            }
          });
      }
      const value = draft();
      const hex = value ? this.plugin.styleManager.tryToPickerHex(value) : null;
      syncing = true;
      try {
        if (text.getValue() !== value) text.setValue(value);
        if (hex && picker && picker.getValue().toLowerCase() !== hex.toLowerCase()) picker.setValue(hex);
      } finally {
        syncing = false;
      }
    };
    refreshCustomPicker();
    return () => {
      this.colorControlRefreshers.delete(refreshSelection);
      rowModal?.close();
    };
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
}

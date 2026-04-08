import type {
  ColorOption,
  DefaultThemeStyleTunerProfile,
  DefaultThemeStyleTunerSettings,
  HeadingDefaults,
  HeadingLevel,
  ProfileMode,
  SliderOption,
  StringProfileKey,
} from "./types";

export const BODY_CLASS = "default-theme-style-tuner-active";
export const STYLE_ELEMENT_ID = "default-theme-style-tuner-inline-styles";

export const PROFILE_LABELS: Record<ProfileMode, string> = {
  light: "Light",
  dark: "Dark",
};

export const DEFAULT_PROFILE: DefaultThemeStyleTunerProfile = {
  backgroundPrimary: "",
  backgroundSecondary: "",
  backgroundPrimaryAlt: "",
  backgroundSecondaryAlt: "",
  textNormal: "",
  textMuted: "",
  textFaint: "",
  linkColor: "",
  linkHoverAuto: false,
  linkHoverColor: "",
  externalLinkColor: "",
  externalLinkHoverAuto: false,
  externalLinkHoverColor: "",
  unresolvedLinkColor: "",
  boldColor: "",
  italicColor: "",
  highlightBackground: "",
  fontTextSize: "",
  lineHeightNormal: "",
  pSpacing: "",
  listIndent: "",
  listSpacing: "",
  hrColor: "",
  hrThickness: "",
  blockquoteColor: "",
  blockquoteBackgroundColor: "",
  blockquoteBorderColor: "",
  codeNormal: "",
  codeBackground: "",
  codeSize: "",
  tagColor: "",
  tagBackground: "",
  tagBorderColor: "",
  h1Color: "",
  h1Size: "",
  h1Weight: "",
  h1LineHeight: "",
  h2Color: "",
  h2Size: "",
  h2Weight: "",
  h2LineHeight: "",
  h3Color: "",
  h3Size: "",
  h3Weight: "",
  h3LineHeight: "",
  h4Color: "",
  h4Size: "",
  h4Weight: "",
  h4LineHeight: "",
  h5Color: "",
  h5Size: "",
  h5Weight: "",
  h5LineHeight: "",
  h6Color: "",
  h6Size: "",
  h6Weight: "",
  h6LineHeight: "",
};

export const DEFAULT_SETTINGS: DefaultThemeStyleTunerSettings = {
  version: 2,
  uiProfile: "light",
  profiles: {
    light: { ...DEFAULT_PROFILE },
    dark: { ...DEFAULT_PROFILE },
  },
};

export const PROFILE_KEYS = Object.keys(DEFAULT_PROFILE) as Array<keyof DefaultThemeStyleTunerProfile>;

export const CSS_VARIABLES: Record<StringProfileKey, string> = {
  backgroundPrimary: "--background-primary",
  backgroundSecondary: "--background-secondary",
  backgroundPrimaryAlt: "--background-primary-alt",
  backgroundSecondaryAlt: "--background-secondary-alt",
  textNormal: "--text-normal",
  textMuted: "--text-muted",
  textFaint: "--text-faint",
  linkColor: "--link-color",
  linkHoverColor: "--link-color-hover",
  externalLinkColor: "--link-external-color",
  externalLinkHoverColor: "--link-external-color-hover",
  unresolvedLinkColor: "--link-unresolved-color",
  boldColor: "--bold-color",
  italicColor: "--italic-color",
  highlightBackground: "--text-highlight-bg",
  fontTextSize: "--font-text-size",
  lineHeightNormal: "--line-height-normal",
  pSpacing: "--p-spacing",
  listIndent: "--list-indent",
  listSpacing: "--list-spacing",
  hrColor: "--hr-color",
  hrThickness: "--hr-thickness",
  blockquoteColor: "--blockquote-color",
  blockquoteBackgroundColor: "--blockquote-background-color",
  blockquoteBorderColor: "--blockquote-border-color",
  codeNormal: "--code-normal",
  codeBackground: "--code-background",
  codeSize: "--code-size",
  tagColor: "--tag-color",
  tagBackground: "--tag-background",
  tagBorderColor: "--tag-border-color",
  h1Color: "--h1-color",
  h1Size: "--h1-size",
  h1Weight: "--h1-weight",
  h1LineHeight: "--h1-line-height",
  h2Color: "--h2-color",
  h2Size: "--h2-size",
  h2Weight: "--h2-weight",
  h2LineHeight: "--h2-line-height",
  h3Color: "--h3-color",
  h3Size: "--h3-size",
  h3Weight: "--h3-weight",
  h3LineHeight: "--h3-line-height",
  h4Color: "--h4-color",
  h4Size: "--h4-size",
  h4Weight: "--h4-weight",
  h4LineHeight: "--h4-line-height",
  h5Color: "--h5-color",
  h5Size: "--h5-size",
  h5Weight: "--h5-weight",
  h5LineHeight: "--h5-line-height",
  h6Color: "--h6-color",
  h6Size: "--h6-size",
  h6Weight: "--h6-weight",
  h6LineHeight: "--h6-line-height",
};

export const CSS_VARIABLE_NAMES = [...new Set(Object.values(CSS_VARIABLES))];

export const COLOR_OPTIONS: ColorOption[] = [
  {
    key: "backgroundPrimary",
    name: "Primary background",
    description: "Main note and app background.",
    variableName: CSS_VARIABLES.backgroundPrimary,
  },
  {
    key: "backgroundSecondary",
    name: "Secondary background",
    description: "Sidebar and secondary surfaces.",
    variableName: CSS_VARIABLES.backgroundSecondary,
  },
  {
    key: "backgroundPrimaryAlt",
    name: "Primary alt background",
    description: "Alternate primary surfaces.",
    variableName: CSS_VARIABLES.backgroundPrimaryAlt,
  },
  {
    key: "backgroundSecondaryAlt",
    name: "Secondary alt background",
    description: "Alternate secondary surfaces.",
    variableName: CSS_VARIABLES.backgroundSecondaryAlt,
  },
  {
    key: "linkColor",
    name: "Internal link color",
    description: "Default color for internal links. Hover color is computed automatically.",
    variableName: CSS_VARIABLES.linkColor,
  },
  {
    key: "linkHoverColor",
    name: "Internal link hover color",
    description: "Hover color for internal links.",
    variableName: CSS_VARIABLES.linkHoverColor,
    autoToggleKey: "linkHoverAuto",
    autoSourceKey: "linkColor",
    autoToggleName: "Auto-compute internal link hover color",
  },
  {
    key: "externalLinkColor",
    name: "External link color",
    description: "Color for external links and raw URLs. Hover color is computed automatically.",
    variableName: CSS_VARIABLES.externalLinkColor,
  },
  {
    key: "externalLinkHoverColor",
    name: "External link hover color",
    description: "Hover color for external links and raw URLs.",
    variableName: CSS_VARIABLES.externalLinkHoverColor,
    autoToggleKey: "externalLinkHoverAuto",
    autoSourceKey: "externalLinkColor",
    autoToggleName: "Auto-compute external link hover color",
  },
  {
    key: "unresolvedLinkColor",
    name: "Unresolved link color",
    description: "Color used for unresolved internal links.",
    variableName: CSS_VARIABLES.unresolvedLinkColor,
  },
  {
    key: "boldColor",
    name: "Bold color",
    description: "Color used for bold text.",
    variableName: CSS_VARIABLES.boldColor,
  },
  {
    key: "italicColor",
    name: "Italic color",
    description: "Color used for italic text.",
    variableName: CSS_VARIABLES.italicColor,
  },
  {
    key: "highlightBackground",
    name: "Highlight background",
    description: "Color behind ==highlighted== text. Use the text field for rgba() or alpha values.",
    variableName: CSS_VARIABLES.highlightBackground,
  },
];

export const TYPOGRAPHY_COLOR_OPTIONS: ColorOption[] = [
  {
    key: "textNormal",
    name: "Body text color",
    description: "Primary text color used throughout notes.",
    variableName: CSS_VARIABLES.textNormal,
  },
  {
    key: "textMuted",
    name: "Muted text color",
    description: "Secondary text color used for lower emphasis text.",
    variableName: CSS_VARIABLES.textMuted,
  },
  {
    key: "textFaint",
    name: "Faint text color",
    description: "Faint UI and markdown syntax text color.",
    variableName: CSS_VARIABLES.textFaint,
  },
];

export const TYPOGRAPHY_OPTIONS: SliderOption[] = [
  {
    key: "fontTextSize",
    name: "Base font size",
    description: "Primary note text size for Reading mode and Live Preview.",
    variableName: CSS_VARIABLES.fontTextSize,
    min: 12,
    max: 28,
    step: 1,
    unit: "px",
    defaultValue: 16,
  },
  {
    key: "lineHeightNormal",
    name: "Line height",
    description: "Line spacing for note content.",
    variableName: CSS_VARIABLES.lineHeightNormal,
    min: 1.2,
    max: 2.2,
    step: 0.05,
    unit: "",
    defaultValue: 1.5,
  },
  {
    key: "pSpacing",
    name: "Paragraph spacing",
    description: "Vertical spacing around paragraphs and headings.",
    variableName: CSS_VARIABLES.pSpacing,
    min: 0,
    max: 2.5,
    step: 0.05,
    unit: "rem",
    defaultValue: 1,
  },
];

export const ADVANCED_LIST_OPTIONS: SliderOption[] = [
  {
    key: "listIndent",
    name: "List indent",
    description: "Horizontal indentation for list content.",
    variableName: CSS_VARIABLES.listIndent,
    min: 1,
    max: 4,
    step: 0.05,
    unit: "em",
    defaultValue: 2,
  },
  {
    key: "listSpacing",
    name: "List spacing",
    description: "Vertical spacing between list items.",
    variableName: CSS_VARIABLES.listSpacing,
    min: 0,
    max: 0.5,
    step: 0.01,
    unit: "em",
    defaultValue: 0.075,
  },
  {
    key: "hrThickness",
    name: "Horizontal rule thickness",
    description: "Thickness of horizontal rules.",
    variableName: CSS_VARIABLES.hrThickness,
    min: 1,
    max: 8,
    step: 1,
    unit: "px",
    defaultValue: 2,
  },
];

export const ADVANCED_LIST_COLOR_OPTIONS: ColorOption[] = [
  {
    key: "hrColor",
    name: "Horizontal rule color",
    description: "Color used for horizontal rules.",
    variableName: CSS_VARIABLES.hrColor,
  },
];

export const ADVANCED_BLOCKQUOTE_OPTIONS: ColorOption[] = [
  {
    key: "blockquoteColor",
    name: "Blockquote text color",
    description: "Text color for blockquotes.",
    variableName: CSS_VARIABLES.blockquoteColor,
  },
  {
    key: "blockquoteBackgroundColor",
    name: "Blockquote background",
    description: "Background color for blockquotes.",
    variableName: CSS_VARIABLES.blockquoteBackgroundColor,
  },
  {
    key: "blockquoteBorderColor",
    name: "Blockquote border color",
    description: "Left border color for blockquotes.",
    variableName: CSS_VARIABLES.blockquoteBorderColor,
  },
];

export const ADVANCED_CODE_COLOR_OPTIONS: ColorOption[] = [
  {
    key: "codeNormal",
    name: "Code text color",
    description: "Text color used for inline code and code blocks.",
    variableName: CSS_VARIABLES.codeNormal,
  },
  {
    key: "codeBackground",
    name: "Code background",
    description: "Background color for inline code and code blocks.",
    variableName: CSS_VARIABLES.codeBackground,
  },
];

export const ADVANCED_CODE_SLIDER_OPTIONS: SliderOption[] = [
  {
    key: "codeSize",
    name: "Code font size",
    description: "Font size for inline code and fenced code blocks.",
    variableName: CSS_VARIABLES.codeSize,
    min: 0.7,
    max: 1.3,
    step: 0.01,
    unit: "em",
    defaultValue: 0.875,
  },
];

export const ADVANCED_TAG_OPTIONS: ColorOption[] = [
  {
    key: "tagColor",
    name: "Tag text color",
    description: "Text color for tags.",
    variableName: CSS_VARIABLES.tagColor,
  },
  {
    key: "tagBackground",
    name: "Tag background",
    description: "Background color for tags.",
    variableName: CSS_VARIABLES.tagBackground,
  },
  {
    key: "tagBorderColor",
    name: "Tag border color",
    description: "Border color for tags.",
    variableName: CSS_VARIABLES.tagBorderColor,
  },
];

export const COLOR_OPTIONS_BY_KEY = Object.fromEntries(
  COLOR_OPTIONS.map((option) => [option.key, option])
) as Partial<Record<StringProfileKey, ColorOption>>;

export const HEADING_LEVELS: HeadingLevel[] = [1, 2, 3, 4, 5, 6];

export const HEADING_DEFAULTS: Record<HeadingLevel, HeadingDefaults> = {
  1: { size: 1.802, weight: 700, lineHeight: 1.2 },
  2: { size: 1.602, weight: 600, lineHeight: 1.2 },
  3: { size: 1.424, weight: 600, lineHeight: 1.3 },
  4: { size: 1.266, weight: 600, lineHeight: 1.4 },
  5: { size: 1.125, weight: 600, lineHeight: 1.5 },
  6: { size: 1, weight: 600, lineHeight: 1.5 },
};

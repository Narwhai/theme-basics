# Theme Basics

A plugin that allows you to customize basic appearance properties such as background colors, text sizes, line spacing, and more without the need to write custom CSS snippets. 

## Installation Instructions

- Install the BRAT plugin from the Obsidian community plugins
- In the BRAT plugin settings, click "Add beta plugin" in the "Beta plugin list" section
- Paste the link to this repository in the Repository input field
- Click "Add plugin"
- Click "Community Plugins" in the left sidebar, find "Theme Basics" in the list and click "Enable"

## Available Settings

- Separate light and dark profiles
- Backgrounds
  - Primary background color
  - Secondary background color
  - Primary alt background color
  - Secondary alt background color
- Set link colors and emphasis colors
  - Internal link color
  - External link color
  - Unresolved link color
  - Bold color
  - Italic color
  - Highlight background
- Set typography properties such as font size, line height, and paragraph spacing
  - Body text color
  - Muted text color
  - Faint text color
  - Base font size
  - Line height
  - Paragraph spacing
- Set header properties
  - Per-heading controls for H1-H6
  - Color
  - Size
  - Weight
  - Line height
- Lists
  - Indent width
  - Spacing between list items
- Horizontal divider
  - Color
  - Thickness
- Blockquotes
  - Text color
  - Background color
  - Border color
- Code blocks
  - Text color
  - Background color
  - Font size
- Tags
  - Text color
  - Background color
  - Border color

## Notes

- Intended to work mainly with the default theme, if you are using a community theme, settings may not work as intended.
- If you have custom CSS snippets, they also might interfere with the settings found in this plugin if they target the same properties.

## Color palettes

Open **Color palette** from the main Theme Basics settings to edit the palette or
import a Base16 theme. Light and dark profiles each have their own 16-slot palette.
Define colors with the palette pickers or paste a Base16 YAML scheme; Color 1 corresponds to base00 and
Color 16 to base0F. Assign any color setting to a slot to share that color with
other settings. Each color selector opens a searchable chooser with labeled
swatches and marks the current choice. Editing a slot updates all assignments to
it. Unset slots inherit the theme until a color is supplied, and each setting can
also inherit directly.

Base16 import replaces only supplied palette colors, leaving assignments, legacy
color overrides, and missing slots untouched. Existing custom colors stay in place
until explicitly reassigned or reset. Copying a profile includes its palette and
assignments; resetting a profile clears them along with its other overrides.

## Color compatibility

- Obsidian 1.13 introduced OKLCH base colors and deprecated legacy RGB/HSL helper variables. Theme Basics preserves existing modern CSS colors, including `oklch()` and `color-mix()`, in settings and exported snippets until they are reassigned or reset.
- Color overrides take complete CSS colors such as `#ff0000`, `rgb(255, 0, 0)`, or `oklch(60% 0.2 30)`, not bare `255, 0, 0` triplets. The breaking change from triplets to complete colors specifically affects `--callout-color`, which this plugin does not override; legacy `*-rgb` helper variables have not changed into complete colors.
- See the [Obsidian 1.13 release notes](https://obsidian.md/changelog/2026-07-30-desktop-v1.13.4/) and [color-variable reference](https://docs.obsidian.md/Reference/CSS%20variables/Foundations/Colors).

## Development checks

```sh
npm test
npm run lint
npm run build
# Requires the Obsidian CLI and the named vault to be open.
OBSIDIAN_TEST_VAULT=Dev-Vault npm run test:obsidian
# UI tests also require Theme Basics and the Quick Switcher core plugin enabled
# in that vault (settings need not be open). This is a test-only prerequisite.
OBSIDIAN_TEST_VAULT=Dev-Vault npm run test:obsidian:ui
```

Renderer tests use temporary offscreen elements and in-memory plugin instances; they do not change saved settings or reload the installed plugin. The separate UI suite obtains Obsidian's `Setting` constructor via the enabled plugin's settings-tab `addRow` helper; the installed build must provide that helper, but its settings tab need not be open. It exercises the legacy settings path and, where available, Obsidian's real declarative page rendering and navigation using an isolated host rather than the actual settings dialog. The fixture reattaches the main tab after the native back transition because it is not a complete settings dialog. On versions without the declarative API, declarative checks are skipped; an Obsidian version without the CLI cannot run these renderer suites. The suite does not verify visual appearance, native color-picker dialogs, or navigation through the complete settings dialog.

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

## Color compatibility

- Obsidian 1.13 introduced OKLCH base colors and deprecated legacy RGB/HSL helper variables. Theme Basics resolves modern CSS colors, including `oklch()` and `color-mix()`, for its pickers while preserving the original override values in settings and exported snippets.
- Color overrides take complete CSS colors such as `#ff0000`, `rgb(255, 0, 0)`, or `oklch(60% 0.2 30)`, not bare `255, 0, 0` triplets. The breaking change from triplets to complete colors specifically affects `--callout-color`, which this plugin does not override; legacy `*-rgb` helper variables have not changed into complete colors.
- See the [Obsidian 1.13 release notes](https://obsidian.md/changelog/2026-07-30-desktop-v1.13.4/) and [color-variable reference](https://docs.obsidian.md/Reference/CSS%20variables/Foundations/Colors).

## Development checks

```sh
npm test
npm run lint
npm run build
# Requires the Obsidian CLI and the named vault to be open.
OBSIDIAN_TEST_VAULT=Dev-Vault npm run test:obsidian
```

Renderer tests use temporary offscreen elements and in-memory plugin instances; they do not change saved settings or reload the installed plugin.

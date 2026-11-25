import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "manifest.json"],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  // Obsidian rules target plugin code; the test harnesses deliberately run
  // bundled code in Node or inside Obsidian (new Function, global app, etc.).
  ...obsidianmd.configs.recommended.map((config) => ({
    ...config,
    ignores: [...(config.ignores ?? []), "tests/**"],
  })),
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["tests/**/*.mjs"],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  globalIgnores(["node_modules", "dist", "main.js", "package-lock.json"])
);

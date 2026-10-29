import { build } from "esbuild";

export async function bundlePlugin() {
  const result = await build({
    stdin: {
      contents: `export { default as Plugin } from "./src/main";
        export { StyleManager } from "./src/style-manager";
        export { DefaultThemeStyleTunerSettingTab as SettingsTab } from "./src/settings-tab";
        export { DEFAULT_PROFILE, DEFAULT_SETTINGS, BODY_CLASS } from "./src/constants";
        export { sanitizeCssValue } from "./src/utils";`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "cjs",
    platform: "browser",
    external: ["obsidian"],
    minify: true,
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("No test bundle was produced.");
  return output.text;
}

// Self-contained so the same harness can run inside Obsidian's Chromium renderer.
// It never loads/replaces the installed plugin or writes to the vault.
export function createHarness(bundle) {
  const pending = new Map();
  const api = {
    debounce(callback) {
      const key = Symbol();
      const run = () => { pending.set(key, callback); };
      run.cancel = () => { pending.delete(key); };
      return run;
    },
    Notice: class {},
    SuggestModal: class {
      static latest;
      constructor() { api.SuggestModal.latest = this; this.inputEl = { setAttribute() {} }; }
      setTitle() { return this; }
      setPlaceholder() {}
      open() {}
      close() { this.onClose(); }
      onClose() {}
    },
    Plugin: class {
      constructor(app) { this.app = app; }
    },
    PluginSettingTab: class {
      constructor(app) {
        this.app = app;
        this.containerEl = {
          addClass() {},
          empty() {},
          isShown() { return false; },
        };
      }
      update() { this.settingItems = this.getSettingDefinitions(); }
      hide() {}
    },
  };
  const module = { exports: {} };
  const require = (name) => {
    if (name !== "obsidian") throw new Error(`Unexpected module: ${name}`);
    return api;
  };
  new Function("require", "module", "exports", bundle)(require, module, module.exports);
  return {
    ...module.exports,
    SuggestModal: api.SuggestModal,
    flush() {
      for (const [key, callback] of [...pending]) {
        pending.delete(key);
        callback();
      }
    },
  };
}

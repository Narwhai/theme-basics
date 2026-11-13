import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/palette-import.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const output = bundled.outputFiles[0];
if (!output) throw new Error("No palette import test bundle was produced.");
const sourceUrl = `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`;
const { parsePaletteColorList } = await import(sourceUrl);
const accept = () => true;

test("JSON imports a list of CSS color strings without changing their contents", () => {
  const colors = ["#abcd", "rgba(1, 2, 3, 0.5)", "oklch(70%  0.2 40)", "transparent"];
  assert.deepEqual(parsePaletteColorList(JSON.stringify(colors), "json", accept), colors);
  assert.deepEqual(parsePaletteColorList('["  #aabbcc  ", " rgba(1, 2, 3, 0.5) "]', "json", accept), [
    "#aabbcc", "rgba(1, 2, 3, 0.5)",
  ]);
});

test("CSV supports columns, rows, CRLF and a final row terminator", () => {
  assert.deepEqual(parsePaletteColorList("  #112233 , red\r\n#abcdef,  blue\r\n", "csv", accept), [
    "#112233", "red", "#abcdef", "blue",
  ]);
  assert.deepEqual(parsePaletteColorList("red\nblue\n", "csv", accept), ["red", "blue"]);
  assert.deepEqual(parsePaletteColorList("red\rblue\r", "csv", accept), ["red", "blue"]);
});

test("CSV supports quoted fields, escaped quotes and newlines inside a quoted field", () => {
  assert.deepEqual(parsePaletteColorList('  " rgba(1, 2, 3, 0.5) " , "oklch(50% 0.2 30)"\n', "csv", accept), [
    "rgba(1, 2, 3, 0.5)", "oklch(50% 0.2 30)",
  ]);
  assert.deepEqual(parsePaletteColorList('"var(--color, ""red"")", blue', "csv", accept), [
    'var(--color, "red")', "blue",
  ]);
  assert.deepEqual(parsePaletteColorList('"rgb(1\n 2 3)",red', "csv", accept), ["rgb(1\n 2 3)", "red"]);
});

test("CSV accepts commas and nested functions in unquoted CSS color expressions", () => {
  const input = "#fff, rgba(1, 2, 3, 0.25), color-mix(in srgb, rgba(4, 5, 6, .5), var(--other, oklch(50% .2 30)))\nblue";
  assert.deepEqual(parsePaletteColorList(input, "csv", accept), [
    "#fff", "rgba(1, 2, 3, 0.25)",
    "color-mix(in srgb, rgba(4, 5, 6, .5), var(--other, oklch(50% .2 30)))", "blue",
  ]);
  assert.deepEqual(parsePaletteColorList("rgb(1,\n 2, 3), black", "csv", accept), ["rgb(1,\n 2, 3)", "black"]);
});

test("CSV preserves CSS comments while ignoring their parentheses, commas, quotes and newlines", () => {
  const colors = [
    "rgb(1, /* ) */ 2, 3)",
    '/* ) , " */ red',
    "color-mix(in srgb, /* ( , ) */ rgba(1, 2, 3, .5), blue)",
    "rgb(1, /* comment\n ) , */ 2, 3)",
  ];
  assert.deepEqual(parsePaletteColorList(colors.join(", "), "csv", accept), colors);
  assert.deepEqual(parsePaletteColorList('"rgb(1, /* "" ) , */ 2, 3)",blue', "csv", accept), [
    'rgb(1, /* " ) , */ 2, 3)', "blue",
  ]);
});

test("CSS comment markers and parentheses inside CSS strings or escapes stay literal", () => {
  const colors = [
    'var(--foo, "/* ) , */")',
    "var(--foo, '/* ) , */')",
    "var(--foo, thing\\)more)",
  ];
  assert.deepEqual(parsePaletteColorList(colors.join(", "), "csv", accept), colors);
  assert.deepEqual(parsePaletteColorList(JSON.stringify(colors), "json", accept), colors);
  assert.deepEqual(parsePaletteColorList('"var(--foo, ""/*"")",blue', "csv", accept), [
    'var(--foo, "/*")', "blue",
  ]);
});

test("unterminated CSS comments are rejected in unquoted and quoted CSV and JSON", () => {
  for (const input of ["red /* unfinished", "red, rgb(1, /* unfinished", '"rgb(1, /* unfinished 2, 3)"']) {
    assert.throws(() => parsePaletteColorList(input, "csv", accept), /unclosed css comment/i, input);
  }
  assert.throws(() => parsePaletteColorList('["red /* unfinished"]', "json", accept), /unclosed css comment/i);
});

test("empty and malformed CSV entries are rejected rather than discarded", () => {
  for (const input of ["", "  ", ",", "red,,blue", "red,", "red, \nblue", "red\n\nblue", '""', "red\n "]) {
    assert.throws(() => parsePaletteColorList(input, "csv", accept), /empty/i, input);
  }
  for (const input of ['"red', '"red"suffix', 'red"blue', "rgba(1,2,3", "red)"]) {
    assert.throws(() => parsePaletteColorList(input, "csv", accept), /quote|character|parenthesis/i, input);
  }
});

test("invalid JSON and non-list or non-string JSON entries are rejected", () => {
  for (const input of ["", "{", '["red",]', "null", "{}", '"red"']) {
    assert.throws(() => parsePaletteColorList(input, "json", accept), /JSON/i, input);
  }
  assert.throws(() => parsePaletteColorList("[]", "json", accept), /at least one/i);
  for (const input of ['["red", null]', '[42]', '[{}]', '["red", " "]']) {
    assert.throws(() => parsePaletteColorList(input, "json", accept), /color \d+.*(string|empty)/i, input);
  }
});

test("the caller's validator sees each trimmed value and rejects invalid colors", () => {
  const seen = [];
  const validate = (color) => { seen.push(color); return color !== "not-a-color"; };
  assert.throws(
    () => parsePaletteColorList(" red, rgba(1, 2, 3, 0.5), not-a-color ", "csv", validate),
    /Invalid color at position 3: not-a-color/,
  );
  assert.deepEqual(seen, ["red", "rgba(1, 2, 3, 0.5)", "not-a-color"]);
  assert.throws(() => parsePaletteColorList('["valid", "invalid"]', "json", (value) => value === "valid"), /position 2/);
});

test("the parser has no arbitrary color-count limit and rejects unknown formats", () => {
  const colors = Array.from({ length: 256 }, (_, index) => `color${index}`);
  assert.deepEqual(parsePaletteColorList(JSON.stringify(colors), "json", accept), colors);
  assert.deepEqual(parsePaletteColorList(colors.join(","), "csv", accept), colors);
  assert.throws(() => parsePaletteColorList("red", "yaml", accept), /unsupported/i);
});

type PaletteListFormat = "csv" | "json";

type CsvFieldState = "start" | "unquoted" | "quoted" | "after-quote";

/** Parse CSV cells while allowing commas inside unquoted CSS functions. */
function parseCsvColorList(input: string): string[] {
  const fields: string[] = [];
  let field = "";
  let state: CsvFieldState = "start";
  let parentheses = 0;
  let inComment = false;
  let cssQuote = "";
  let escaped = false;
  let endedWithRowBreak = false;

  const finishField = (): void => {
    const value = field.trim();
    if (!value) throw new Error(`CSV color ${fields.length + 1} is empty.`);
    fields.push(value);
    field = "";
    state = "start";
    parentheses = 0;
  };

  for (let index = 0; index < input.length; index++) {
    const char = input.charAt(index);
    const next = input.charAt(index + 1);

    if (state === "quoted") {
      if (char === '"') {
        if (next === '"') {
          field += '"';
          index++;
        } else {
          state = "after-quote";
        }
      } else {
        field += char;
      }
      continue;
    }

    if (state !== "after-quote") {
      if (inComment) {
        field += char;
        if (char === "*" && next === "/") {
          field += next;
          index++;
          inComment = false;
        }
        continue;
      }
      if (cssQuote) {
        field += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === cssQuote) cssQuote = "";
        continue;
      }
      if (escaped) {
        field += char;
        escaped = false;
        continue;
      }
      if (char === "/" && next === "*") {
        field += "/*";
        state = "unquoted";
        inComment = true;
        endedWithRowBreak = false;
        index++;
        continue;
      }
      if (char === "\\") {
        field += char;
        state = "unquoted";
        escaped = true;
        endedWithRowBreak = false;
        continue;
      }
      if (state === "unquoted" && parentheses > 0 && (char === "'" || char === '"')) {
        field += char;
        cssQuote = char;
        continue;
      }
    }

    const isRowBreak = (char === "\n" || char === "\r") && parentheses === 0;
    const isComma = char === "," && parentheses === 0;
    if (isRowBreak || isComma) {
      finishField();
      if (char === "\r" && next === "\n") index++;
      endedWithRowBreak = isRowBreak;
      continue;
    }

    endedWithRowBreak = false;
    if (state === "after-quote") {
      if (char.trim()) throw new Error(`Unexpected character after quoted CSV color ${fields.length + 1}.`);
      continue;
    }

    if (state === "start") {
      if (char === '"') {
        field = "";
        state = "quoted";
        continue;
      }
      if (!char.trim()) {
        field += char;
        continue;
      }
      state = "unquoted";
    }

    if (char === '"') throw new Error(`Unexpected quote in CSV color ${fields.length + 1}.`);
    if (char === "(") parentheses++;
    if (char === ")") {
      if (parentheses === 0) throw new Error(`Unmatched parenthesis in CSV color ${fields.length + 1}.`);
      parentheses--;
    }
    field += char;
  }

  if (state === "quoted") throw new Error(`Unclosed quoted CSV color ${fields.length + 1}.`);
  if (inComment) throw new Error(`Unclosed CSS comment in CSV color ${fields.length + 1}.`);
  if (cssQuote) throw new Error(`Unclosed CSS string in CSV color ${fields.length + 1}.`);
  if (parentheses !== 0) throw new Error(`Unclosed parenthesis in CSV color ${fields.length + 1}.`);
  if (!endedWithRowBreak) finishField();
  return fields;
}

function parseJsonColorList(input: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Invalid JSON palette: expected an array of color strings.");
  }

  if (!Array.isArray(parsed)) throw new Error("JSON palette must be an array of color strings.");
  const items: unknown[] = parsed;
  return items.map((item, index) => {
    if (typeof item !== "string") throw new Error(`JSON color ${index + 1} must be a string.`);
    const value = item.trim();
    if (!value) throw new Error(`JSON color ${index + 1} is empty.`);
    return value;
  });
}

/** Distinguish comments from quoted and escaped CSS text, including in JSON/quoted CSV. */
function hasUnclosedCssComment(value: string): boolean {
  let inComment = false;
  let quote = "";
  for (let index = 0; index < value.length; index++) {
    const char = value.charAt(index);
    const next = value.charAt(index + 1);
    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        index++;
      }
    } else if (char === "\\") {
      index++;
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "/" && next === "*") {
      inComment = true;
      index++;
    }
  }
  return inComment;
}

/** Parse and validate a complete palette list without changing any settings. */
export function parsePaletteColorList(
  input: string,
  format: PaletteListFormat,
  isValidColor: (color: string) => boolean,
): string[] {
  let colors: string[];
  if (format === "csv") {
    colors = parseCsvColorList(input);
  } else if (format === "json") {
    colors = parseJsonColorList(input);
  } else {
    throw new Error("Unsupported palette format.");
  }

  if (colors.length === 0) throw new Error("Palette must contain at least one color.");
  for (const [index, color] of colors.entries()) {
    if (hasUnclosedCssComment(color)) throw new Error(`Unclosed CSS comment in color ${index + 1}.`);
    if (!isValidColor(color)) throw new Error(`Invalid color at position ${index + 1}: ${color}`);
  }
  return colors;
}

import type { DefaultThemeStyleTunerProfile, HslColor } from "./types";

const BLOCKED_CSS_PATTERNS = /url\s*\(|expression\s*\(|@import|behavior\s*:|\\00/i;

interface CssPart {
  text: string;
  isComment: boolean;
}

/** Split raw CSS comments without treating comment markers inside strings as comments. */
function splitCssComments(value: string): CssPart[] {
  const parts: CssPart[] = [];
  let start = 0;
  let quote = "";

  for (let index = 0; index < value.length; index++) {
    const char = value.charAt(index);
    if (char === "\\") {
      index++;
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "/" && value.charAt(index + 1) === "*") {
      if (index > start) parts.push({ text: value.slice(start, index), isComment: false });
      const closing = value.indexOf("*/", index + 2);
      if (closing === -1) {
        parts.push({ text: value.slice(index), isComment: true });
        return parts;
      }
      parts.push({ text: value.slice(index, closing + 2), isComment: true });
      index = closing + 1;
      start = index + 1;
    }
  }

  if (start < value.length) parts.push({ text: value.slice(start), isComment: false });
  return parts;
}

function normalizeCssValue(value: string): string {
  return splitCssComments(value).map((part) => part.isComment
    ? part.text
    : part.text.replace(/\s+/g, " ").replace(/[;{}]/g, "")
  ).join("");
}

export function sanitizeCssValue(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  const normalized = normalizeCssValue(trimmed);
  // Keep the previous blocked-pattern check as well: stripping punctuation from
  // a comment must not become a way to bypass an existing rejection.
  const legacyNormalized = trimmed.replace(/\s+/g, " ").replace(/[;{}]/g, "");
  // Removing punctuation can change how escapes and comments are tokenized.
  // Reject any result that would change when sanitized again.
  if (normalizeCssValue(normalized.trim()) !== normalized ||
      BLOCKED_CSS_PATTERNS.test(normalized) || BLOCKED_CSS_PATTERNS.test(legacyNormalized)) {
    return "";
  }

  return normalized;
}

/** Reject CSS constructs that could consume the declarations following a value. */
export function hasClosedCssTokens(value: string): boolean {
  const closing: string[] = [];
  let quote = "";
  let inComment = false;

  for (let index = 0; index < value.length; index++) {
    const char = value.charAt(index);
    const next = value.charAt(index + 1);

    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        index++;
      }
    } else if (char === "\\") {
      if (index + 1 >= value.length) return false;
      // CSS permits a backslash followed by CRLF as one escaped line break.
      index += next === "\r" && value.charAt(index + 2) === "\n" ? 2 : 1;
    } else if (quote) {
      if (char === quote) quote = "";
      else if (char === "\n" || char === "\r" || char === "\f") return false;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "/" && next === "*") {
      inComment = true;
      index++;
    } else if (char === "(" || char === "[") {
      closing.push(char === "(" ? ")" : "]");
    } else if (char === ")" || char === "]") {
      if (closing.pop() !== char) return false;
    }
  }

  return !inComment && !quote && closing.length === 0;
}

/** Validate a CSS color without altering its representation or permitting CSS injection. */
export function isValidCssColor(value: string): boolean {
  const color = value.trim();
  const unsafePunctuation = splitCssComments(color).some((part) => !part.isComment && /[;{}]/.test(part.text));
  if (!color || unsafePunctuation || !sanitizeCssValue(color) || !hasClosedCssTokens(color)) return false;
  // Hex colors are valid on every supported renderer, and can be checked without
  // a DOM (for example, while validating settings in the regression harness).
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return true;
  return typeof CSS !== "undefined" && CSS.supports("color", color);
}

export function cloneProfile(
  profile: DefaultThemeStyleTunerProfile
): DefaultThemeStyleTunerProfile {
  return { ...profile };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatNumber(value: number, maxDecimals = 3): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  return value
    .toFixed(maxDecimals)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
}

export function parseNumericValue(value: string): number | null {
  const numericValue = Number.parseFloat(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function rgbToHsl(r: number, g: number, b: number): HslColor {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  let saturation = 0;
  const lightness = (max + min) / 2;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));

    switch (max) {
      case red:
        hue = 60 * ((((green - blue) / delta) % 6 + 6) % 6);
        break;
      case green:
        hue = 60 * ((blue - red) / delta + 2);
        break;
      default:
        hue = 60 * ((red - green) / delta + 4);
        break;
    }
  }

  if (hue < 0) {
    hue += 360;
  }

  return {
    h: hue,
    s: saturation * 100,
    l: lightness * 100,
  };
}

/** Matching rules for Find & Replace in the grid. Pure: the grid decides which cells to feed in. */
export interface FindOptions { caseSensitive: boolean; wholeCell: boolean; regex: boolean }

export interface Matcher {
  /** Set when the pattern is not a valid regular expression. */
  error?: string;
  test(text: string): boolean;
  /** `text` with every match replaced (whole-cell mode replaces the entire value). `$1`, `$&` work in regex mode. */
  replace(text: string, replacement: string): string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function makeMatcher(query: string, o: FindOptions): Matcher {
  const none: Matcher = { test: () => false, replace: (t) => t };
  if (!query) return none;
  let re: RegExp;
  try {
    const src = o.regex ? query : escapeRe(query);
    re = new RegExp(o.wholeCell ? `^(?:${src})$` : src, (o.caseSensitive ? "" : "i") + "gsu");
  } catch (e) {
    return { ...none, error: String((e as Error).message).replace(/^Invalid regular expression: /, "") };
  }
  return {
    test(text) { re.lastIndex = 0; return re.test(text); },
    replace(text, replacement) {
      re.lastIndex = 0;
      // Literal mode must not treat `$` in the replacement specially.
      return o.regex ? text.replace(re, replacement) : text.replace(re, () => replacement);
    },
  };
}

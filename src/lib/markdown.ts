import { marked } from "marked";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function htmlToPlainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).trim();
}

/** Truncate on a word boundary, adding an ellipsis. */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

export interface RenderedMarkdown {
  /** HTML for `set:html` (content comes from the trusted CMS author). */
  html: string;
  /** Plain-text excerpt, entity-decoded — safe to pass to attributes like `<meta content>`. */
  excerpt: string;
}

/** Parse Markdown once and derive both HTML and a plain-text excerpt. */
export function renderMarkdown(markdown: string | undefined, excerptLength = 160): RenderedMarkdown {
  if (!markdown) return { html: "", excerpt: "" };
  const html = marked.parse(markdown, { async: false });
  return { html, excerpt: truncate(htmlToPlainText(html), excerptLength) };
}

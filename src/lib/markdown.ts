import { marked } from "marked";

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false }) as string;
}

/** Plain text for meta tags, cards, etc. */
export function markdownToPlainText(markdown: string, maxLength = 0): string {
  const html = renderMarkdown(markdown);
  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (maxLength > 0 && text.length > maxLength) {
    return `${text.slice(0, maxLength - 1)}…`;
  }
  return text;
}

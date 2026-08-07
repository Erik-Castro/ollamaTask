// HTML parsing utilities shared across tools. Pure functions, no network.

export const stripTags = (html: string): string => html.replace(/<[^>]*>/g, "");

export const unescapeHtml = (text: string): string =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

export const cleanText = (html: string): string =>
  unescapeHtml(stripTags(html)).trim();

/** Removes non-visible blocks, strips tags and collapses whitespace. */
export const extractText = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const extractTitle = (html: string): string => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(match[1]) : "";
};

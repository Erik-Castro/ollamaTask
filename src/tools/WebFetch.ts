import { extractText, extractTitle, unescapeHtml } from "./html.ts";
import { fetchPage } from "./net.ts";

export interface WebFetchResult {
  url: string;
  title: string;
  text: string;
}

const DEFAULT_MAX_CHARS = 8000;

/**
 * Baixa o conteúdo de `url` sob demanda e retorna os dados relevantes de
 * forma estruturada: { url, title, text }. O texto visível é limpo
 * (sem scripts/styles) e truncado para `maxChars`.
 */
export const WebFetch = async (
  url: string,
  options: { maxChars?: number } = {},
): Promise<WebFetchResult> => {
  const html = await fetchPage(url);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  return {
    url,
    title: extractTitle(html),
    text: unescapeHtml(extractText(html)).slice(0, maxChars),
  };
};

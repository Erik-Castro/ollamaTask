import { cleanText } from "./html.ts";
import { fetchPage } from "./net.ts";

export interface SearchResult {
  title: string;
  snippet: string;
  link: string;
}

export interface ZeroClick {
  title: string;
  abstract: string;
}

export interface SearchPage {
  query?: ZeroClick;
  results: SearchResult[];
}

const decodeLink = (raw: string): string => {
  try {
    const params = new URL(
      raw.startsWith("//") ? "https:" + raw : raw,
    ).searchParams;
    const uddg = params.get("uddg");
    return uddg ? decodeURIComponent(uddg) : raw;
  } catch {
    return raw;
  }
};

const parseResult = (block: string): Partial<SearchResult> => {
  const titleMatch = block.match(
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
  );
  const snippet = block.match(
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i,
  );

  return {
    title: titleMatch ? cleanText(titleMatch[2]) : "",
    snippet: snippet ? cleanText(snippet[1]) : "",
    link: titleMatch ? decodeLink(titleMatch[1]) : "",
  };
};

const parseResults = (html: string): SearchResult[] => {
  const results: SearchResult[] = [];
  for (const block of html.split(/<div class="result\b/gi).slice(1)) {
    const parsed = parseResult(block) as SearchResult;
    if (parsed.title) results.push(parsed);
  }
  return results;
};

/** Extrai o instant-answer (zero click) do DuckDuckGo, se presente. */
const parseZeroClick = (html: string): ZeroClick | undefined => {
  const heading = html.match(
    /<h1[^>]*class="zci__heading"[^>]*>([\s\S]*?)<\/h1>/i,
  );
  const abstract = html.match(
    /<div[^>]*id="zero_click_abstract"[^>]*>([\s\S]*?)<\/div>/i,
  );
  if (!heading) return undefined;

  return {
    title: cleanText(heading[1]),
    abstract: abstract ? cleanText(abstract[1]) : "",
  };
};

/**
 * Busca na internet usando o DuckDuckGo (endpoint HTML) e retorna de
 * forma estruturada: Array<{ query?, results }>. `query` carrega o
 * instant-answer (título + abstract) quando estiver presente.
 */
export const WebSearch = async (query: string): Promise<SearchPage[]> => {
  const url = `https://html.duckduckgo.com/html/?q=${
    encodeURIComponent(query)
  }`;
  const html = await fetchPage(url);

  const results = parseResults(html);
  const zeroClick = parseZeroClick(html);

  return [{ results, ...(zeroClick ? { query: zeroClick } : {}) }];
};

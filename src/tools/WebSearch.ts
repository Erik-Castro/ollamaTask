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
  nextOffset?: number;
}

export interface WebSearchOptions {
  /** Page offset (0 = first page, 10 = second, 20 = third, …). */
  offset?: number;
  /** Region code, e.g. "br-pt", "us-en". */
  region?: string;
  /** Time range filter: "d" (day), "w" (week), "m" (month), "y" (year). */
  timeRange?: "d" | "w" | "m" | "y";
}

const DDG_URL = "https://html.duckduckgo.com/html/";

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
 * Extracts the offset for the next page from a DDG HTML response.
 * Returns the next offset value, or undefined if there is no next page.
 */
const parseNextOffset = (html: string): number | undefined => {
  // Look for the hidden input with name="s" in the nav-link form.
  const match = html.match(
    /<div\s+class="nav-link">[\s\S]*?<input[^>]*name="s"[^>]*value="(\d+)"/i,
  );
  return match ? parseInt(match[1], 10) : undefined;
};

/**
 * Searches the web via DuckDuckGo (HTML endpoint) and returns structured
 * results. Supports pagination via `offset` and optional region/time filters.
 */
export const WebSearch = async (
  query: string,
  options: WebSearchOptions = {},
): Promise<SearchPage> => {
  const { offset = 0, region, timeRange } = options;

  const params = new URLSearchParams({ q: query });
  if (offset > 0) params.set("s", String(offset));
  if (region) params.set("kl", region);
  if (timeRange) params.set("df", timeRange);

  const url = `${DDG_URL}?${params}`;
  const html = await fetchPage(url);

  const results = parseResults(html);
  const zeroClick = parseZeroClick(html);
  const nextOffset = parseNextOffset(html);

  return {
    results,
    ...(zeroClick ? { query: zeroClick } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
};

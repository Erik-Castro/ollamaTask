// Network helpers shared across tools. Browser-like headers to avoid
// being blocked by strict sites.

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR",
  "Referer": "https://html.duckduckgo.com/",
  "Content-Type": "application/x-www-form-urlencoded",
  "Origin": "https://html.duckduckgo.com",
  "DNT": "1",
  "Sec-GPC": "1",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Priority": "u=0, i",
  "TE": "trailers"
} as const ;

/** Fetches `url` and returns the response body as text. Throws on HTTP error. */
export const fetchPage = async (url: string): Promise<string> => {
  const response = await fetch(url, { headers: BROWSER_HEADERS });
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} ao acessar ${url}`,
    );
  }
  return await response.text();
};

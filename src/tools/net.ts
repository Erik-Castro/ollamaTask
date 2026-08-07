// Network helpers shared across tools. Browser-like headers to avoid
// being blocked by strict sites.

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "DNT": "1",
  "Sec-GPC": "1",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Priority": "u=0, i",
  "Pragma": "no-cache",
  "Cache-Control": "no-cache",
} as const;

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

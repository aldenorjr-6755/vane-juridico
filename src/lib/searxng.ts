import { getSearxngURL } from './config/serverRegistry';

export interface SearxngSearchOptions {
  categories?: string[];
  engines?: string[];
  language?: string;
  pageno?: number;
  /**
   * Recency filter. Supported by `google_cse` (which declares
   * `time_range_support = True`) among others; engines that do not support it
   * simply ignore the parameter.
   */
  time_range?: 'day' | 'week' | 'month' | 'year';
}

interface SearxngSearchResult {
  title: string;
  url: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  content?: string;
  author?: string;
  iframe_src?: string;
  publishedDate?: string;
  engine?: string;
  engines?: string[];
}

export interface SearxngSearchResponse {
  results: SearxngSearchResult[];
  suggestions: string[];
  /**
   * Engines that did not answer this query, as `[engine, reason]` pairs, e.g.
   * `['google cse', 'Suspended: too many requests']`.
   *
   * SearXNG reports this and Vane used to throw it away, which made "engine is
   * suspended" and "there are no results" arrive at the user as the exact same
   * empty answer - the same silent-failure class as the non-existent `reddit`
   * engine that used to back the discussion search.
   */
  unresponsiveEngines: [string, string][];
}

export const searchSearxng = async (
  query: string,
  opts?: SearxngSearchOptions,
): Promise<SearxngSearchResponse> => {
  const searxngURL = getSearxngURL();

  const url = new URL(`${searxngURL}/search?format=json`);
  url.searchParams.append('q', query);

  if (opts) {
    Object.keys(opts).forEach((key) => {
      const value = opts[key as keyof SearxngSearchOptions];
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) {
        url.searchParams.append(key, value.join(','));
        return;
      }
      url.searchParams.append(key, value as string);
    });
  }

  const controller = new AbortController();
  /* A `site:`-restricted query on google cse is noticeably slower than a plain
     web search, and the legal engines run a cheap pre-flight probe before the
     real query; 10s used to cut them off. */
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`SearXNG error: ${res.statusText}`);
    }

    const data = await res.json();

    const results: SearxngSearchResult[] = data.results ?? [];
    const suggestions: string[] = data.suggestions ?? [];
    const unresponsiveEngines: [string, string][] =
      data.unresponsive_engines ?? [];

    return { results, suggestions, unresponsiveEngines };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('SearXNG search timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

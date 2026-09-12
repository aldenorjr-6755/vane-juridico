import Scraper from '@/lib/scraper';

/**
 * Exposes the researcher's own scraper over HTTP, so an MCP client (the
 * `vane-mcp` bridge) can read a page through the same adapters the search
 * agent uses: WordPress API for Conjur/STF news, PDF parsing for STJ
 * acordaos, cp1252 decoding for Planalto, host throttling + 24h cache for
 * court sites, and a real browser for everything else. A challenge page is
 * reported as `blocked: true` instead of being passed off as content.
 *
 * POST { urls: string[] | url: string, maxChars?: number }
 * GET  ?url=...&maxChars=...
 */

const MAX_URLS = 5;
const DEFAULT_MAX_CHARS = 20000;
const HARD_MAX_CHARS = 200000;

type ScrapeItem = {
  url: string;
  ok: boolean;
  blocked: boolean;
  title: string;
  content: string;
  chars: number;
  truncated: boolean;
  links?: { href: string; text: string }[];
  error?: string;
};

const isHttpUrl = (u: string) => {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const clampChars = (raw: unknown): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(Math.floor(n), HARD_MAX_CHARS);
};

const scrapeOne = async (
  url: string,
  maxChars: number,
): Promise<ScrapeItem> => {
  if (!isHttpUrl(url)) {
    return {
      url,
      ok: false,
      blocked: false,
      title: '',
      content: '',
      chars: 0,
      truncated: false,
      error: 'URL invalida: so http(s) e aceito',
    };
  }

  try {
    const result = await Scraper.scrape(url);
    /* Readability's textContent keeps the source's indentation: the RBCCRIM
       archive came back with 16k chars of which most were blank lines. */
    const content = result.content
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const blocked = content.includes('FONTE BLOQUEADA');
    const failed = result.title === 'Failed to scrape';

    return {
      url,
      ok: !blocked && !failed,
      blocked,
      title: result.title,
      content: content.slice(0, maxChars),
      chars: content.length,
      truncated: content.length > maxChars,
      ...(result.links ? { links: result.links } : {}),
      ...(failed
        ? {
            error:
              'o scraper nao conseguiu ler a pagina (ver log do container)',
          }
        : {}),
    };
  } catch (err) {
    return {
      url,
      ok: false,
      blocked: false,
      title: '',
      content: '',
      chars: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const run = async (urls: string[], maxChars: number) => {
  const unique = Array.from(
    new Set(urls.map((u) => String(u).trim()).filter(Boolean)),
  );

  if (unique.length === 0) {
    return Response.json({ message: 'URL(s) ausente(s)' }, { status: 400 });
  }

  const selected = unique.slice(0, MAX_URLS);
  const results = await Promise.all(
    selected.map((u) => scrapeOne(u, maxChars)),
  );

  return Response.json({
    results,
    ...(unique.length > MAX_URLS
      ? {
          warning: `so as ${MAX_URLS} primeiras URLs foram lidas (${unique.length} recebidas)`,
        }
      : {}),
  });
};

export const POST = async (req: Request) => {
  try {
    const body = await req.json();
    const urls: string[] = Array.isArray(body?.urls)
      ? body.urls
      : body?.url
        ? [body.url]
        : [];

    return await run(urls, clampChars(body?.maxChars));
  } catch (err) {
    console.error('Error in scrape route:', err);
    return Response.json({ message: 'Ocorreu um erro.' }, { status: 500 });
  }
};

export const GET = async (req: Request) => {
  try {
    const { searchParams } = new URL(req.url);
    const urls = searchParams.getAll('url');

    return await run(urls, clampChars(searchParams.get('maxChars')));
  } catch (err) {
    console.error('Error in scrape route:', err);
    return Response.json({ message: 'Ocorreu um erro.' }, { status: 500 });
  }
};

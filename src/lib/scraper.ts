import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Mutex } from 'async-mutex';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { PDFParse } from 'pdf-parse';
import { CanvasFactory } from 'pdf-parse/worker';
import { hostOf } from './legal/sources';

export type ScrapeLink = { href: string; text: string };

/**
 * `links` only comes from the browser adapter: the API adapters (WordPress,
 * BNP, PDF) hand back a single record with nothing to navigate to. It exists
 * for the `/api/scrape` route, where a caller collecting a journal archive
 * needs the issue and article URLs, not just the page text.
 */
export type ScrapeResult = { content: string; title: string; links?: ScrapeLink[] };

const MAX_LINKS = 400;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

/**
 * Hosts that get their own throttle and disk cache. These are legal sources
 * where repeated identical lookups are common and where hammering a court
 * server would be both rude and counter-productive.
 */
const THROTTLED_HOSTS = [
  'stj.jus.br',
  'stf.jus.br',
  'planalto.gov.br',
  'conjur.com.br',
  'migalhas.com.br',
  'dizerodireito.com.br',
  'jusbrasil.com.br',
  'pangeabnp.pdpj.jus.br',
  'jurisprudencia.cjf.jus.br',
];

const HOST_MIN_INTERVAL_MS = 3000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A page that answers with one of these is a challenge, not content. Vane never
 * tries to solve it: it reports the block so the writer states the gap instead
 * of filling it from memory.
 *
 * Only the TITLE is trusted. Matching the body was measured to be wrong: every
 * Cloudflare-fronted page carries the `challenge-platform` script, including
 * the ones served normally, so a JusBrasil article with 47k chars of real text
 * looked identical to a block. Against the four pages measured on 2026-09-08
 * (SCON, JusBrasil home, JusBrasil article, Dizer o Direito) the title check
 * alone separates them 4/4.
 */
const CHALLENGE_TITLE =
  /just a moment|checking your browser|verifica(ç|c)(ã|a)o de seguran(ç|c)a|attention required|access denied/i;

/** A challenge page is also tiny: the two measured had 254 and 491 chars of text. */
const THIN_BODY_CHARS = 600;

const matchesHost = (host: string, allowed: string) =>
  host === allowed || host.endsWith(`.${allowed}`);

const isThrottled = (host: string) =>
  THROTTLED_HOSTS.some((h) => matchesHost(host, h));

const stripHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const lastPathSegment = (url: string): string => {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? '';
  } catch {
    return '';
  }
};

const fetchWithUA = (url: string, accept?: string) =>
  fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      ...(accept ? { Accept: accept } : {}),
    },
    signal: AbortSignal.timeout(25000),
  });

class Scraper {
  private static browser: any | undefined;
  private static IDLE_KILL_TIMEOUT = 30000;
  private static NAVIGATION_TIMEOUT = 20000;
  private static idleTimeout: NodeJS.Timeout | undefined;
  private static browserMutex = new Mutex();
  private static userCount = 0;

  private static hostQueues: Map<string, Promise<void>> = new Map();
  private static lastRequestAt: Map<string, number> = new Map();
  private static cacheDir = path.join(
    process.env.DATA_DIR || process.cwd(),
    'data',
    'scrape-cache',
  );

  private static async initBrowser() {
    await this.browserMutex.runExclusive(async () => {
      if (!this.browser) {
        const { chromium } = await import('playwright');
        this.browser = await chromium.launch({
          headless: true,
          channel: 'chromium-headless-shell',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
          ],
        });
      }

      if (this.idleTimeout) clearTimeout(this.idleTimeout);
    });
  }

  private static scheduleIdleKill() {
    if (this.idleTimeout) clearTimeout(this.idleTimeout);

    this.idleTimeout = setTimeout(async () => {
      await this.browserMutex.runExclusive(async () => {
        if (this.browser && this.userCount === 0) {
          {
            await this.browser.close();
            this.browser = undefined;
          }
        }
      });
    }, this.IDLE_KILL_TIMEOUT);
  }

  /**
   * Serialises requests per host, keeping at least HOST_MIN_INTERVAL_MS between
   * consecutive ones. An idle host is hit immediately - the gap is measured
   * from the last request, not slept before every one.
   */
  private static throttle<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = this.hostQueues.get(host) ?? Promise.resolve();

    const run = previous.then(async () => {
      const elapsed = Date.now() - (this.lastRequestAt.get(host) ?? 0);
      const wait = HOST_MIN_INTERVAL_MS - elapsed;

      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      this.lastRequestAt.set(host, Date.now());
    });

    const result = run.then(task);

    this.hostQueues.set(
      host,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );

    return result;
  }

  private static cachePath(url: string): string {
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    return path.join(this.cacheDir, `${hash}.json`);
  }

  private static readCache(url: string): ScrapeResult | undefined {
    try {
      const file = this.cachePath(url);
      if (!fs.existsSync(file)) return undefined;

      const cached = JSON.parse(fs.readFileSync(file, 'utf-8'));

      if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return undefined;

      return {
        content: cached.content,
        title: cached.title,
        ...(cached.links ? { links: cached.links } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private static writeCache(url: string, result: ScrapeResult) {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }

      fs.writeFileSync(
        this.cachePath(url),
        JSON.stringify({ ...result, url, fetchedAt: Date.now() }),
      );
    } catch (err) {
      console.log('Failed to cache scrape of', url, err);
    }
  }

  private static blocked(url: string, reason: string): ScrapeResult {
    return {
      title: `Bloqueado: ${url}`,
      content: `# ${url}\n\nFONTE BLOQUEADA - ${reason}. O conteúdo desta página NÃO foi lido. Não presuma o que ela diz; declare a lacuna na resposta.`,
    };
  }

  /** Reads a PDF straight from the network - the STJ serves full acordaos this way. */
  private static async scrapePdf(url: string): Promise<ScrapeResult> {
    const res = await fetchWithUA(url, 'application/pdf');

    if (!res.ok) {
      return this.blocked(url, `o servidor respondeu HTTP ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buffer, CanvasFactory });
    const text = await parser.getText().then((r) => r.text);

    const title = text.split('\n').find((l) => l.trim().length > 0) ?? url;

    return { title: title.trim().slice(0, 120), content: `# ${url}\n\n${text}` };
  }

  /**
   * WordPress REST lookup by slug. Conjur and the STF news site both run
   * WordPress, and the API returns clean article text without a browser.
   * `noticias.stf.jus.br` answers 202 with an empty body once its WAF flags the
   * client - that is a failure, never an empty article.
   */
  private static async scrapeWordPress(
    url: string,
    apiBase: string,
  ): Promise<ScrapeResult | undefined> {
    const slug = lastPathSegment(url);
    if (!slug) return undefined;

    const res = await fetchWithUA(
      `${apiBase}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=title,content,link,date`,
      'application/json',
    );

    if (res.status === 202 || !res.ok) return undefined;

    const posts = await res.json().catch(() => undefined);
    if (!Array.isArray(posts) || posts.length === 0) return undefined;

    const post = posts[0];
    const title = stripHtml(post?.title?.rendered ?? '');
    let content = stripHtml(post?.content?.rendered ?? '');

    if (!content) return undefined;

    /* `div.conjur-social-share` lives inside the article widget itself, so the
       share links land at the end of the extracted body. */
    content = content.split('Compartilhar:')[0].trim();

    return {
      title: title || url,
      content: `# ${title} - ${url}\n${post?.date ? `(publicado em ${post.date})\n` : ''}\n${content}`,
    };
  }

  /**
   * The BNP has no page to read: it is an Angular app that renders results from
   * a POST, so fetching the URL returns an empty shell. The search result URL
   * carries the precedent id in its fragment (`#stj-sum-314`), which decomposes
   * into orgao / tipo / numero - enough to ask the official API for that exact
   * record instead of scraping nothing.
   */
  private static async scrapeBnp(url: string): Promise<ScrapeResult | undefined> {
    const id = (url.split('#')[1] ?? '').trim();
    const parts = id.split('-');

    if (parts.length < 3) return undefined;

    const numero = parts[parts.length - 1];
    const tipo = parts[parts.length - 2].toUpperCase();
    const orgao = parts.slice(0, -2).join('-').toUpperCase();

    const res = await fetch('https://pangeabnp.pdpj.jus.br/api/v1/precedentes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
      },
      body: JSON.stringify({
        filtro: {
          buscaGeral: '',
          todasPalavras: '',
          quaisquerPalavras: '',
          semPalavras: '',
          trechoExato: '',
          atualizacaoDesde: '',
          atualizacaoAte: '',
          cancelados: false,
          ordenacao: 'Text',
          nr: numero,
          pagina: 1,
          tamanhoPagina: 20,
          orgaos: [orgao],
          tipos: [tipo],
        },
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) return undefined;

    const data = await res.json().catch(() => undefined);
    const hit = (data?.resultados ?? []).find((r: any) => r?.id === id);

    if (!hit) return undefined;

    const title = [hit.orgao, `${hit.tipo} ${hit.nr}`, hit.situacao]
      .filter(Boolean)
      .join(' · ');

    return {
      title: `${title} — Banco Nacional de Precedentes (CNJ)`,
      content: [
        `# ${title}`,
        `Situação: ${hit.situacao ?? 'não informada'}`,
        `Última atualização: ${hit.ultimaAtualizacao ?? 'não informada'}`,
        '',
        stripHtml(hit.tese ?? ''),
        hit.historico ? `\nHistórico: ${stripHtml(hit.historico)}` : '',
      ].join('\n'),
    };
  }

  /**
   * Planalto serves cp1252 with no charset header and no meta tag, so decoding
   * it as utf-8 silently mangles every accent. It also breaks article numbers
   * across lines (`Art.\n397.`), which has to be re-joined before the text is
   * usable as law.
   */
  private static async scrapePlanalto(url: string): Promise<ScrapeResult> {
    const res = await fetchWithUA(url);

    if (!res.ok) {
      return this.blocked(url, `o servidor respondeu HTTP ${res.status}`);
    }

    const buffer = await res.arrayBuffer();
    const html = new TextDecoder('latin1').decode(buffer);

    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    const content = stripHtml(html)
      .replace(/\bArt\.\s*\n\s*(\d)/g, 'Art. $1')
      .replace(/\b(Art\.\s*\d+)\s*\n\s*([º°o])/g, '$1$2');

    return {
      title: titleMatch?.[1]?.trim() || url,
      content: `# ${titleMatch?.[1]?.trim() ?? url} - ${url}\n${content}`,
    };
  }

  private static async scrapeWithBrowser(url: string): Promise<ScrapeResult> {
    await this.initBrowser();

    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext({
      userAgent: BROWSER_UA,
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    this.userCount++;

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.NAVIGATION_TIMEOUT,
      });

      await page
        .waitForLoadState('load', { timeout: 5000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);

      const html = await page.content();
      const title = await page.title();

      const links: ScrapeLink[] = await page
        .evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map((a) => ({
            href: (a as HTMLAnchorElement).href,
            text: ((a as HTMLElement).innerText || a.textContent || '')
              .replace(/\s+/g, ' ')
              .trim(),
          })),
        )
        .then((all: ScrapeLink[]) => {
          /* An OJS archive lists each issue twice: a cover image (no text) and
             a titled link. Keyed by href, the first non-empty text wins, so the
             caller sees the issue title instead of an empty string. */
          const byHref = new Map<string, string>();
          for (const l of all) {
            if (!/^https?:/i.test(l.href)) continue;
            const current = byHref.get(l.href);
            if (current === undefined) {
              if (byHref.size >= MAX_LINKS) continue;
              byHref.set(l.href, l.text.slice(0, 200));
            } else if (!current && l.text) {
              byHref.set(l.href, l.text.slice(0, 200));
            }
          }
          return Array.from(byHref, ([href, text]) => ({ href, text }));
        })
        .catch(() => []);

      const dom = new JSDOM(html, {
        url,
      });

      const parsed = new Readability(dom.window.document).parse();

      /* Single-page apps (the STF case law search among them) render their
         results outside anything Readability recognises as an article. */
      const readableText = parsed?.textContent?.trim();
      const bodyText: string = await page
        .evaluate(() => document.body.innerText)
        .catch(() => '');
      const content =
        readableText && readableText.length > 200 ? readableText : bodyText;

      if (
        CHALLENGE_TITLE.test(title) ||
        ((content ?? '').trim().length < THIN_BODY_CHARS &&
          (response?.status() ?? 200) >= 400)
      ) {
        return this.blocked(
          url,
          'a página devolveu um desafio anti-bot em vez do conteúdo',
        );
      }

      return {
        content: `
        # ${title ?? 'No title'} - ${url}
        ${content ?? 'No content available'}
        `,
        title,
        links,
      };
    } catch (err) {
      console.log(`Error scraping ${url}:`, err);

      return {
        title: 'Failed to scrape',
        content: `# ${url}\n\nError scraping content.`,
      };
    } finally {
      this.userCount--;

      await context.close().catch(() => undefined);

      if (this.userCount === 0) {
        this.scheduleIdleKill();
      }
    }
  }

  /** Picks the cheapest adapter that is known to work for this host. */
  private static async dispatch(url: string): Promise<ScrapeResult> {
    const host = hostOf(url);

    if (matchesHost(host, 'scon.stj.jus.br')) {
      return this.blocked(
        url,
        'o scon.stj.jus.br responde 403 com interstitial do Cloudflare, inclusive a um navegador real. Consulte manualmente',
      );
    }

    if (url.toLowerCase().endsWith('.pdf') || url.includes('REJ.cgi')) {
      try {
        return await this.scrapePdf(url);
      } catch (err) {
        console.log('PDF scrape failed, falling back to browser', url, err);
      }
    }

    if (matchesHost(host, 'conjur.com.br')) {
      const viaApi = await this.scrapeWordPress(
        url,
        'https://www.conjur.com.br',
      ).catch(() => undefined);
      if (viaApi) return viaApi;
    }

    if (matchesHost(host, 'noticias.stf.jus.br')) {
      const viaApi = await this.scrapeWordPress(
        url,
        'https://noticias.stf.jus.br',
      ).catch(() => undefined);
      if (viaApi) return viaApi;
    }

    if (matchesHost(host, 'pangeabnp.pdpj.jus.br')) {
      const record = await this.scrapeBnp(url).catch(() => undefined);
      if (record) return record;

      return this.blocked(
        url,
        'o BNP e um app client-side sem conteudo estatico e o registro nao foi encontrado pela API',
      );
    }

    if (matchesHost(host, 'planalto.gov.br')) {
      try {
        return await this.scrapePlanalto(url);
      } catch (err) {
        console.log('Planalto fetch failed, falling back to browser', url, err);
      }
    }

    return this.scrapeWithBrowser(url);
  }

  static async scrape(url: string): Promise<ScrapeResult> {
    const host = hostOf(url);

    if (!isThrottled(host)) {
      return this.dispatch(url);
    }

    const cached = this.readCache(url);
    if (cached) return cached;

    const result = await this.throttle(host, () => this.dispatch(url));

    /* A blocked page is not worth caching for a day - the block may lift. */
    if (!result.content.includes('FONTE BLOQUEADA')) {
      this.writeCache(url, result);
    }

    return result;
  }
}

export default Scraper;

/**
 * Registry of Brazilian legal sources for the `legal` search source.
 *
 * Every entry carries what was actually measured from this deployment on
 * 2026-09-08, because most of these hosts fail in ways that look like success:
 * a 202 with an empty body, a 200 carrying an anti-bot page, a `site:` operator
 * that the engine quietly ignored. Read the notes before changing `enabled`.
 */

export type LegalDiscovery =
  /** `site:<host>` on `google cse` - the archive path. */
  | 'cse'
  /** `site:<host>` on `bing news` - the recency path. */
  | 'news'
  /** A dedicated SearXNG engine that queries the site's own search. */
  | 'native'
  /** Reachable only when the model is handed a URL; never crawled. */
  | 'none';

export type LegalSourceKind =
  | 'doutrina'
  | 'noticia'
  | 'tribunal'
  | 'legislacao';

export type LegalSource = {
  key: string;
  label: string;
  /** Hosts that count as inside this source, for the post-filter. */
  hosts: string[];
  /** Host used in the `site:` operator. */
  siteQuery?: string;
  discovery: LegalDiscovery[];
  /** SearXNG engine name, when `discovery` includes `native`. */
  engine?: string;
  kind: LegalSourceKind;
  enabled: boolean;
  note?: string;
};

export const LEGAL_SOURCES: LegalSource[] = [
  {
    key: 'conjur',
    label: 'Consultor Jurídico',
    hosts: ['conjur.com.br'],
    siteQuery: 'conjur.com.br',
    /* `google cse` + `site:conjur.com.br` returned 20/20 on-domain. The native
       engine goes through the site's own WordPress API (tag lookup), which
       keeps Conjur off the shared CSE quota. Its `posts?search=` endpoint is a
       hard 500 - do not reach for it. */
    discovery: ['native', 'cse', 'news'],
    engine: 'conjur',
    kind: 'doutrina',
    enabled: true,
  },
  {
    key: 'migalhas',
    label: 'Migalhas',
    hosts: ['migalhas.com.br'],
    siteQuery: 'migalhas.com.br',
    /* The site's own /busca returns a structured JSON payload embedded in the
       page (URL, title, summary, date, category, total). robots.txt does not
       disallow /busca. `bing` web ignores `site:` here (1/10 on-domain), so
       only `google cse` and `bing news` are wired. */
    discovery: ['native', 'cse', 'news'],
    engine: 'migalhas',
    kind: 'doutrina',
    enabled: true,
  },
  {
    key: 'stj',
    label: 'STJ',
    hosts: ['stj.jus.br'],
    siteQuery: 'stj.jus.br',
    /* 20/20 on-domain, and the results include
       `websecstj/cgi/revista/REJ.cgi/ITA?seq=...` - the official full-text
       acordao, which answers 200 as application/pdf to a plain request. That
       is the STJ full-text path; scon is not (see below).
       No `news`: `bing news` has no index for this host and answers with a
       page its parser rejects ("parsing error"), not with zero results.
       The `stj repetitivos` engine queries the court's own precedent base by
       free text (`pesquisa_livre`), which is the only tribunal path that does
       not spend from the shared `google cse` quota. Its query has to be
       percent-encoded in latin-1: in UTF-8 the base answers 0 results with
       HTTP 200. */
    discovery: ['native', 'cse'],
    engine: 'stj repetitivos',
    kind: 'tribunal',
    enabled: true,
  },
  {
    key: 'bnp',
    label: 'BNP - Banco Nacional de Precedentes (CNJ)',
    hosts: ['pangeabnp.pdpj.jus.br', 'bnp.pdpj.jus.br'],
    /* Base oficial de precedentes qualificados de todos os tribunais
       (Resolucao CNJ 444/2022). O manual declara a ferramenta publica e a API
       de consulta responde sem autenticacao. E' a fonte que traz sumula,
       repetitivo, repercussao geral, IAC e IRDR com a tese e a **situacao** -
       exatamente o que separa o precedente que governa do julgado isolado.
       Sem `cse`: o app e' client-side e o Google nao indexa os precedentes.
       Sem deep link por precedente: quem identifica o item e' o titulo do
       resultado, nao a URL (ver a engine `bnp`). */
    discovery: ['native'],
    engine: 'bnp',
    kind: 'tribunal',
    enabled: true,
  },
  {
    key: 'stf-noticias',
    label: 'STF (notícias)',
    hosts: ['noticias.stf.jus.br', 'portal.stf.jus.br'],
    siteQuery: 'noticias.stf.jus.br',
    /* portal.stf.jus.br is not anti-bot: the server sends its leaf certificate
       twice and omits the GlobalSign intermediate, so no client can build the
       chain. With the intermediate installed it answers 200 / 76 KB.
       noticias.stf.jus.br exposes a WordPress REST API that serves real data
       for a handful of calls and then latches to 202 - treat 202 as failure.
       `bing news` does index this host: 10/10 on-domain. */
    discovery: ['cse', 'news'],
    kind: 'noticia',
    enabled: true,
  },
  {
    key: 'stf-jurisprudencia',
    label: 'STF (jurisprudência)',
    hosts: ['jurisprudencia.stf.jus.br'],
    /* The SPA answers 202 to plain requests but renders correctly in the
       bundled Chromium - a normal browser loading a normal page, no bot
       detection defeated. Not crawled: it is driven by URL when the researcher
       asks for STF case law. */
    discovery: ['none'],
    kind: 'tribunal',
    enabled: true,
  },
  {
    key: 'planalto',
    label: 'Planalto (legislação)',
    hosts: ['planalto.gov.br'],
    siteQuery: 'planalto.gov.br',
    /* 200 / 671 KB, but cp1252 with no charset header and no meta tag: decoded
       as utf-8 it silently produces "Homic�dio". The scraper decodes it as
       latin-1 and re-joins the `Art.\n397.` breaks. Legislation is not news:
       `bing news` answers `site:planalto.gov.br` with a parsing error. */
    discovery: ['cse'],
    kind: 'legislacao',
    enabled: true,
  },
  {
    key: 'dizerodireito',
    label: 'Dizer o Direito',
    hosts: ['dizerodireito.com.br'],
    siteQuery: 'dizerodireito.com.br',
    /* Blogger, com a API de feeds oficial aberta:
       `/feeds/posts/default?alt=json&q=<termo>` faz busca em texto completo e
       devolve JSON datado - inclusive os "INFORMATIVO Comentado", que sao o que
       esta fonte tem de mais util para jurisprudencia. O `robots.txt` proibe
       `/search` (a busca on-site) e libera o resto, entao a engine vai pelo
       feed, nunca por `/search?q=`.
       Sem `news`: `bing news` responde `site:dizerodireito.com.br` com parsing
       error, como faz com STJ e Planalto. A recencia vem do proprio feed, que
       ja' sai ordenado por data. */
    discovery: ['native', 'cse'],
    engine: 'dizerodireito',
    kind: 'doutrina',
    enabled: true,
  },
  {
    key: 'cjf',
    label: 'CJF - Jurisprudência Unificada da Justiça Federal',
    hosts: ['jurisprudencia.cjf.jus.br'],
    /* Portal oficial do Conselho da Justiça Federal: STJ, TNU, Turmas
       Recursais e os seis TRFs num só acervo, com ementa, relator, órgão
       julgador e o **número real do processo** - material anti-invenção.
       E' um app JSF com estado (ViewState + cookie de sessão), então a engine
       faz GET no formulário e depois POST; e só devolve documentos com UM
       tribunal selecionado - com vários, vêm apenas os totais. O padrão é STJ.
       Sem `cse`: o conteúdo só existe atrás do POST, o Google não indexa. */
    discovery: ['native'],
    engine: 'cjf',
    kind: 'tribunal',
    enabled: true,
  },
  {
    key: 'scon',
    label: 'STJ SCON (súmulas, inteiro teor)',
    hosts: ['scon.stj.jus.br'],
    siteQuery: 'scon.stj.jus.br',
    /* OFF. Cloudflare answers 403 with a "Just a moment..." interstitial even
       to the bundled Chromium - getting through means defeating bot detection,
       which this codebase does not do. `www.stj.jus.br/robots.txt` also
       disallows /SCON/ for every agent. STJ full text comes from the REJ.cgi
       PDFs under the `stj` entry instead. */
    discovery: ['none'],
    kind: 'tribunal',
    enabled: false,
  },
  {
    key: 'lexml',
    label: 'LexML',
    hosts: ['lexml.gov.br'],
    siteQuery: 'lexml.gov.br',
    /* OFF for search. The SRU endpoint answers 200 carrying the Senado's
       "Verificacao de seguranca" challenge page, not XML - the status code
       says nothing. Only the URN resolver `lexml.gov.br/urn/<urn>` resolves,
       and that is a lookup, not a search. */
    discovery: ['none'],
    kind: 'legislacao',
    enabled: false,
  },
  {
    key: 'jusbrasil',
    label: 'JusBrasil',
    hosts: ['jusbrasil.com.br'],
    siteQuery: 'jusbrasil.com.br',
    /* LIGADO a pedido explicito do usuario em 2026-09-08, com o fato registrado
       aqui: o `robots.txt` do JusBrasil e' `User-agent: * / Disallow: /` — ele
       pede que nenhum crawler entre, liberando so' bots de anuncio nomeados.
       Isso e' um pedido do site, nao uma barreira tecnica, e a decisao de
       atende-lo ou nao e' do usuario; fica escrita aqui em vez de escondida.
       Medido no mesmo dia: `curl` leva 403 do Cloudflare em tudo, mas o
       Chromium embutido abre o artigo normalmente (200, 47.697 chars de texto,
       sem interstitial) — navegador de verdade fazendo requisicao de verdade,
       sem impersonacao de TLS e sem resolver desafio. A home, essa, devolve 403
       "Just a moment..." e cai no caminho de bloqueio do scraper.
       Sem `news`: `bing news` responde com parsing error, como STJ e Planalto.
       Para desligar, basta `enabled: false`. */
    discovery: ['cse'],
    kind: 'doutrina',
    enabled: true,
  },
];

export const getEnabledLegalSources = (): LegalSource[] =>
  LEGAL_SOURCES.filter((s) => s.enabled);

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const matchesHost = (host: string, allowed: string) =>
  host === allowed || host.endsWith(`.${allowed}`);

/**
 * The source whose host best matches this URL, disabled ones included.
 *
 * Longest match wins, because the hosts nest: `scon.stj.jus.br` matches both
 * the `stj` entry (via the `.stj.jus.br` suffix) and its own `scon` entry, and
 * only the second one is right.
 */
export const findLegalSourceForUrl = (url: string): LegalSource | undefined => {
  const host = hostOf(url);
  if (!host) return undefined;

  let best: { source: LegalSource; length: number } | undefined;

  LEGAL_SOURCES.forEach((source) => {
    source.hosts.forEach((allowed) => {
      if (
        matchesHost(host, allowed) &&
        (!best || allowed.length > best.length)
      ) {
        best = { source, length: allowed.length };
      }
    });
  });

  return best?.source;
};

/**
 * True when the URL belongs to an enabled legal source. Applied to every raw
 * search result: `site:` is a request, not a guarantee - the `bing` web engine
 * ignores it entirely.
 *
 * Resolving to the most specific source matters here. `site:stj.jus.br` on
 * google cse returns `scon.stj.jus.br` URLs, and those matched the enabled
 * `stj` entry through its subdomain suffix - so seven pages that cannot be read
 * (403 Cloudflare) were passing the filter, spending fetches and coming back as
 * "FONTE BLOQUEADA" notices in the context. A disabled source stays out.
 */
export const isWhitelistedLegalUrl = (url: string): boolean =>
  findLegalSourceForUrl(url)?.enabled === true;

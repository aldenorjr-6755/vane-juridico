import { searchSearxng } from '@/lib/searxng';

const websitesForTopic = {
  juridico: {
    query: [
      'decisão STJ',
      'julgamento STF',
      'notícias jurídicas',
      'jurisprudência',
    ],
    /* Só hosts que o `bing news` de fato indexa. stj.jus.br, planalto.gov.br,
       dizerodireito.com.br e jusbrasil.com.br respondem com parsing error nessa
       engine - Dizer o Direito entra pelo feed do Blogger, logo abaixo. */
    links: ['conjur.com.br', 'migalhas.com.br', 'noticias.stf.jus.br'],
    language: 'pt-BR',
  },
  tech: {
    query: ['technology news', 'latest tech', 'AI', 'science and innovation'],
    links: ['techcrunch.com', 'wired.com', 'theverge.com'],
  },
  finance: {
    query: ['finance news', 'economy', 'stock market', 'investing'],
    links: ['bloomberg.com', 'cnbc.com', 'marketwatch.com'],
  },
  art: {
    query: ['art news', 'culture', 'modern art', 'cultural events'],
    links: ['artnews.com', 'hyperallergic.com', 'theartnewspaper.com'],
  },
  sports: {
    query: ['sports news', 'latest sports', 'cricket football tennis'],
    links: ['espn.com', 'bbc.com/sport', 'skysports.com'],
  },
  entertainment: {
    query: ['entertainment news', 'movies', 'TV shows', 'celebrities'],
    links: ['hollywoodreporter.com', 'variety.com', 'deadline.com'],
  },
};

type Topic = keyof typeof websitesForTopic;

/**
 * Dizer o Direito roda no Blogger, cuja API de feeds e' aberta e devolve JSON
 * datado. O `robots.txt` do site proibe `/search` e libera o resto, entao a
 * leitura vai por `/feeds/`, nunca pela busca on-site.
 */
const fetchDizerODireitoFeed = async () => {
  try {
    const res = await fetch(
      'https://www.dizerodireito.com.br/feeds/posts/default?alt=json&max-results=8',
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!res.ok) return [];

    const feed = (await res.json())?.feed ?? {};

    return ((feed.entry ?? []) as any[])
      .map((entry) => ({
        title: entry?.title?.$t ?? '',
        url:
          (entry?.link ?? []).find((l: any) => l?.rel === 'alternate')?.href ??
          '',
        content: String(entry?.summary?.$t ?? entry?.content?.$t ?? '')
          .replace(/<[^>]+>/g, '')
          .slice(0, 300),
      }))
      .filter((item) => item.url && item.title);
  } catch (err) {
    console.error('Failed to read the Dizer o Direito feed:', err);
    return [];
  }
};

/**
 * Conjur publishes a full-text RSS feed (`content:encoded`), which is fresher
 * and cheaper than asking a search engine what Conjur published today.
 */
const fetchConjurFeed = async () => {
  try {
    const res = await fetch('https://conjur.com.br/feed/', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return [];

    const xml = await res.text();

    return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g))
      .slice(0, 12)
      .map((match) => {
        const item = match[1];
        const pick = (tag: string) =>
          item
            .match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]
            ?.replace(/^<!\[CDATA\[/, '')
            .replace(/\]\]>$/, '')
            .trim() ?? '';

        return {
          title: pick('title'),
          url: pick('link'),
          content: pick('description')
            .replace(/<[^>]+>/g, '')
            .slice(0, 300),
        };
      })
      .filter((item) => item.url && item.title);
  } catch (err) {
    console.error('Failed to read the Conjur feed:', err);
    return [];
  }
};

export const GET = async (req: Request) => {
  try {
    const params = new URL(req.url).searchParams;

    const mode: 'normal' | 'preview' =
      (params.get('mode') as 'normal' | 'preview') || 'normal';
    const topic: Topic = (params.get('topic') as Topic) || 'tech';

    const selectedTopic = websitesForTopic[topic];
    /* `bing news` honours `site:` (measured 5/5 on-domain); the `bing` web
       engine ignores it entirely, so do not swap the engine here. */
    const language =
      'language' in selectedTopic ? (selectedTopic.language as string) : 'en';

    let data = [];

    if (mode === 'normal') {
      const seenUrls = new Set();

      data = (
        await Promise.all(
          selectedTopic.links.flatMap((link) =>
            selectedTopic.query.map(async (query) => {
              return (
                await searchSearxng(`site:${link} ${query}`, {
                  engines: ['bing news'],
                  pageno: 1,
                  language,
                })
              ).results;
            }),
          ),
        )
      )
        .flat()
        .filter((item) => {
          const url = item.url?.toLowerCase().trim();
          if (seenUrls.has(url)) return false;
          seenUrls.add(url);
          return true;
        })
        .sort(() => Math.random() - 0.5);
    } else {
      data = (
        await searchSearxng(
          `site:${selectedTopic.links[Math.floor(Math.random() * selectedTopic.links.length)]} ${selectedTopic.query[Math.floor(Math.random() * selectedTopic.query.length)]}`,
          {
            engines: ['bing news'],
            pageno: 1,
            language,
          },
        )
      ).results;
    }

    if (topic === 'juridico') {
      const [conjur, dizerODireito] = await Promise.all([
        fetchConjurFeed(),
        fetchDizerODireitoFeed(),
      ]);
      const seen = new Set(data.map((item: any) => item.url));
      const extra = [...conjur, ...dizerODireito].filter((item) => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
      data = [...extra, ...data];
    }

    return Response.json(
      {
        blogs: data,
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error(`An error occurred in discover route: ${err}`);
    return Response.json(
      {
        message: 'Ocorreu um erro',
      },
      {
        status: 500,
      },
    );
  }
};

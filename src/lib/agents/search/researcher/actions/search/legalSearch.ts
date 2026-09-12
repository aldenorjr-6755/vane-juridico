import z from 'zod';
import { ResearchAction } from '../../../types';
import { Chunk, ReadingResearchBlock, ResearchBlock } from '@/lib/types';
import { executeSearch, SearchQuery } from './baseSearch';
import {
  getEnabledLegalSources,
  isWhitelistedLegalUrl,
} from '@/lib/legal/sources';
import Scraper from '@/lib/scraper';

const schema = z.object({
  queries: z
    .array(z.string())
    .describe('Termos de busca jurídica, em português, no máximo 2.'),
  recency: z
    .enum(['day', 'week', 'month', 'year'])
    .optional()
    .describe(
      'Filtro de recência, apenas quando a pergunta for datada (ex.: "decisões recentes").',
    ),
  stf_jurisprudencia: z
    .string()
    .optional()
    .describe(
      'Termo para pesquisar na base de acórdãos do STF. Use apenas quando a pergunta pedir jurisprudência do STF.',
    ),
});

/**
 * The `google cse` engine runs off a hardcoded public CX with no API key and
 * suspends itself with "too many requests" after roughly eight queries. Fanning
 * one query out over every whitelisted host would trip it on the first turn, so
 * the archive path is budgeted and the two sources that have a native engine
 * (Conjur, Migalhas) never spend from it.
 */
const MAX_CSE_QUERIES = 4;
const MAX_NEWS_QUERIES = 4;

/**
 * Etapa 2: bases oficiais escopadas por autoridade.
 *
 * A etapa 1 busca amplo e mistura doutrina com tribunal, o que faz o precedente
 * constitucional competir por espaço com artigo de blog jurídico. Duas falhas
 * medidas vieram daí: a resposta sobre ICMS na base do PIS/COFINS saiu pela
 * posição do STJ sem citar a RG 69 do STF, e a do terço de férias saiu pela
 * RG 1241 sem a RG 985. Nos dois casos a busca direta nas bases oficiais acha o
 * precedente em primeiro lugar.
 *
 * Só roda quando a etapa 1 NÃO trouxe precedente de tribunal superior - é a
 * dependência entre os passos, não uma segunda busca cega.
 *
 * Se alguma dessas engines não estiver declarada no SearXNG, ele cai nas
 * engines gerais em silêncio; o pós-filtro por host descarta o que vier, então
 * a degradação é para vazio, não para resultado errado.
 */
const AUTHORITY_ENGINES = ['bnp superiores', 'stj repetitivos'];

/** A pergunta é sobre tribunal regional? Aí o CJF entra mesmo com precedente superior presente. */
const pedeRegional = (q: string): boolean =>
  /\bTRF\b|tribuna(l|is) regiona|regional|segunda inst[âa]ncia/i.test(q);

/** Precedente de tribunal superior já presente nos resultados da etapa 1. */
const temPrecedenteSuperior = (results: Chunk[]): boolean =>
  results.some((r) => {
    const titulo = r.metadata?.title ?? '';
    return (
      /^(STF|STJ|TST|TNU)\s*·/.test(titulo) ||
      /·\s*(RG|SUM|SV)\s*\d/.test(titulo)
    );
  });

const STF_JURISPRUDENCIA_URL =
  'https://jurisprudencia.stf.jus.br/pages/search?base=acordaos&pesquisa_inteiro_teor=false&sinonimo=true&plural=true&radicais=false&buscaExata=true&sort=_score&sortBy=desc&queryString=';

const buildQueryPlan = (
  queries: string[],
  recency?: 'day' | 'week' | 'month' | 'year',
  standaloneQuery?: string,
): SearchQuery[] => {
  const sources = getEnabledLegalSources();
  const base = {
    language: 'pt-BR',
    ...(recency ? { time_range: recency } : {}),
  };

  const plan: SearchQuery[] = [];

  const enginesDe = (lista: typeof sources) =>
    lista.flatMap((s) =>
      Array.isArray(s.engine) ? s.engine : [s.engine as string],
    );

  const nativeEngines = enginesDe(
    sources.filter(
      (s) =>
        s.discovery.includes('native') && s.engine && s.tier !== 'authority',
    ),
  );

  /* The site's own search, through a dedicated SearXNG engine. One request per
     query covers every native source at once and costs no CSE quota.
     The user's own question goes in alongside the researcher's rewrites: the
     official bases match the question's wording better than the rewrite, and
     losing the governing precedent to a reformulation is a measured failure -
     "Incide contribuição previdenciária sobre o terço constitucional de
     férias?" finds RG 985 first, while the rewrite that replaced it did not. */
  if (nativeEngines.length > 0) {
    const nativas = standaloneQuery ? [standaloneQuery, ...queries] : queries;
    const vistas = new Set<string>();

    nativas.forEach((q) => {
      const chave = q.trim().toLowerCase();
      if (!q.trim() || vistas.has(chave)) return;
      vistas.add(chave);
      plan.push({ q, searchConfig: { ...base, engines: nativeEngines } });
    });
  }

  /* Round-robin so the budget is spread across hosts instead of being spent on
     the first source's queries. */
  const fanOut = (
    kind: 'cse' | 'news',
    engine: string,
    budget: number,
  ): void => {
    const hosts = sources
      .filter(
        (s) =>
          s.discovery.includes(kind) &&
          s.siteQuery &&
          /* Only the CSE budget is scarce, and only there does a source with
             its own engine crowd out one that has no other path (Planalto).
             `bing news` costs nothing and is measured to work best exactly on
             Conjur and Migalhas, so it keeps them. */
          !(kind === 'cse' && s.discovery.includes('native') && s.engine),
      )
      .map((s) => s.siteQuery as string);

    const pairs: string[] = [];

    queries.forEach((q) =>
      hosts.forEach((host) => pairs.push(`site:${host} ${q}`)),
    );

    /* `site:a OR site:b` returns nothing on this CSE, so each host needs its
       own query. */
    pairs
      .slice(0, budget)
      .forEach((q) =>
        plan.push({ q, searchConfig: { ...base, engines: [engine] } }),
      );
  };

  fanOut('cse', 'google cse', MAX_CSE_QUERIES);
  fanOut('news', 'bing news', MAX_NEWS_QUERIES);

  return plan;
};

const actionDescription = `
Use esta ferramenta para pesquisa jurídica brasileira. Ela consulta apenas fontes jurídicas confiáveis: o **BNP - Banco Nacional de Precedentes do CNJ** e a base de **temas repetitivos do STJ** (precedente qualificado oficial, com tese e situação), Consultor Jurídico, Migalhas e JusBrasil (doutrina e notícia), Dizer o Direito (comentários de jurisprudência e Informativos do STF/STJ), a **Jurisprudência Unificada do CJF** (acórdãos do STJ, TNU, Turmas Recursais e TRFs, com ementa, relator e número real do processo), STF e Planalto (lei seca). Todo resultado fora desses domínios é descartado.

Use sempre que a pergunta envolver lei, artigo, súmula, tema repetitivo, REsp, RE, HC, ADI, jurisprudência, prazo, tese firmada ou o nome de um tribunal.

Regras:
1. Escreva as buscas em português, como termos de busca e não como frase. Máximo de 2 por chamada.
   Exemplo: para "qual o prazo da prescrição intercorrente na execução fiscal?", use ["prescrição intercorrente execução fiscal", "tese firmada prescrição intercorrente STJ"].
2. Use \`recency\` apenas quando a pergunta for explicitamente datada ("decisão recente", "o que mudou este ano").
3. Use \`stf_jurisprudencia\` apenas quando a pergunta pedir acórdão do STF; ela abre a base de acórdãos do próprio tribunal.
4. Se a ferramenta avisar que uma engine não respondeu, o resultado é parcial - diga isso na resposta em vez de tratá-lo como busca completa.
5. Se a pergunta for sobre "entendimento consolidado", "tese firmada", "o que o STJ/STF decidiu" ou equivalente, **uma das duas buscas tem que mirar o precedente vinculante**: inclua "tema repetitivo", "recurso repetitivo", "súmula" ou "repercussão geral" nos termos. Sem isso a busca traz julgado isolado de turma, que não governa a questão.
6. Os resultados do BNP e dos temas repetitivos do STJ trazem a **situação** do precedente (Vigente, Cancelado, Trânsito em Julgado, Afetado). Precedente cancelado ou ainda em julgamento não pode ser apresentado como entendimento firmado - repasse a situação na resposta.
`;

/** Engines das fontes marcadas `authority` (hoje só o CJF, por tribunal). */
const enginesAuthority = (incluir: boolean): string[] =>
  incluir
    ? getEnabledLegalSources()
        .filter((s) => s.tier === 'authority' && s.engine)
        .flatMap((s) =>
          Array.isArray(s.engine) ? s.engine : [s.engine as string],
        )
    : [];

const legalSearchAction: ResearchAction<typeof schema> = {
  name: 'legal_search',
  schema: schema,
  getDescription: () => actionDescription,
  getToolDescription: () =>
    'Pesquisa jurídica brasileira restrita a fontes confiáveis (BNP/CNJ, temas repetitivos do STJ, CJF, Conjur, Migalhas, JusBrasil, Dizer o Direito, STF, Planalto). Use para lei, súmula, tema repetitivo, jurisprudência, prazo e tese firmada.',
  /* Deliberately NOT gated on `classification.legalSearch`, unlike the academic
     and discussion actions. Turning "Jurídico" on is an explicit act by the
     user and a stronger signal than the classifier; if the classifier missed
     the legal intent, the tool would vanish and the answer would quietly come
     from the open web - the exact silent failure this mode exists to prevent.
     `legalSearch` still steers the researcher through the prompt. */
  enabled: (config) =>
    config.sources.includes('legal') &&
    config.classification.classification.skipSearch === false,
  execute: async (input, additionalConfig) => {
    const queries = (
      Array.isArray(input.queries) ? input.queries : [input.queries]
    ).slice(0, 2);

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    ) as ResearchBlock | undefined;

    if (!researchBlock) throw new Error('Failed to retrieve research block');

    const results = await executeSearch({
      llm: additionalConfig.llm,
      embedding: additionalConfig.embedding,
      mode: additionalConfig.mode,
      queries: buildQueryPlan(
        queries,
        input.recency,
        additionalConfig.standaloneQuery,
      ),
      researchBlock: researchBlock,
      session: additionalConfig.session,
      /* Never trust that the engine honoured `site:` - the bing web engine
         does not, and returned zero on-domain results in measurement. */
      resultFilter: (r) => isWhitelistedLegalUrl(r.url),
    });

    /* Etapa 2: as bases oficiais rodam SEMPRE.
       Antes isto era condicionado a "a etapa 1 não trouxe precedente superior",
       e a condição se mostrou permissiva demais: bastava um precedente superior
       qualquer para a passada de autoridade nunca acontecer. Foi assim que o
       terço de férias ficou sem a RG 985 e passou a citar "Tema 1.248", número
       que não estava em fonte nenhuma. Elas são baratas - duas APIs - então o
       certo é sempre perguntar.

       O que fica condicionado é só o CJF, que é caro (GET+POST por instância,
       oito tribunais): entra quando a pergunta é regional ou quando a etapa 1
       de fato não trouxe precedente superior. Aninhar o teste de "regional"
       dentro da condição anterior foi o que derrubou o caso dos TRFs. */
    {
      const faltaSuperior = !temPrecedenteSuperior(results);
      const querRegional =
        pedeRegional(additionalConfig.standaloneQuery ?? '') || faltaSuperior;
      const regionais = enginesAuthority(querRegional);

      researchBlock.data.subSteps.push({
        id: crypto.randomUUID(),
        type: 'reasoning',
        reasoning: `Consultando as bases oficiais diretamente (BNP e temas repetitivos do STJ)${
          regionais.length > 0
            ? ', mais a Jurisprudência Unificada do CJF por tribunal'
            : ''
        }.`,
      });

      additionalConfig.session.updateBlock(additionalConfig.researchBlockId, [
        {
          op: 'replace',
          path: '/data/subSteps',
          value: researchBlock.data.subSteps,
        },
      ]);

      const autoridade = await executeSearch({
        llm: additionalConfig.llm,
        embedding: additionalConfig.embedding,
        mode: additionalConfig.mode,
        queries: [additionalConfig.standaloneQuery, ...queries]
          .filter((q): q is string => Boolean(q && q.trim()))
          .slice(0, 2)
          .map((q) => ({
            q,
            searchConfig: {
              language: 'pt-BR',
              engines: [...AUTHORITY_ENGINES, ...regionais],
            },
          })),
        researchBlock: researchBlock,
        session: additionalConfig.session,
        resultFilter: (r) => isWhitelistedLegalUrl(r.url),
      });

      const jaVistas = new Set(results.map((r) => r.metadata?.url));
      results.push(...autoridade.filter((r) => !jaVistas.has(r.metadata?.url)));
    }

    if (input.stf_jurisprudencia) {
      const url = `${STF_JURISPRUDENCIA_URL}${encodeURIComponent(
        input.stf_jurisprudencia,
      )}`;

      researchBlock.data.subSteps.push({
        id: crypto.randomUUID(),
        type: 'reading',
        reading: [
          {
            content: '',
            metadata: { url, title: 'Jurisprudência do STF' },
          },
        ],
      } as ReadingResearchBlock);

      additionalConfig.session.updateBlock(additionalConfig.researchBlockId, [
        {
          op: 'replace',
          path: '/data/subSteps',
          value: researchBlock.data.subSteps,
        },
      ]);

      const scraped = await Scraper.scrape(url);

      const chunk: Chunk = {
        content: scraped.content,
        metadata: { url, title: scraped.title },
      };

      results.push(chunk);
    }

    return {
      type: 'search_results',
      results: results,
    };
  },
};

export default legalSearchAction;

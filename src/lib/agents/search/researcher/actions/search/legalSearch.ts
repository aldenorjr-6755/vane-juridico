import z from 'zod';
import { ResearchAction } from '../../../types';
import { Chunk, ReadingResearchBlock, ResearchBlock } from '@/lib/types';
import { executeSearch, SearchQuery } from './baseSearch';
import { getEnabledLegalSources, isWhitelistedLegalUrl } from '@/lib/legal/sources';
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

const STF_JURISPRUDENCIA_URL =
  'https://jurisprudencia.stf.jus.br/pages/search?base=acordaos&pesquisa_inteiro_teor=false&sinonimo=true&plural=true&radicais=false&buscaExata=true&sort=_score&sortBy=desc&queryString=';

const buildQueryPlan = (
  queries: string[],
  recency?: 'day' | 'week' | 'month' | 'year',
): SearchQuery[] => {
  const sources = getEnabledLegalSources();
  const base = { language: 'pt-BR', ...(recency ? { time_range: recency } : {}) };

  const plan: SearchQuery[] = [];

  const nativeEngines = sources
    .filter((s) => s.discovery.includes('native') && s.engine)
    .map((s) => s.engine as string);

  /* The site's own search, through a dedicated SearXNG engine. One request per
     query covers every native source at once and costs no CSE quota. */
  if (nativeEngines.length > 0) {
    queries.forEach((q) =>
      plan.push({ q, searchConfig: { ...base, engines: nativeEngines } }),
    );
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

    queries.forEach((q) => hosts.forEach((host) => pairs.push(`site:${host} ${q}`)));

    /* `site:a OR site:b` returns nothing on this CSE, so each host needs its
       own query. */
    pairs
      .slice(0, budget)
      .forEach((q) => plan.push({ q, searchConfig: { ...base, engines: [engine] } }));
  };

  fanOut('cse', 'google cse', MAX_CSE_QUERIES);
  fanOut('news', 'bing news', MAX_NEWS_QUERIES);

  return plan;
};

const actionDescription = `
Use esta ferramenta para pesquisa jurídica brasileira. Ela consulta apenas fontes jurídicas confiáveis: o **BNP - Banco Nacional de Precedentes do CNJ** e a base de **temas repetitivos do STJ** (precedente qualificado oficial, com tese e situação), Consultor Jurídico, Migalhas e JusBrasil (doutrina e notícia), Dizer o Direito (comentários de jurisprudência e Informativos do STF/STJ), STF e Planalto (lei seca). Todo resultado fora desses domínios é descartado.

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

const legalSearchAction: ResearchAction<typeof schema> = {
  name: 'legal_search',
  schema: schema,
  getDescription: () => actionDescription,
  getToolDescription: () =>
    'Pesquisa jurídica brasileira restrita a fontes confiáveis (BNP/CNJ, temas repetitivos do STJ, Conjur, Migalhas, JusBrasil, Dizer o Direito, STF, Planalto). Use para lei, súmula, tema repetitivo, jurisprudência, prazo e tese firmada.',
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
      queries: buildQueryPlan(queries, input.recency),
      researchBlock: researchBlock,
      session: additionalConfig.session,
      /* Never trust that the engine honoured `site:` - the bing web engine
         does not, and returned zero on-domain results in measurement. */
      resultFilter: (r) => isWhitelistedLegalUrl(r.url),
    });

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

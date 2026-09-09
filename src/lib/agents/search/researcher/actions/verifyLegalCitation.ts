import z from 'zod';
import { ResearchAction } from '../../types';
import { Chunk, ReadingResearchBlock, ResearchBlock } from '@/lib/types';

const schema = z.object({
  temas: z
    .array(z.number())
    .describe('Números de Tema Repetitivo do STJ a conferir. Máximo 5.'),
});

const TEMA_URL =
  'https://processo.stj.jus.br/repetitivos/temas_repetitivos/pesquisa.jsp?novaConsulta=true&tipo_pesquisa=T';

const actionDescription = `
Use esta ferramenta para conferir se um número de Tema Repetitivo do STJ existe de verdade e qual é a tese firmada, consultando a página oficial de precedentes do STJ.

Chame esta ferramenta SEMPRE que você estiver prestes a citar um número de Tema do STJ que não apareceu literalmente em uma fonte já lida. Número de tema é o identificador que mais se reconstrói errado, e um tema inventado com tese plausível ao lado é o pior erro possível numa resposta jurídica.

Chame também quando a resposta for afirmar qual precedente consolidou um entendimento do STJ. A página do tema traz a "Questão submetida a julgamento", que é o que revela se o repetitivo trata mesmo da matéria perguntada - a confusão típica é eleger um julgado de outro procedimento (execução civil no lugar de execução fiscal, por exemplo) como se fosse o precedente que governa.

A ferramenta devolve, para cada tema: se existe, a questão submetida a julgamento e a tese firmada (quando houver). Se devolver "não encontrado", NÃO cite aquele número.
`;

const stripHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const checkTema = async (
  tema: number,
): Promise<{ url: string; content: string }> => {
  const url = `${TEMA_URL}&cod_tema_inicial=${tema}&cod_tema_final=${tema}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20000),
    });

    /* A non-existent tema answers 200 with an empty page: the status code
       proves nothing here, only the body does. */
    const buffer = await res.arrayBuffer();
    const html = new TextDecoder('latin1').decode(buffer);
    const text = stripHtml(html);

    const hasContent =
      /Quest[ãa]o submetida a julgamento/i.test(text) ||
      /Tese Firmada/i.test(text);

    if (!hasContent) {
      return {
        url,
        content: `Tema ${tema} do STJ: NÃO ENCONTRADO na base de repetitivos do STJ (HTTP ${res.status}, página sem conteúdo de tema). Não cite este número.`,
      };
    }

    const start = text.search(/Quest[ãa]o submetida a julgamento/i);
    const excerpt = (start >= 0 ? text.slice(start) : text).slice(0, 4000);

    return {
      url,
      content: `Tema ${tema} do STJ: CONFIRMADO na base oficial de repetitivos.\n${excerpt}`,
    };
  } catch (err) {
    return {
      url,
      content: `Tema ${tema} do STJ: não foi possível verificar (${err}). Trate como não confirmado.`,
    };
  }
};

const verifyLegalCitationAction: ResearchAction<typeof schema> = {
  name: 'verify_stj_tema',
  schema: schema,
  getDescription: () => actionDescription,
  getToolDescription: () =>
    'Confere na base oficial do STJ se um número de Tema Repetitivo existe e qual a tese firmada. Use antes de citar qualquer número de tema que não apareceu literalmente numa fonte lida.',
  enabled: (config) =>
    config.sources.includes('legal') &&
    config.classification.classification.skipSearch === false,
  execute: async (input, additionalConfig) => {
    const temas = (Array.isArray(input.temas) ? input.temas : [input.temas])
      .map((t) => Number(t))
      .filter((t) => Number.isFinite(t) && t > 0)
      .slice(0, 5);

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    ) as ResearchBlock | undefined;

    const checked = await Promise.all(temas.map(checkTema));

    const results: Chunk[] = checked.map((c) => ({
      content: c.content,
      metadata: { url: c.url, title: 'STJ - Precedentes Qualificados' },
    }));

    if (researchBlock && results.length > 0) {
      researchBlock.data.subSteps.push({
        id: crypto.randomUUID(),
        type: 'reading',
        reading: results,
      } as ReadingResearchBlock);

      additionalConfig.session.updateBlock(additionalConfig.researchBlockId, [
        {
          op: 'replace',
          path: '/data/subSteps',
          value: researchBlock.data.subSteps,
        },
      ]);
    }

    return {
      type: 'search_results',
      results,
    };
  },
};

export default verifyLegalCitationAction;

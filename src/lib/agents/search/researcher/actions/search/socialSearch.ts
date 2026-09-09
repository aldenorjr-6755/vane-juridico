import z from 'zod';
import { ResearchAction } from '../../../types';
import { ResearchBlock } from '@/lib/types';
import { executeSearch } from './baseSearch';

const schema = z.object({
  queries: z.array(z.string()).describe('List of social search queries'),
});

const socialSearchDescription = `
Use this tool to perform social media searches for relevant posts, discussions, and trends related to the user's query. Provide a list of concise search queries that will help gather comprehensive social media information on the topic at hand.
You can provide up to 3 queries at a time. Make sure the queries are specific and relevant to the user's needs.

For example, if the user is interested in public opinion on electric vehicles, your queries could be:
1. "Electric vehicles public opinion 2024"
2. "Social media discussions on EV adoption"
3. "Trends in electric vehicle usage"

If this tool is present and no other tools are more relevant, you MUST use this tool to get the needed social media information.
`;

const socialSearchAction: ResearchAction<typeof schema> = {
  name: 'social_search',
  schema: schema,
  getDescription: () => socialSearchDescription,
  getToolDescription: () =>
    "Use this tool to perform social media searches for relevant posts, discussions, and trends related to the user's query. Provide a list of concise search queries that will help gather comprehensive social media information on the topic at hand.",
  enabled: (config) =>
    config.sources.includes('discussions') &&
    config.classification.classification.skipSearch === false &&
    config.classification.classification.discussionSearch === true,
  execute: async (input, additionalConfig) => {
    input.queries = (
      Array.isArray(input.queries) ? input.queries : [input.queries]
    ).slice(0, 3);

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    ) as ResearchBlock | undefined;

    if (!researchBlock) throw new Error('Failed to retrieve research block');

    const results = await executeSearch({
      llm: additionalConfig.llm,
      embedding: additionalConfig.embedding,
      mode: additionalConfig.mode,
      queries: input.queries,
      researchBlock: researchBlock,
      session: additionalConfig.session,
      searchConfig: {
        // 'reddit' does not exist in the bundled SearxNG. An unknown engine name
        // is not an error there - SearxNG silently ignores it and falls back to
        // the default `general` engines, so this action was returning ordinary
        // web results while claiming to be a discussion search.
        // These five are the ones that actually answer from this network
        // (verified 2026-09-01); they stay `disabled: true` in settings.yml on
        // purpose, since naming them here activates them without polluting
        // every normal web search with forum noise.
        engines: [
          'hackernews',
          'lemmy posts',
          'lemmy comments',
          'mastodon hashtags',
          'boardreader',
        ],
      },
    });

    return {
      type: 'search_results',
      results: results,
    };
  },
};

export default socialSearchAction;

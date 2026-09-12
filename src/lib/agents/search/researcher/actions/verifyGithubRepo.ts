import z from 'zod';
import { ResearchAction } from '../../types';
import { Chunk, ReadingResearchBlock, ResearchBlock } from '@/lib/types';

const schema = z.object({
  repos: z
    .array(z.string())
    .describe(
      'GitHub owner/repo slugs to verify (e.g. "affaan-m/ECC"). Max 5.',
    ),
});

const actionDescription = `
Use this tool to confirm that a GitHub repository actually exists before citing it, by querying the GitHub API directly.

Call this tool ALWAYS before citing an owner/repo slug that did not appear verbatim in a source you already read. Search engines and aggregator pages (LobeHub, Smithery-style directories, blog posts listing "awesome" tools) frequently describe a real project but the exact owner/repo slug gets reassembled wrong when you write the answer - the citation number next to it looks legitimate, but the repository itself 404s. A repo invented with a plausible description is one of the worst answer failures because nothing about the response looks wrong.

The tool returns, for each slug: whether it exists, its description, star count, last push date, and license when it does; if it returns "not found", do NOT cite that repository. If the check itself fails (rate limit, network error), the result is UNCERTAIN, not "does not exist" - do not cite it with confidence either way until it can be checked again.
`;

const normalizeSlug = (raw: string): string | null => {
  const trimmed = raw.trim();
  const fromUrl = trimmed.match(/github\.com\/([^/\s]+\/[^/\s#?]+)/i);
  const candidate = (fromUrl ? fromUrl[1] : trimmed).replace(/\.git$/i, '');
  return /^[\w.-]+\/[\w.-]+$/.test(candidate) ? candidate : null;
};

const checkRepo = async (
  repo: string,
): Promise<{ url: string; content: string }> => {
  const githubUrl = `https://github.com/${repo}`;
  const apiUrl = `https://api.github.com/repos/${repo}`;

  try {
    const res = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'vane-research-agent',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 404) {
      return {
        url: githubUrl,
        content: `Repository ${repo}: NOT FOUND on the GitHub API (404). Do not cite this repository - the slug was likely reconstructed incorrectly from a real source.`,
      };
    }

    if (!res.ok) {
      /* A non-200/404 status (rate limit, 5xx) proves nothing about whether
         the repo exists - only 200 or 404 does. Treating it as "not found"
         here would be the exact same silent-failure class this tool exists
         to catch. */
      return {
        url: githubUrl,
        content: `Repository ${repo}: could not be verified (GitHub API returned HTTP ${res.status}, possibly rate-limited). Treat as unconfirmed, do not cite with confidence.`,
      };
    }

    const data = await res.json();
    const stars = data.stargazers_count ?? '?';
    const pushedAt = data.pushed_at ?? '?';
    const license = data.license?.spdx_id ?? 'no declared license';
    const description = data.description ?? '(no description)';

    return {
      url: data.html_url ?? githubUrl,
      content: `Repository ${repo}: CONFIRMED on the GitHub API. Description: "${description}". Stars: ${stars}. Last push (pushed_at): ${pushedAt}. License: ${license}.`,
    };
  } catch (err) {
    return {
      url: githubUrl,
      content: `Repository ${repo}: could not be verified (${err}). Treat as unconfirmed.`,
    };
  }
};

const verifyGithubRepoAction: ResearchAction<typeof schema> = {
  name: 'verify_github_repo',
  schema: schema,
  getDescription: () => actionDescription,
  getToolDescription: () =>
    'Confirms via the GitHub API that an owner/repo slug actually exists before it gets cited. Use before citing any GitHub repository that did not appear literally in a source you already read.',
  enabled: (config) =>
    config.classification.classification.skipSearch === false,
  execute: async (input, additionalConfig) => {
    const rawRepos = Array.isArray(input.repos) ? input.repos : [input.repos];
    const repos = rawRepos
      .map(normalizeSlug)
      .filter((r): r is string => r !== null)
      .slice(0, 5);
    const unparsed = rawRepos.filter((r) => normalizeSlug(r) === null);

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    ) as ResearchBlock | undefined;

    const checked = await Promise.all(repos.map(checkRepo));

    const results: Chunk[] = checked.map((c) => ({
      content: c.content,
      metadata: { url: c.url, title: 'GitHub - Repository Check' },
    }));

    /* Silently dropping an unparseable slug would look identical to "nothing
       needed checking" - the exact ambiguity this tool exists to remove
       elsewhere. Surface it as its own result instead. */
    if (unparsed.length > 0) {
      results.push({
        content: `Could not parse as an owner/repo slug, so it was NOT checked and must not be cited as verified: ${unparsed.join(', ')}`,
        metadata: { url: '', title: 'GitHub - Repository Check' },
      });
    }

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

export default verifyGithubRepoAction;

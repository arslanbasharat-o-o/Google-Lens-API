import { LensAutomationError } from '../domain/errors.js';
import type {
  RelatedContent,
  SearchOptions,
  SerpApiResponse,
  VisualMatch,
} from '../domain/types.js';
import type { LensPageSnapshot } from '../adapters/lens-adapter.js';

export interface ParserContext {
  jobId: string;
  options: SearchOptions;
  startedAt: number;
  processedAt: number;
  source: 'mock' | 'scrapling';
  cached?: boolean;
}

export interface LensParser {
  parse(snapshot: LensPageSnapshot, context: ParserContext): SerpApiResponse;
}

const challengePattern =
  /captcha|recaptcha|verify you are human|unusual traffic|not a robot|robot check|automated queries/i;
const emptyPattern =
  /no (?:visual )?matches|no results found|couldn['’]t find|try another image|nothing found/i;
const loadingPattern = /loading|searching|processing|analy[sz]ing|please wait/i;

export function classifySnapshot(snapshot: LensPageSnapshot):
  | 'challenge'
  | 'loading'
  | 'empty'
  | 'parser'
  | undefined {
  if (challengePattern.test(snapshot.bodyText)) return 'challenge';
  if (snapshot.loading || (snapshot.links.length === 0 && loadingPattern.test(snapshot.bodyText))) {
    return 'loading';
  }
  if (emptyPattern.test(snapshot.bodyText)) return 'empty';
  if (snapshot.links.length === 0 && (snapshot.exactMatches?.length ?? 0) === 0) return 'parser';
  return undefined;
}

function sourceFor(link: string, fallback?: string): string {
  if (fallback?.trim()) return fallback.trim();
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function cleanLink(link: string): string | undefined {
  try {
    const url = new URL(link);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function cleanOptionalUrl(link: string | undefined): string | undefined {
  return link ? cleanLink(link) : undefined;
}

function normalizeMatch(candidate: LensPageSnapshot['links'][number], position: number): VisualMatch | undefined {
  const link = cleanLink(candidate.href);
  if (!link || !candidate.text.trim()) return undefined;
  return {
    position,
    title: candidate.text.trim().replace(/\s+/g, ' '),
    link,
    source: sourceFor(link, candidate.source),
    ...(cleanOptionalUrl(candidate.sourceIcon) ? { source_icon: cleanOptionalUrl(candidate.sourceIcon) } : {}),
    ...(cleanOptionalUrl(candidate.thumbnail) ? { thumbnail: cleanOptionalUrl(candidate.thumbnail) } : {}),
    ...(cleanOptionalUrl(candidate.image) ? { image: cleanOptionalUrl(candidate.image) } : {}),
    ...(candidate.imageWidth !== undefined ? { image_width: candidate.imageWidth } : {}),
    ...(candidate.imageHeight !== undefined ? { image_height: candidate.imageHeight } : {}),
    ...(candidate.price ? { price: candidate.price } : {}),
    ...(candidate.extractedPrice !== undefined ? { extracted_price: candidate.extractedPrice } : {}),
    ...(candidate.currency ? { currency: candidate.currency } : {}),
    ...(candidate.rating !== undefined ? { rating: candidate.rating } : {}),
  };
}

function normalizeRelatedContent(snapshot: LensPageSnapshot): RelatedContent[] | undefined {
  const items = (snapshot.relatedContent ?? [])
    .map((item) => {
      const query = item.query.trim().replace(/\s+/g, ' ');
      if (!query) return undefined;
      const link = cleanOptionalUrl(item.href);
      return {
        query,
        ...(link ? { link } : {}),
        ...(cleanOptionalUrl(item.thumbnail) ? { thumbnail: cleanOptionalUrl(item.thumbnail) } : {}),
      };
    })
    .filter((item): item is RelatedContent => Boolean(item));
  return items.length > 0 ? items : undefined;
}

export class DefaultLensParser implements LensParser {
  public parse(snapshot: LensPageSnapshot, context: ParserContext): SerpApiResponse {
    const failure = classifySnapshot(snapshot);
    if (failure) {
      throw new LensAutomationError(
        failure,
        failure === 'challenge'
          ? 'The Lens page requested human verification; automation stopped.'
          : failure === 'loading'
            ? 'The Lens page did not leave its loading state before the timeout.'
            : failure === 'empty'
              ? 'Lens returned no visual matches for the uploaded image.'
              : 'Lens returned a page without parseable result links.',
      );
    }

    const visualMatches: VisualMatch[] = snapshot.links
      .map((candidate, index) => normalizeMatch(candidate, index + 1))
      .filter((match): match is VisualMatch => Boolean(match));
    const exactMatches = (snapshot.exactMatches ?? [])
      .map((candidate, index) => normalizeMatch(candidate, index + 1))
      .filter((match): match is VisualMatch => Boolean(match));
    if (visualMatches.length === 0 && exactMatches.length === 0) {
      throw new LensAutomationError('parser', 'No valid visual match links could be normalized.');
    }

    const responseVisualMatches = context.options.type === 'exact_matches' ? [] : visualMatches;

    const createdAt = new Date(context.startedAt).toISOString();
    const processedAt = new Date(context.processedAt).toISOString();
    return {
      search_metadata: {
        id: context.jobId,
        status: 'Success',
        json_endpoint: `/v1/jobs/${context.jobId}`,
        created_at: createdAt,
        processed_at: processedAt,
        total_time_taken: Math.max(0, (context.processedAt - context.startedAt) / 1000),
        cached: context.cached ?? false,
        source: context.source,
      },
      search_parameters: context.options,
      visual_matches: responseVisualMatches,
      ...(exactMatches.length > 0 ? { exact_matches: exactMatches } : {}),
      ...(normalizeRelatedContent(snapshot) ? { related_content: normalizeRelatedContent(snapshot) } : {}),
    };
  }
}

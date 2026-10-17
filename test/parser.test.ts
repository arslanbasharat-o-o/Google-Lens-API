import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import { DefaultLensParser, classifySnapshot } from '../src/parser/lens-parser.js';
import { LensAutomationError } from '../src/domain/errors.js';
import type { LensPageSnapshot } from '../src/adapters/lens-adapter.js';

const context = {
  jobId: 'job-parser',
  options: { engine: 'google_lens' as const, hl: 'en' },
  startedAt: 1_000,
  processedAt: 1_250,
  source: 'mock' as const,
};

function snapshot(overrides: Partial<LensPageSnapshot> = {}): LensPageSnapshot {
  return {
    url: 'http://127.0.0.1:3900/mock-lens/results',
    title: 'Mock Lens',
    bodyText: 'Visual matches',
    links: [{ href: 'https://example.com/item', text: 'Example item' }],
    loading: false,
    observedAt: new Date(1_000).toISOString(),
    ...overrides,
  };
}

describe('DefaultLensParser', () => {
  it('normalizes safe DOM links into a SerpApi-style response', () => {
    const result = new DefaultLensParser().parse(snapshot(), context);
    expect(result.visual_matches).toEqual([
      {
        position: 1,
        title: 'Example item',
        link: 'https://example.com/item',
        source: 'example.com',
      },
    ]);
    expect(result.search_metadata).toMatchObject({
      id: 'job-parser',
      status: 'Success',
      total_time_taken: 0.25,
      source: 'mock',
    });
  });

  it('preserves optional Lens fields from a sanitized result fixture', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/mock-lens-success.json', import.meta.url), 'utf8'),
    ) as LensPageSnapshot;
    const result = new DefaultLensParser().parse(fixture, context);
    expect(result.visual_matches[0]).toMatchObject({
      source_icon: 'https://shop.example.test/favicon.ico',
      thumbnail: 'https://cdn.example.test/blue-chair-thumb.jpg',
      image: 'https://cdn.example.test/blue-chair.jpg',
      extracted_price: 129,
      currency: 'USD',
    });
    expect(result.exact_matches?.[0]).toMatchObject({ position: 1, title: 'Exact blue chair listing' });
    expect(result.related_content).toEqual([
      {
        query: 'blue chair',
        link: 'https://www.google.com/search?q=blue+chair',
        thumbnail: 'https://cdn.example.test/related.jpg',
      },
    ]);
  });

  it.each([
    ['challenge', 'Verify you are human', false],
    ['loading', 'Loading results', true],
    ['empty', 'No visual matches found', false],
    ['parser', 'Results are available', false],
  ] as const)('classifies %s page state', (kind, bodyText, loading) => {
    expect(classifySnapshot(snapshot({ bodyText, links: [], loading }))).toBe(kind);
    expect(() => new DefaultLensParser().parse(snapshot({ bodyText, links: [], loading }), context)).toThrow(
      LensAutomationError,
    );
  });
});

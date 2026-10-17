import type { LensAdapter, LensPageSnapshot, LensSearchInput } from './lens-adapter.js';
import { LensAutomationError } from '../domain/errors.js';

export type MockLensScenario = 'success' | 'challenge' | 'loading' | 'empty' | 'parser' | 'browser';

export interface MockLensAdapterOptions {
  scenario?: MockLensScenario;
  delayMs?: number;
}

export class MockLensAdapter implements LensAdapter {
  public readonly name = 'mock' as const;
  public readonly live = false;
  public calls = 0;

  private readonly scenario: MockLensScenario;
  private readonly delayMs: number;

  public constructor(options: MockLensAdapterOptions = {}) {
    this.scenario = options.scenario ?? 'success';
    this.delayMs = options.delayMs ?? 0;
  }

  public async search(_input: LensSearchInput): Promise<LensPageSnapshot> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.scenario === 'browser') {
      throw new LensAutomationError('browser', 'Mock browser failure.', true);
    }
    if (this.scenario === 'challenge') {
      return this.snapshot('Verify you are human to continue.', [], false);
    }
    if (this.scenario === 'loading') {
      return this.snapshot('Analyzing image… Loading results.', [], true);
    }
    if (this.scenario === 'empty') {
      return this.snapshot('No visual matches found. Try another image.', [], false);
    }
    if (this.scenario === 'parser') {
      return this.snapshot('Results are available.', [{ href: 'javascript:void(0)', text: 'unsafe' }], false);
    }
    return this.snapshot(
      'Visual matches',
      [
        {
          href: 'https://example.com/products/blue-chair',
          text: 'Blue chair product listing',
          source: 'example.com',
          thumbnail: 'https://example.com/images/blue-chair.jpg',
          price: '$129.00',
          rating: 4.5,
        },
        {
          href: 'https://shop.example.org/chairs/blue-chair',
          text: 'Modern blue chair',
          source: 'shop.example.org',
        },
      ],
      false,
    );
  }

  private snapshot(
    bodyText: string,
    links: LensPageSnapshot['links'],
    loading: boolean,
  ): LensPageSnapshot {
    return {
      url: 'http://127.0.0.1:3900/mock-lens/results',
      title: 'Mock Lens',
      bodyText,
      links,
      exactMatches: links.slice(0, 1),
      relatedContent: [{ query: 'blue chair', href: 'https://www.google.com/search?q=blue+chair' }],
      loading,
      observedAt: new Date().toISOString(),
      timings: { browserStartupMs: 0, navigationMs: this.delayMs, extractionMs: 0 },
    };
  }
}

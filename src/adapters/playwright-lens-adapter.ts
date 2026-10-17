import { chromium, type Browser, type Page } from 'playwright';

import { BrowserPool, type BrowserLauncher } from '../browser/browser-pool.js';
import type { AppConfig } from '../config.js';
import { LensAutomationError } from '../domain/errors.js';
import type {
  LensAdapter,
  LensDomLink,
  LensPageSnapshot,
  LensRelatedContent,
  LensSearchInput,
} from './lens-adapter.js';
import { classifySnapshot } from '../parser/lens-parser.js';

/**
 * Browser adapter for the public Lens UI. It intentionally uses only visible
 * page navigation, an ordinary DOM file input, and DOM state extraction. It
 * has no stealth layer, proxy rotation, fingerprint manipulation, CAPTCHA
 * solver, account farming, or undocumented Lens endpoint calls.
 */
export class PlaywrightLensAdapter implements LensAdapter {
  public readonly name = 'playwright-google-lens' as const;
  public readonly live = true;

  private readonly pool: BrowserPool;

  public constructor(
    private readonly config: Pick<
      AppConfig,
      | 'lensTargetUrl'
      | 'playwrightHeadless'
      | 'playwrightTimeoutMs'
      | 'liveAutomationEnabled'
      | 'liveAutomationAuthorized'
      | 'browserMinProcesses'
      | 'browserMaxProcesses'
      | 'browserContextsPerProcess'
      | 'browserRecycleJobs'
    >,
    launchBrowser: BrowserLauncher = (options) => chromium.launch(options),
    pool?: BrowserPool,
  ) {
    this.pool = pool ?? new BrowserPool(
      {
        headless: config.playwrightHeadless,
        minProcesses: config.browserMinProcesses,
        maxProcesses: config.browserMaxProcesses,
        contextsPerProcess: config.browserContextsPerProcess,
        recycleAfterJobs: config.browserRecycleJobs,
      },
      launchBrowser,
    );
  }

  public async start(): Promise<void> {
    if (!this.config.liveAutomationEnabled || !this.config.liveAutomationAuthorized) return;
    await this.pool.start();
  }

  public async close(): Promise<void> {
    await this.pool.close();
  }

  public async search(input: LensSearchInput): Promise<LensPageSnapshot> {
    if (!this.config.liveAutomationEnabled || !this.config.liveAutomationAuthorized) {
      throw new LensAutomationError(
        'browser',
        'Live Google Lens automation is disabled. Set both live authorization gates explicitly before enabling it.',
        false,
        { live_enabled: this.config.liveAutomationEnabled, authorized: this.config.liveAutomationAuthorized },
      );
    }

    const startedAt = Date.now();
    try {
      return await this.pool.withContext(async ({ context, startupMs }) => {
        const page = await context.newPage();
        try {
          const navigationStartedAt = Date.now();
          await this.navigateAndUpload(page, input);
          const navigationMs = Date.now() - navigationStartedAt;
          const extractionStartedAt = Date.now();
          const snapshot = await this.readSnapshot(page);
          const extractionMs = Date.now() - extractionStartedAt;
          const failure = classifySnapshot(snapshot);
          if (failure) {
            throw new LensAutomationError(
              failure,
              failure === 'challenge'
                ? 'The Lens UI displayed a challenge; automation stopped without attempting to bypass it.'
                : failure === 'loading'
                  ? 'The Lens UI remained in a loading state until the configured timeout.'
                  : failure === 'empty'
                    ? 'The Lens UI contained no visual matches.'
                    : 'The Lens UI did not expose parseable result links.',
              failure === 'loading',
            );
          }
          return {
            ...snapshot,
            timings: {
              ...(snapshot.timings ?? {}),
              browserStartupMs: startupMs,
              navigationMs,
              extractionMs,
              adapterMs: Date.now() - startedAt,
            },
          };
        } finally {
          await page.close().catch(() => undefined);
        }
      });
    } catch (error) {
      if (error instanceof LensAutomationError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown Playwright failure';
      throw new LensAutomationError('browser', `Playwright browser operation failed: ${message}`, true);
    }
  }

  private async navigateAndUpload(page: Page, input: LensSearchInput): Promise<void> {
    await page.goto(this.config.lensTargetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.playwrightTimeoutMs,
    });

    let fileInput = page.locator('input[type="file"]').first();
    if ((await fileInput.count()) === 0) {
      await this.openImageSearchControl(page);
      fileInput = page.locator('input[type="file"], input[accept*="image"], input[name="encoded_image"]').first();
    }
    if ((await fileInput.count()) === 0) {
      throw new LensAutomationError('browser', 'The Lens UI did not expose an image upload control.', true);
    }
    await fileInput.setInputFiles({
      name: input.originalName ?? 'upload',
      mimeType: input.mimeType,
      buffer: input.image,
    });

    try {
      await page.waitForFunction(
        () => {
          const body = document.body?.innerText ?? '';
          const challenge = /captcha|recaptcha|verify you are human|unusual traffic|not a robot|robot check/i.test(body);
          const empty = /no (?:visual )?matches|no results found|couldn['’]t find|try another image|nothing found/i.test(body);
          const resultCards = document.querySelectorAll(
            '[data-lens-result], [data-visual-match], [data-result-card], [data-lens-section="visual-matches"] a[href]',
          );
          const exactCards = document.querySelectorAll('[data-exact-match], [data-lens-section="exact-matches"] a[href]');
          const busy = Boolean(
            document.querySelector('[aria-busy="true"], [role="progressbar"], [data-loading="true"]'),
          );
          const resultLanguage = /visual matches|exact matches|results for|similar images|related content/i.test(body);
          return challenge || empty || resultCards.length > 0 || exactCards.length > 0 || (!busy && resultLanguage);
        },
        undefined,
        { timeout: this.config.playwrightTimeoutMs },
      );
    } catch {
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-lens-loading-timeout', 'true');
      });
    }
  }

  private async openImageSearchControl(page: Page): Promise<void> {
    const roleButton = page.getByRole('button', { name: /search by image|google lens|image search/i }).first();
    if (await roleButton.count()) {
      await roleButton.click({ timeout: this.config.playwrightTimeoutMs });
      return;
    }
    const labelledControl = page.locator(
      '[aria-label*="Search by image" i], [aria-label*="Google Lens" i], a[href*="lens" i], button[data-ved]',
    ).first();
    if (await labelledControl.count()) {
      await labelledControl.click({ timeout: this.config.playwrightTimeoutMs });
      return;
    }
    throw new LensAutomationError('browser', 'The Google page did not expose a Search by image control.', true);
  }

  private async readSnapshot(page: Page): Promise<LensPageSnapshot> {
    const state = await page.evaluate(() => {
      const resultSelector =
        '[data-lens-result], [data-visual-match], [data-result-card], [data-lens-section="visual-matches"] a[href]';
      const exactSelector = '[data-exact-match], [data-lens-section="exact-matches"] a[href]';

      const toNumber = (value: string | null | undefined): number | undefined => {
        if (!value) return undefined;
        const number = Number(value.replace(/[^0-9.]/g, ''));
        return Number.isFinite(number) ? number : undefined;
      };

      const readLinks = (selector: string): LensDomLink[] => {
        const candidates = [...document.querySelectorAll<HTMLAnchorElement>(selector)];
        const seen = new Set<string>();
        const links: LensDomLink[] = [];
        for (const anchor of candidates) {
          const href = anchor.href;
          const text = (anchor.innerText || anchor.textContent || '').trim();
          if (!href || !text || seen.has(href)) continue;
          try {
            const parsed = new URL(href);
            if (!['http:', 'https:'].includes(parsed.protocol)) continue;
            if (/^(?:www\.)?(?:google\.[^/]+|googleusercontent\.com)$/i.test(parsed.hostname)) continue;
          } catch {
            continue;
          }
          const card = anchor.closest<HTMLElement>(
            '[data-lens-result], [data-visual-match], [data-result-card], article, li, [role="article"]',
          ) ?? anchor;
          const image = card.querySelector<HTMLImageElement>('img');
          const priceNode = card.querySelector<HTMLElement>(
            '[data-price], [itemprop="price"], [aria-label*="$" i], [aria-label*="€" i], [aria-label*="£" i]',
          );
          const priceText = priceNode?.innerText?.trim() || '';
          const extractedPrice = toNumber(priceNode?.getAttribute('content') || priceText);
          const currency = priceText.match(/[$€£]|\b(?:USD|EUR|GBP|PKR)\b/i)?.[0];
          links.push({
            href,
            text,
            source: card.getAttribute('data-source') || undefined,
            sourceIcon: card.querySelector<HTMLImageElement>('[data-source-icon]')?.src || undefined,
            thumbnail: image?.getAttribute('data-src') || image?.src || undefined,
            image: card.querySelector<HTMLImageElement>('[data-result-image]')?.src || undefined,
            imageWidth: image?.naturalWidth || undefined,
            imageHeight: image?.naturalHeight || undefined,
            ...(priceText ? { price: priceText } : {}),
            ...(extractedPrice !== undefined ? { extractedPrice } : {}),
            ...(currency ? { currency } : {}),
            rating: toNumber(card.querySelector<HTMLElement>('[data-rating], [aria-label*="rating" i]')?.textContent),
          });
          seen.add(href);
        }
        return links;
      };

      const related: LensRelatedContent[] = [...document.querySelectorAll<HTMLAnchorElement>(
        '[data-related-content] a[href], [data-lens-section="related-content"] a[href]',
      )].flatMap((anchor) => {
        const query = (anchor.innerText || anchor.textContent || '').trim();
        return query ? [{ query, href: anchor.href, thumbnail: anchor.querySelector<HTMLImageElement>('img')?.src }] : [];
      });

      return {
        url: window.location.href,
        title: document.title,
        bodyText: document.body?.innerText ?? '',
        links: readLinks(resultSelector),
        exactMatches: readLinks(exactSelector),
        relatedContent: related,
        loading: Boolean(
          document.querySelector('[aria-busy="true"], [role="progressbar"], [data-loading="true"]'),
        ),
      };
    });
    const timedOut = await page.evaluate(() =>
      document.documentElement.getAttribute('data-lens-loading-timeout') === 'true',
    );
    return {
      ...state,
      loading: state.loading || (timedOut && state.links.length === 0 && state.exactMatches.length === 0),
      observedAt: new Date().toISOString(),
    };
  }
}

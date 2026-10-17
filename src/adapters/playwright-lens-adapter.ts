import { chromium, type Browser, type Page } from 'playwright';

import type { AppConfig } from '../config.js';
import { LensAutomationError } from '../domain/errors.js';
import type { LensPageSnapshot, LensSearchInput, LensAdapter } from './lens-adapter.js';
import { classifySnapshot } from '../parser/lens-parser.js';

export type BrowserLauncher = (options: { headless: boolean }) => Promise<Browser>;

/**
 * Browser adapter for the public Lens UI. It intentionally uses only visible
 * page navigation, a DOM file input, and DOM state extraction. There is no
 * stealth layer, proxy, CAPTCHA solver, fingerprint manipulation, or direct
 * request to an undocumented Lens endpoint.
 */
export class PlaywrightLensAdapter implements LensAdapter {
  public readonly name = 'playwright-google-lens' as const;
  public readonly live = true;

  private readonly launchBrowser: BrowserLauncher;

  public constructor(
    private readonly config: Pick<
      AppConfig,
      | 'lensTargetUrl'
      | 'playwrightHeadless'
      | 'playwrightTimeoutMs'
      | 'liveAutomationEnabled'
      | 'liveAutomationAuthorized'
    >,
    launchBrowser: BrowserLauncher = (options) => chromium.launch(options),
  ) {
    this.launchBrowser = launchBrowser;
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

    let browser: Browser | undefined;
    try {
      browser = await this.launchBrowser({ headless: this.config.playwrightHeadless });
      const page = await browser.newPage();
      await this.navigateAndUpload(page, input);
      const snapshot = await this.readSnapshot(page);
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
      return snapshot;
    } catch (error) {
      if (error instanceof LensAutomationError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown Playwright failure';
      throw new LensAutomationError('browser', `Playwright browser operation failed: ${message}`, true);
    } finally {
      if (browser) await browser.close().catch(() => undefined);
    }
  }

  private async navigateAndUpload(page: Page, input: LensSearchInput): Promise<void> {
    await page.goto(this.config.lensTargetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.playwrightTimeoutMs,
    });
    const fileInput = page.locator('input[type="file"]').first();
    if ((await fileInput.count()) === 0) {
      throw new LensAutomationError('browser', 'The Lens UI did not expose an image file input.', true);
    }
    await fileInput.setInputFiles({
      name: input.originalName ?? 'upload',
      mimeType: input.mimeType,
      buffer: input.image,
    });
    let timedOut = false;
    try {
      await page.waitForFunction(
        () => {
          const body = document.body?.innerText ?? '';
          const challenge = /captcha|recaptcha|verify you are human|unusual traffic|not a robot/i.test(body);
          const empty = /no (?:visual )?matches|no results found|couldn['’]t find|try another image/i.test(body);
          const links = document.querySelectorAll('a[href^="http"]');
          const busy = Boolean(
            document.querySelector('[aria-busy="true"], [role="progressbar"], [data-loading="true"]'),
          );
          return challenge || empty || links.length > 0 || !busy;
        },
        undefined,
        { timeout: this.config.playwrightTimeoutMs },
      );
    } catch {
      // Snapshot classification below turns a timeout into a typed loading
      // failure while preserving any visible challenge or empty state.
      timedOut = true;
    }
    if (timedOut) {
      // Keep the timeout observable to the caller even when the page did not
      // expose a conventional aria-busy/progress marker.
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-lens-loading-timeout', 'true');
      });
    }
  }

  private async readSnapshot(page: Page): Promise<LensPageSnapshot> {
    const state = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')];
      return {
        url: window.location.href,
        title: document.title,
        bodyText: document.body?.innerText ?? '',
        links: anchors.map((anchor) => ({
          href: anchor.href,
          text: anchor.innerText || anchor.textContent || '',
          source: anchor.hostname,
          thumbnail: anchor.querySelector<HTMLImageElement>('img')?.src,
        })),
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
      loading: state.loading || (timedOut && state.links.length === 0),
      links: state.links.map((link) => ({
        ...link,
        ...(link.thumbnail ? { thumbnail: link.thumbnail } : {}),
      })),
      observedAt: new Date().toISOString(),
    };
  }
}

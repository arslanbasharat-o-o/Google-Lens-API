import { describe, expect, it, vi } from 'vitest';

import { PlaywrightLensAdapter } from '../src/adapters/playwright-lens-adapter.js';
import { LensAutomationError } from '../src/domain/errors.js';

const input = {
  image: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  mimeType: 'image/png' as const,
  options: { engine: 'google_lens' as const },
};

describe('PlaywrightLensAdapter', () => {
  it('refuses live operation unless both explicit gates are enabled', async () => {
    const launcher = vi.fn();
    const adapter = new PlaywrightLensAdapter(
      {
        lensTargetUrl: 'https://lens.google.com/',
        playwrightHeadless: true,
        playwrightTimeoutMs: 100,
        liveAutomationEnabled: false,
        liveAutomationAuthorized: false,
      },
      launcher,
    );
    await expect(adapter.search(input)).rejects.toMatchObject({
      code: 'lens_browser',
      message: expect.stringContaining('disabled'),
    } satisfies Partial<LensAutomationError>);
    expect(launcher).not.toHaveBeenCalled();
  });
});

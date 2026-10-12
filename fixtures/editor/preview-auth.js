import { test as base, expect } from '@playwright/test';

export async function attachPreviewAuth(context, baseURL, headers) {
  if (!Object.keys(headers).length) return;
  const origin = new URL(baseURL).origin;
  await context.route('**/*', async route => {
    let url = new URL(route.request().url());
    if (url.origin !== origin) return route.continue();
    // Playwright does not intercept every hop in a browser redirect chain.
    // Follow same-origin hops here; an external redirect is fulfilled without
    // ever adding credentials to the browser's own request headers.
    for (let hop = 0; hop < 6; hop++) {
      const response = await route.fetch({ url: url.href,
        headers: { ...route.request().headers(), ...headers }, maxRedirects: 0 });
      const location = response.headers().location;
      if (![301, 302, 303, 307, 308].includes(response.status()) || !location) return route.fulfill({ response });
      const next = new URL(location, url);
      if (next.origin !== origin) return route.fulfill({ response });
      url = next;
    }
    await route.abort('failed');
  });
}

// Limit preview credentials to their own origin, including subresource requests.
// Cross-origin analytics, links and redirects must never receive these headers.
export const test = base.extend({
  previewAuth: [async ({ context, baseURL }, use) => {
    const headers = JSON.parse(process.env.RODEO_PREVIEW_HEADERS || '{}');
    await attachPreviewAuth(context, baseURL, headers);
    await use();
  }, { auto: true }],
});
export { expect };

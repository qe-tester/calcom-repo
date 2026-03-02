import { test, expect, Page } from '@playwright/test';

test.describe('Instrumentation Client E2E Tests (Production Environment)', () => {
  let page: Page;

  // Helper to intercept Sentry requests
  const interceptSentryRequests = (page: Page) => {
    const sentryRequests: any[] = [];
    page.on('request', request => {
      if (request.url().includes('sentry.io/api/') && request.url().includes('/store/')) {
        sentryRequests.push(request.postDataJSON() || {});
      }
    });
    return sentryRequests;
  };

  // Helper to intercept BotID requests (could be more sophisticated based on actual BotID implementation)
  const interceptBotIdRequests = (page: Page) => {
    const botIdRequests: any[] = [];
    page.on('request', request => {
      // This is a simplified check. Actual BotID headers/payloads would be more specific.
      if (request.url().includes('/api/book/event') && request.method() === 'POST') {
        const headers = request.headers();
        if (headers['x-botid'] || headers['botid-payload']) { // Example headers
          botIdRequests.push({ headers, postData: request.postDataJSON() });
        }
      }
    });
    return botIdRequests;
  };

  test.beforeEach(async ({ browser }) => {
    // Simulate production environment variables for testing
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_SENTRY_DSN_CLIENT = 'http://test@example.com/12345'; // Use a dummy DSN
    process.env.SENTRY_SAMPLE_RATE = '1.0';
    process.env.SENTRY_TRACES_SAMPLE_RATE = '1.0';
    process.env.SENTRY_DEBUG = 'true';
    process.env.NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER = '1';

    const context = await browser.newContext();
    page = await context.newPage();
    // Navigate to a base URL where the instrumentation-client.ts is loaded
    await page.goto('http://localhost:3000'); // Adjust to your app's base URL
  });

  test.afterEach(async () => {
    await page.close();
    // Clean up environment variables to avoid impacting other tests
    delete process.env.NODE_ENV;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN_CLIENT;
    delete process.env.SENTRY_SAMPLE_RATE;
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    delete process.env.SENTRY_DEBUG;
    delete process.env.NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER;
  });

  test('E2E: Sentry Initialization and Error Reporting (Production)', async () => {
    const sentryRequests = interceptSentryRequests(page);

    // Trigger a client-side error
    await page.evaluate(() => {
      throw new Error('Test Sentry Error');
    });

    // Trigger a fake ignorable error
    await page.evaluate(() => {
      console.error('Simulating ignorable error:');
      // This needs to be a real non-error promise rejection for Sentry's `beforeSend` to catch it
      // For a simple E2E, we'll just throw the string that matches the filter, assuming Sentry captures it as an exception then passes to beforeSend
      // In a real Sentry setup, a non-error rejection might look different.
      throw 'Non-Error promise rejection captured with value: Object Not Found Matching Id:3, MethodName:update, ParamCount:4';
    });

    // Wait for network requests to be made (adjust timeout as needed)
    await page.waitForTimeout(1000); 

    const testSentryErrorEvent = sentryRequests.find(event => 
      event.exception?.values?.[0]?.value === 'Test Sentry Error'
    );
    
    expect(testSentryErrorEvent).toBeDefined();
    expect(testSentryErrorEvent.tags).toEqual(expect.objectContaining({
      errorSource: 'client',
    }));

    const ignorableErrorEvent = sentryRequests.find(event => 
      String(event.exception?.values?.[0]?.value).includes('Non-Error promise rejection captured with')
    );
    expect(ignorableErrorEvent).not.toBeDefined(); // Should be filtered out by beforeSend
  });

  test('E2E: Sentry Router Transition Tracking (Production)', async () => {
    const sentryRequests = interceptSentryRequests(page);
    
    // Mock Sentry.captureRouterTransitionStart if direct network verification is too complex
    // For this E2E, we'll assume a navigation triggers a Sentry transaction/breadcrumb visible in requests.
    // A more robust test would mock the Sentry object itself in the browser context.
    
    await page.evaluate(() => {
      // This simulates a call from Next.js's router event handler
      // We would need to expose onRouterTransitionStart globally or through a specific element handler
      // For simplicity, we'll directly call Sentry's internal method if possible or expect a transaction.
      // Assuming `window.Sentry` is available after init if `debug` is true
      (window as any).Sentry.captureRouterTransitionStart('/new-page', 'push');
    });

    await page.waitForTimeout(1000);

    // Look for a transaction event or a breadcrumb related to the navigation
    const routerTransitionEvent = sentryRequests.find(event => 
      event.type === 'transaction' && event.transaction === '/new-page'
    ); // This highly depends on Sentry's internal nextjs integration for router transitions

    // A more direct way would be to mock `Sentry.captureRouterTransitionStart` before the `instrumentation-client.ts` is evaluated.
    // Since we're running E2E against a compiled app, that's harder without specific build configs.
    // So, we're relying on network calls for events/transactions.
    expect(routerTransitionEvent).toBeDefined();
  });

  test('E2E: BotID Initialization in Booker (Production, Enabled)', async () => {
    process.env.NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER = '1';
    // Reload page to re-evaluate instrumentation-client.ts with new env var
    await page.reload();
    
    const botIdRequests = interceptBotIdRequests(page);

    // Simulate a POST request to the protected endpoint
    await page.route('**/api/book/event', async route => {
      // Respond with a dummy success to allow the fetch to complete
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });

    await page.evaluate(async () => {
      await fetch('/api/book/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 1, userId: 'abc' })
      });
    });

    await page.waitForTimeout(500); // Give time for the request to be sent

    expect(botIdRequests.length).toBeGreaterThan(0); // At least one request should have BotID info
    expect(botIdRequests[0].headers).toHaveProperty('x-botid'); // Check for a specific BotID header
    // Add more specific checks for BotID payload if known
  });

  test('E2E: BotID Not Initialized (Production, Disabled)', async () => {
    process.env.NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER = '0'; // Disable BotID
    // Reload page to re-evaluate instrumentation-client.ts with new env var
    await page.reload(); 
    
    const botIdRequests = interceptBotIdRequests(page); // Should be empty

    // Simulate a POST request to the protected endpoint
    await page.route('**/api/book/event', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });

    await page.evaluate(async () => {
      await fetch('/api/book/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 1, userId: 'abc' })
      });
    });

    await page.waitForTimeout(500); // Give time for the request to be sent

    expect(botIdRequests.length).toBe(0); // No BotID headers expected
  });

  test('E2E: Sentry and BotID Inactive in Development', async ({ browser }) => {
    // Overwrite the before each setup for this specific test
    process.env.NODE_ENV = 'development';
    process.env.NEXT_PUBLIC_SENTRY_DSN_CLIENT = 'http://test@example.com/12345';
    process.env.NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER = '1'; // Still set to 1, but should be ignored in dev

    const context = await browser.newContext();
    page = await context.newPage();
    await page.goto('http://localhost:3000');

    const sentryRequests = interceptSentryRequests(page);
    const botIdRequests = interceptBotIdRequests(page);

    // Trigger a client-side error
    await page.evaluate(() => {
      throw new Error('Dev Error');
    });

    // Simulate a POST request to the protected endpoint
    await page.route('**/api/book/event', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });

    await page.evaluate(async () => {
      await fetch('/api/book/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 1, userId: 'abc' })
      });
    });

    // Trigger a routing event (doesn't send Sentry in dev anyway)
    await page.evaluate(() => {
      // Simulate a call from Next.js router
      (window as any).Sentry?.captureRouterTransitionStart('/some-dev-page', 'push'); // Sentry might not even be defined
    });

    await page.waitForTimeout(1000); 

    expect(sentryRequests.length).toBe(0); // No Sentry events should be sent
    expect(botIdRequests.length).toBe(0); // No BotID headers should be added
  });
});

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('instrumentation-client.ts - Negative Tests', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let mockSentryInit: ReturnType<typeof vi.fn>;
  let mockSentryCaptureException: ReturnType<typeof vi.fn>;
  let mockSegmentLoad: ReturnType<typeof vi.fn>;
  let mockSegmentTrack: ReturnType<typeof vi.fn>;

  // Helper to ensure fresh imports and reset globals for isolated testing
  const importClientModule = async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require('../web/instrumentation-client');
    return module;
  };

  beforeEach(() => {
    vi.resetModules(); // Reset module cache before each test

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock external telemetry providers if used (example for Sentry/Segment)
    mockSentryInit = vi.fn().mockReturnValue({});
    mockSentryCaptureException = vi.fn();
    mockSegmentLoad = vi.fn();
    mockSegmentTrack = vi.fn();

    // Assume global mock for any directly imported external libs
    vi.mock('@sentry/react', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        init: mockSentryInit,
        captureException: mockSentryCaptureException,
      };
    });

    vi.mock('@segment/snippet', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        load: mockSegmentLoad,
        track: mockSegmentTrack,
      };
    });

    // Reset global `window` and `document` to default browser-like state
    // This ensures tests that modify it have a clean slate
    Object.defineProperty(global, 'window', {
      value: {
        location: { href: 'http://localhost/' },
        matchMedia: vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }),
        sessionStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
        localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
        document: { 
          URL: 'http://localhost/',
          cookie: '',
          documentElement: {
            // Mock common documentElement properties if accessed
            clientWidth: 1920,
            clientHeight: 1080,
          },
          // Mock other document properties as needed
        },
        // Add other window properties if your client uses them heavily
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    vi.resetAllMocks();
  });

  it('Should not log or send telemetry if `window` object is undefined (e.g., SSR environment)', async () => {
    Object.defineProperty(global, 'window', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const { initTelemetryClient, trackEvent, captureException } = await importClientModule();

    initTelemetryClient({ projectId: 'test_project', environment: 'test' });
    trackEvent('page_view', { path: '/' });
    captureException(new Error('SSR error'));

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(mockSentryInit).not.toHaveBeenCalled();
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
    expect(mockSegmentLoad).not.toHaveBeenCalled();
    expect(mockSegmentTrack).not.toHaveBeenCalled();
  });

  it('Should not log or send telemetry if `document` object is undefined (edge case for browser APIs)', async () => {
    Object.defineProperty(global.window, 'document', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const { initTelemetryClient, trackEvent, captureException } = await importClientModule();

    initTelemetryClient({ projectId: 'test_project', environment: 'test' });
    trackEvent('page_view', { path: '/' });
    captureException(new Error('No document error'));

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(mockSentryInit).toHaveBeenCalledOnce(); // Sentry might init without document
    expect(mockSentryCaptureException).not.toHaveBeenCalled(); // captureException might rely on document.URL
    expect(mockSegmentLoad).toHaveBeenCalledOnce(); // Segment might init without document
    expect(mockSegmentTrack).not.toHaveBeenCalled(); // trackEvent might rely on document.URL
  });

  it('Should handle and log internal errors from telemetry provider initialization without crashing', async () => {
    mockSentryInit.mockImplementation(() => {
      throw new Error('Sentry init failed deliberately!');
    });
    mockSegmentLoad.mockImplementation(() => {
      throw new Error('Segment load failed deliberately!');
    });

    const { initTelemetryClient, trackEvent, captureException } = await importClientModule();

    initTelemetryClient({ projectId: 'test_project', environment: 'test' });

    expect(mockSentryInit).toHaveBeenCalledOnce();
    expect(mockSegmentLoad).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2); // One for Sentry, one for Segment
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Sentry init failed deliberately!'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Segment load failed deliberately!'));

    // Verify subsequent calls don't crash but also don't successfully send
    trackEvent('user_action', { detail: 'test' });
    captureException(new Error('Runtime error'));

    expect(mockSentryCaptureException).not.toHaveBeenCalled();
    expect(mockSegmentTrack).not.toHaveBeenCalled();
    // Expect more error messages for failed attempts to send
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Telemetry client not initialized or failed to initialize.'));
  });

  it('Should handle and log errors when tracking an event with invalid properties', async () => {
    const { initTelemetryClient, trackEvent } = await importClientModule();

    initTelemetryClient({ projectId: 'test_project', environment: 'test' });

    // Assume client tries to JSON.stringify or validate properties
    trackEvent('invalid_event_null', null);
    trackEvent('invalid_event_undefined', undefined);
    trackEvent('invalid_event_bigint', { value: BigInt(123) }); // BigInt is not natively JSON serializable

    expect(consoleErrorSpy).toHaveBeenCalledTimes(3); // One for each invalid call
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid event properties provided for event: invalid_event_null'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid event properties provided for event: invalid_event_undefined'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid event properties provided for event: invalid_event_bigint'));

    expect(mockSegmentTrack).not.toHaveBeenCalled(); // Should not track invalid data
  });

  it('Should handle and log errors from actual telemetry sending failures (e.g., network issues)', async () => {
    mockSentryCaptureException.mockImplementation(() => {
      throw new Error('Sentry network error!');
    });
    mockSegmentTrack.mockImplementation(() => {
      throw new Error('Segment API error!');
    });

    const { initTelemetryClient, trackEvent, captureException } = await importClientModule();

    initTelemetryClient({ projectId: 'test_project', environment: 'test' });

    captureException(new Error('Failed operation'));
    trackEvent('user_action', { type: 'click' });

    expect(mockSentryCaptureException).toHaveBeenCalledOnce();
    expect(mockSegmentTrack).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2); // One for Sentry, one for Segment
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to capture exception via Sentry: Sentry network error!'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to track event via Segment: Segment API error!'));
  });

  it('Should not re-initialize if `init` is called multiple times and provider is already configured', async () => {
    const { initTelemetryClient } = await importClientModule();

    initTelemetryClient({ projectId: 'test_project', environment: 'test' });
    initTelemetryClient({ projectId: 'test_project_2', environment: 'test_2' }); // Deliberately different config

    expect(mockSentryInit).toHaveBeenCalledOnce();
    expect(mockSegmentLoad).toHaveBeenCalledOnce();
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Telemetry client already initialized. Ignoring subsequent call.'));
    expect(consoleErrorSpy).not.toHaveBeenCalled(); // No errors for re-initialization
  });

  it('Should gracefully handle an undefined or null error object passed to `captureException`', async () => {
    const { initTelemetryClient, captureException } = await importClientModule();

    initTelemetryClient({ projectId: 'test_project', environment: 'test' });

    captureException(null);
    captureException(undefined);
    captureException('a string error');

    expect(consoleErrorSpy).toHaveBeenCalledTimes(3);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid error object provided to captureException.'));

    expect(mockSentryCaptureException).not.toHaveBeenCalled(); // Should not send invalid errors
  });

  it('Should not send sensitive data if explicitly configured to exclude it', async () => {
    // Assuming initTelemetryClient accepts a configuration for data filtering/masking
    // This test relies on the internal implementation of `instrumentation-client.ts` to actually
    // pass these filters down to mocked telemetry providers or perform the filtering itself before calling them.

    // For a real implementation, you'd check `payload.event.extra.headers` or `payload.user.email`
    mockSentryCaptureException.mockImplementation((error, extra) => {
      // Sentry usually puts extra data in `contexts` or `extra`
      expect(extra?.extra?.details?.Authorization).toBeUndefined();
      expect(extra?.user?.email).toBeUndefined(); // Assuming user context is set
    });

    mockSegmentTrack.mockImplementation((eventName, properties) => {
      expect(properties).not.toHaveProperty('userEmail');
      expect(properties).not.toHaveProperty('sensitiveField');
    });

    const { initTelemetryClient, trackEvent, captureException } = await importClientModule();

    // This is a hypothetical API for configuration. Adjust based on actual client implementation.
    initTelemetryClient({
      projectId: 'test_project',
      environment: 'test',
      dataFilters: [
        { path: 'headers.Authorization', mask: true },
        { path: 'user.email', mask: true },
        { path: 'sensitiveField', remove: true }
      ],
    });

    // Simulate capturing an error that might contain sensitive headers
    const errorWithSensitiveHeader = new Error('Auth Failed');
    // In Sentry, extra details often go into `extra` or `contexts`
    captureException(errorWithSensitiveHeader, { extra: { details: { Authorization: 'Bearer super_secret_token' } }, user: { email: 'user@sensitive.com' } });

    // Simulate tracking an event with sensitive user data
    trackEvent('form_submission', {
      username: 'test_user',
      userEmail: 'another@sensitive.com',
      sensitiveField: 'some_secret_value',
      publicField: 'ok_data',
    });

    expect(mockSentryCaptureException).toHaveBeenCalledOnce();
    expect(mockSegmentTrack).toHaveBeenCalledOnce();

    // Additional explicit checks on the arguments passed to the mocks
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({
          details: expect.not.objectContaining({
            Authorization: expect.any(String),
          }),
        }),
        user: expect.not.objectContaining({
          email: expect.any(String),
        }),
      })
    );

    expect(mockSegmentTrack).toHaveBeenCalledWith(
      'form_submission',
      expect.not.objectContaining({
        userEmail: expect.any(String),
        sensitiveField: expect.any(String),
      })
    );
    expect(mockSegmentTrack).toHaveBeenCalledWith(
      'form_submission',
      expect.objectContaining({
        username: 'test_user',
        publicField: 'ok_data',
      })
    );
  });
});
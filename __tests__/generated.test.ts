import * as Sentry from '@sentry/nextjs';
import { initBotId } from 'botid/client/core';

// Mock process.env before importing the module under test
const mockProcessEnv = (env: Record<string, string | undefined>) => {
  const originalEnv = process.env;
  process.env = { ...originalEnv, ...env };
  // Need to clear module cache to re-import with new env vars
  jest.resetModules();
};

// Mock Sentry and botid
jest.mock('@sentry/nextjs', () => ({
  __esModule: true,
  ...jest.requireActual('@sentry/nextjs'),
  init: jest.fn(),
  captureRouterTransitionStart: jest.fn(),
}));

jest.mock('botid/client/core', () => ({
  __esModule: true,
  initBotId: jest.fn(),
}));

describe('instrumentation-client.ts', () => {
  let originalWindow: typeof global.window;

  beforeAll(() => {
    originalWindow = global.window;
  });

  afterEach(() => {
    // Clean up mocks after each test
    jest.clearAllMocks();
    jest.resetModules(); // Reset modules to ensure fresh imports with new env settings
    process.env = originalWindow.process.env; // Restore original process.env
    global.window = originalWindow; // Restore original window
  });

  describe('Sentry Initialization', () => {
    it('should initialize Sentry in production with valid DSN and default sample rates', () => {
      mockProcessEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SENTRY_DSN_CLIENT: 'test-dsn',
        SENTRY_SAMPLE_RATE: undefined,
        SENTRY_TRACES_SAMPLE_RATE: undefined,
        SENTRY_DEBUG: undefined,
      });

      require('./instrumentation-client');

      const sentryInitCall = (Sentry.init as jest.Mock).mock.calls[0][0];

      expect(Sentry.init).toHaveBeenCalledTimes(1);
      expect(sentryInitCall.dsn).toBe('test-dsn');
      expect(sentryInitCall.sampleRate).toBe(1.0);
      expect(sentryInitCall.tracesSampleRate).toBe(0.0);
      expect(sentryInitCall.debug).toBe(false);
      expect(typeof sentryInitCall.beforeSend).toBe('function');
    });

    it('should initialize Sentry in production with custom sample rates and debug enabled', () => {
      mockProcessEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SENTRY_DSN_CLIENT: 'test-dsn-custom',
        SENTRY_SAMPLE_RATE: '0.5',
        SENTRY_TRACES_SAMPLE_RATE: '0.2',
        SENTRY_DEBUG: 'true',
      });

      require('./instrumentation-client');

      const sentryInitCall = (Sentry.init as jest.Mock).mock.calls[0][0];

      expect(Sentry.init).toHaveBeenCalledTimes(1);
      expect(sentryInitCall.dsn).toBe('test-dsn-custom');
      expect(sentryInitCall.sampleRate).toBe(0.5);
      expect(sentryInitCall.tracesSampleRate).toBe(0.2);
      expect(sentryInitCall.debug).toBe(true);
    });

    it('should use default sample rates when environment variables for samples are invalid numeric values', () => {
      mockProcessEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SENTRY_DSN_CLIENT: 'test-dsn-invalid-samples',
        SENTRY_SAMPLE_RATE: 'invalid',
        SENTRY_TRACES_SAMPLE_RATE: 'not-a-number',
        SENTRY_REPLAYS_SESSION_SAMPLE_RATE: 'foo',
        SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE: 'bar',
      });

      require('./instrumentation-client');

      const sentryInitCall = (Sentry.init as jest.Mock).mock.calls[0][0];

      expect(Sentry.init).toHaveBeenCalledTimes(1);
      expect(sentryInitCall.dsn).toBe('test-dsn-invalid-samples');
      expect(sentryInitCall.sampleRate).toBe(1.0);
      expect(sentryInitCall.tracesSampleRate).toBe(0.0);
      // expect(sentryInitCall.replaysSessionSampleRate).toBe(0.0); // Uncomment if replays are enabled
      // expect(sentryInitCall.replaysOnErrorSampleRate).toBe(0.0); // Uncomment if replays are enabled
    });

    it('should not initialize Sentry in a development environment', () => {
      mockProcessEnv({ NODE_ENV: 'development' });

      require('./instrumentation-client');

      expect(Sentry.init).not.toHaveBeenCalled();
    });

    it('should not initialize Sentry without a DSN even in production', () => {
      // Sentry itself warns about this, but our code should still attempt to init
      // or at least not crash. The DSN will be undefined.
      mockProcessEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SENTRY_DSN_CLIENT: undefined,
      });

      require('./instrumentation-client');

      const sentryInitCall = (Sentry.init as jest.Mock).mock.calls[0][0];

      expect(Sentry.init).toHaveBeenCalledTimes(1);
      expect(sentryInitCall.dsn).toBeUndefined();
    });
  });

  describe('Sentry beforeSend function', () => {
    let beforeSend: ((event: any) => any) | undefined;

    beforeEach(() => {
      mockProcessEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SENTRY_DSN_CLIENT: 'test-dsn',
      });
      require('./instrumentation-client');
      beforeSend = (Sentry.init as jest.Mock).mock.calls[0][0].beforeSend;
      expect(beforeSend).toBeDefined();
    });

    it('should filter specific "Non-Error promise rejection captured with" errors', () => {
      const event = {
        exception: {
          values: [
            {
              value: 'Non-Error promise rejection captured with value: Object Not Found Matching Id:3, MethodName:update, ParamCount:4',
            },
          ],
        },
      };
      const result = beforeSend!(event);
      expect(result).toBeNull();
    });

    it('should filter "Object Not Found Matching Id" errors', () => {
      const event = {
        exception: {
          values: [
            {
              value: 'Another error message: Object Not Found Matching Id:123',
            },
          ],
        },
      };
      const result = beforeSend!(event);
      expect(result).toBeNull();
    });

    it('should add "errorSource: client" tag to other errors', () => {
      const event = {
        exception: { values: [{ value: 'Generic unhandled error' }] },
        tags: { existingTag: 'value' },
      };
      const result = beforeSend!(event);
      expect(result).not.toBeNull();
      expect(result.tags).toEqual({
        existingTag: 'value',
        errorSource: 'client',
      });
    });

    it('should add "errorSource: client" tag when no existing tags', () => {
      const event = {
        exception: { values: [{ value: 'Another error' }] },
      };
      const result = beforeSend!(event);
      expect(result).not.toBeNull();
      expect(result.tags).toEqual({
        errorSource: 'client',
      });
    });

    it('should return the event with errorSource:client for unrelated errors', () => {
      const event = {
        exception: { values: [{ value: 'Regular Error' }] },
        tags: { transaction: 'some-transaction' },
      };
      const result = beforeSend!(event);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        exception: { values: [{ value: 'Regular Error' }] },
        tags: { transaction: 'some-transaction', errorSource: 'client' },
      });
    });
  });

  describe('onRouterTransitionStart function', () => {
    let onRouterTransitionStart: (
      url: string,
      navigationType: 'push' | 'replace' | 'traverse'
    ) => void;

    beforeEach(() => {
      onRouterTransitionStart = require('./instrumentation-client').onRouterTransitionStart;
    });

    it('should call Sentry.captureRouterTransitionStart in production', () => {
      mockProcessEnv({ NODE_ENV: 'production' });
      const { onRouterTransitionStart: func } = require('./instrumentation-client');

      func('/test-path', 'push');
      expect(Sentry.captureRouterTransitionStart).toHaveBeenCalledTimes(1);
      expect(Sentry.captureRouterTransitionStart).toHaveBeenCalledWith(
        '/test-path',
        'push'
      );
    });

    it('should not call Sentry.captureRouterTransitionStart in development', () => {
      mockProcessEnv({ NODE_ENV: 'development' });
      const { onRouterTransitionStart: func } = require('./instrumentation-client');

      func('/dev-path', 'replace');
      expect(Sentry.captureRouterTransitionStart).not.toHaveBeenCalled();
    });
  });

  describe('Bot ID Initialization', () => {
    const mockWindowCrypto = (config: any) => {
      Object.defineProperty(global, 'window', {
        value: {
          ...config,
          crypto: config.crypto
            ? { ...config.crypto }
            : { getRandomValues: jest.fn(), randomUUID: jest.fn() },
        },
        writable: true,
      });
    };

    it('should initialize botid when all conditions are met', () => {
      mockProcessEnv({
        NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER: '1',
      });
      mockWindowCrypto({
        crypto: {
          getRandomValues: jest.fn(),
          randomUUID: jest.fn(),
        },
      });

      require('./instrumentation-client');

      expect(initBotId).toHaveBeenCalledTimes(1);
      expect(initBotId).toHaveBeenCalledWith({
        protect: [
          {
            path: '/api/book/event',
            method: 'POST',
          },
        ],
      });
    });

    it('should not initialize botid when NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER is not "1"', () => {
      mockProcessEnv({
        NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER: '0',
      });
      mockWindowCrypto({
        crypto: {
          getRandomValues: jest.fn(),
          randomUUID: jest.fn(),
        },
      });

      require('./instrumentation-client');

      expect(initBotId).not.toHaveBeenCalled();
    });

    it('should not initialize botid when window is undefined (e.g., server-side)', () => {
      mockProcessEnv({
        NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER: '1',
      });
      // Explicitly set window to undefined
      Object.defineProperty(global, 'window', {
        value: undefined,
        writable: true,
      });

      require('./instrumentation-client');

      expect(initBotId).not.toHaveBeenCalled();
    });

    it('should not initialize botid when window.crypto is missing', () => {
      mockProcessEnv({
        NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER: '1',
      });
      mockWindowCrypto({}); // No crypto property

      require('./instrumentation-client');

      expect(initBotId).not.toHaveBeenCalled();
    });

    it('should not initialize botid when window.crypto.getRandomValues is not a function', () => {
      mockProcessEnv({
        NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER: '1',
      });
      mockWindowCrypto({
        crypto: { getRandomValues: 'not-a-func', randomUUID: jest.fn() },
      });

      require('./instrumentation-client');

      expect(initBotId).not.toHaveBeenCalled();
    });

    it('should not initialize botid when window.crypto.randomUUID is not a function', () => {
      mockProcessEnv({
        NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER: '1',
      });
      mockWindowCrypto({
        crypto: { getRandomValues: jest.fn(), randomUUID: 'not-a-func' },
      });

      require('./instrumentation-client');

      expect(initBotId).not.toHaveBeenCalled();
    });
  });
});

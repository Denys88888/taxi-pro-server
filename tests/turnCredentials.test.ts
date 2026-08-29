// fetchTurnIceServers is two chained HTTP calls to Metered (create a
// credential, then resolve it to the actual relay iceServers array) — the
// env is mocked here so the "configured" path can run in CI without a real
// Metered account, and fetch is mocked so no network call ever happens.
jest.mock('../src/config/env', () => ({
  env: { METERED_SECRET_KEY: 'test-secret-key' },
}));

import { fetchTurnIceServers } from '../src/services/turnCredentials';

describe('fetchTurnIceServers', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('chains create-credential into get-credentials and returns the iceServers array', async () => {
    const iceServers = [
      { urls: 'stun:standard.relay.metered.ca:80' },
      { urls: 'turn:standard.relay.metered.ca:80', username: 'u', credential: 'p' },
    ];
    const fetchMock = jest
      .fn()
      // 1st call: POST create-credential
      .mockResolvedValueOnce({ ok: true, json: async () => ({ apiKey: 'minted-key' }) })
      // 2nd call: GET credentials by that apiKey
      .mockResolvedValueOnce({ ok: true, json: async () => iceServers });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchTurnIceServers();

    expect(result).toEqual(iceServers);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [createUrl] = fetchMock.mock.calls[0] as [string];
    const [getUrl] = fetchMock.mock.calls[1] as [string];
    expect(createUrl).toContain('secretKey=test-secret-key');
    expect(getUrl).toContain('apiKey=minted-key');
  });

  it('returns null, not a throw, when credential creation fails', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 500 }) as unknown as typeof fetch;
    await expect(fetchTurnIceServers()).resolves.toBeNull();
  });

  it('returns null when the create response has no apiKey', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
    await expect(fetchTurnIceServers()).resolves.toBeNull();
  });

  it('returns null when the network throws', async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('offline')) as unknown as typeof fetch;
    await expect(fetchTurnIceServers()).resolves.toBeNull();
  });
});

describe('fetchTurnIceServers without a configured key', () => {
  it('returns null immediately, without calling fetch', async () => {
    jest.resetModules();
    jest.doMock('../src/config/env', () => ({ env: { METERED_SECRET_KEY: undefined } }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fetchTurnIceServers: fetchUnconfigured } = require('../src/services/turnCredentials');
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchUnconfigured()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    jest.dontMock('../src/config/env');
  });
});

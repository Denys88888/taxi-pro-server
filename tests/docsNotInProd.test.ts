// swagger.test.ts pins that the docs ARE served — but it runs with
// NODE_ENV=test, so it would have gone on passing while production published
// the full map of a payments API to anyone who asked (verified live: both
// /api/docs and /api/docs/spec.json answered 200 on the deployed instance).
// The property worth pinning is the one that was actually broken.
//
// env is frozen at module load from process.env, so the app has to be built in
// a fresh module registry with NODE_ENV already flipped. That re-imports the
// whole dependency graph (better-sqlite3, stellar-sdk, firebase-admin), which
// is slow enough that doing it per-case starved the time-window assertions in
// other suites of CPU and made them flake — hence exactly one build here,
// shared by both routes.
describe('the API docs in production', () => {
  const realEnv = process.env.NODE_ENV;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let request: any;

  beforeAll(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    request = require('supertest');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    app = require('../src/app').createApp();
  });

  afterAll(() => {
    process.env.NODE_ENV = realEnv;
    jest.resetModules();
  });

  it.each(['/api/docs', '/api/docs/spec.json'])('does not serve %s', async (route) => {
    expect((await request(app).get(route)).status).toBe(404);
  });
});

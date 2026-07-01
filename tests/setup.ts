// Global test setup: deterministic secrets + in-memory store before any imports.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL = 'error';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initStore } = require('../src/models');
initStore();

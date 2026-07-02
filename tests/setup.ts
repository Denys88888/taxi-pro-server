// Global test setup: deterministic secrets + a fresh in-memory SQLite store.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.LOG_LEVEL = 'error';
process.env.SQLITE_PATH = ':memory:';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initStore } = require('../src/models');
initStore();

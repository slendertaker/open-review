import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { SqliteConfigStore } from '../../src/config/sqlite-store.js';
import { openDb } from '../../src/state/db.js';
import { setSetting } from '../../src/state/config-state.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;

describe('webhook route probes', () => {
  beforeEach(async () => {
    const db = openDb(':memory:');
    const store = new SqliteConfigStore(db, Buffer.alloc(32, 0x44));
    setSetting('webhook_secret', 'test-secret');
    server = await buildServer(store, db, () => {});
  });

  afterEach(async () => {
    await server.close();
  });

  it('GET /webhook returns 200 for GitHub manifest URL validation', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/webhook',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('POST /webhook still rejects unsigned webhook deliveries', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'opened' }),
    });

    expect(res.statusCode).toBe(401);
  });
});

/**
 * Dashboard auth tests -- Plan 02 will turn these green (DSEC-01).
 *
 * Wave 0 scaffold: todos are visible in the vitest output but do not fail the suite.
 * The sentinel assertion ensures vitest discovers this file.
 */

import { describe, it, expect } from 'vitest';

describe('dashboard auth (DSEC-01) -- Plan 02', () => {
  it('scaffold is discovered', () => {
    expect(true).toBe(true);
  });

  it.todo('correct password creates session and redirects to /dashboard');
  it.todo('wrong password returns 401 without creating a session');
  it.todo('unauthenticated GET /dashboard redirects to /login');
  it.todo('session id is regenerated after login (session fixation prevention)');
  it.todo('GET /logout destroys session and redirects to /login');
});

/**
 * Dashboard first-run setup tests -- Plan 02 will turn these green (DSEC-01).
 *
 * Wave 0 scaffold: todos are visible in the vitest output but do not fail the suite.
 * The sentinel assertion ensures vitest discovers this file.
 */

import { describe, it, expect } from 'vitest';

describe('dashboard first-run setup (DSEC-01) -- Plan 02', () => {
  it('scaffold is discovered', () => {
    expect(true).toBe(true);
  });

  it.todo('first-run with no password set redirects all routes to /setup');
  it.todo('valid setup token sets the password hash and redirects to /dashboard');
  it.todo('setup token is invalidated after the password is set');
  it.todo('token-login-over-IP fallback shows a banner when no domain is configured');
});

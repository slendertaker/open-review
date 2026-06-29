/**
 * Dashboard CSRF protection tests -- Plan 02 will turn these green (DSEC-03).
 *
 * Wave 0 scaffold: todos are visible in the vitest output but do not fail the suite.
 * The sentinel assertion ensures vitest discovers this file.
 */

import { describe, it, expect } from 'vitest';

describe('dashboard CSRF protection (DSEC-03) -- Plan 02', () => {
  it('scaffold is discovered', () => {
    expect(true).toBe(true);
  });

  it.todo('POST to a mutating route without _csrf token returns 403');
  it.todo('POST to a mutating route with a valid _csrf token succeeds');
});

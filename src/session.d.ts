/**
 * Fastify session type augmentation for Open Review.
 *
 * Declares the session keys used by the dashboard so @fastify/session's
 * typed get/set methods accept them without requiring `any` casts.
 */

declare module 'fastify' {
  interface Session {
    /** True when the operator has successfully authenticated. */
    authenticated?: boolean;
    /** Flash message key for displaying errors after redirect. */
    flashError?: string;
  }
}

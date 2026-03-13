/**
 * Host-level integration test cases.
 *
 * @packageDocumentation
 */

export type HostTestCase = readonly [string, () => Promise<void>];

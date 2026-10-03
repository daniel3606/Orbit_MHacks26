/**
 * Checks the exact web APIs the SpacetimeDB SDK (2.10.2) uses, in the running
 * JS engine. Results on a simulator do not stand in for a physical iPhone run.
 */
export type CheckResult = { name: string; ok: boolean; detail: string };

function check(name: string, fn: () => string | true): CheckResult {
  try {
    const result = fn();
    return result === true ? { name, ok: true, detail: 'ok' } : { name, ok: false, detail: result };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function runRuntimeChecks(): CheckResult[] {
  const g = globalThis as Record<string, unknown>;
  return [
    {
      name: 'JS engine',
      ok: true,
      detail: typeof g.HermesInternal !== 'undefined' ? 'Hermes' : 'not Hermes',
    },
    check('URL relative resolution', () => {
      const u = new URL('v1/identity/websocket-token', 'ws://example.test:3000');
      return u.href === 'ws://example.test:3000/v1/identity/websocket-token' || u.href;
    }),
    check('URL protocol setter (ws → http)', () => {
      const u = new URL('v1/x', 'ws://example.test:3000');
      u.protocol = 'http:';
      return u.href === 'http://example.test:3000/v1/x' || u.href;
    }),
    check('URL searchParams.set', () => {
      const u = new URL('v1/database/orbit/subscribe', 'ws://example.test:3000');
      u.searchParams.set('token', 'a.b+c');
      u.searchParams.set('compression', 'None');
      return u.toString() === 'ws://example.test:3000/v1/database/orbit/subscribe?token=a.b%2Bc&compression=None' || u.toString();
    }),
    check('TextDecoder (UTF-8)', () => {
      const s = new TextDecoder('utf-8').decode(new Uint8Array([0x4f, 0x72, 0x62, 0x69, 0x74, 0x20, 0xe2, 0x9c, 0x93]));
      return s === 'Orbit ✓' || s;
    }),
    check('TextEncoder (UTF-8)', () => {
      const bytes = new TextEncoder().encode('✓');
      return (bytes.length === 3 && bytes[0] === 0xe2) || `length ${bytes.length}`;
    }),
    check('BigInt u64 arithmetic', () => {
      const v = 2n ** 64n - 1n;
      return v.toString() === '18446744073709551615' || v.toString();
    }),
    check('WebSocket global', () => (typeof WebSocket === 'function' ? true : 'missing')),
    check('Headers / fetch globals', () => (typeof Headers === 'function' && typeof fetch === 'function') || 'missing'),
    {
      name: 'DecompressionStream',
      ok: true,
      detail: typeof g.DecompressionStream === 'undefined' ? 'absent → compression disabled (expected)' : 'present',
    },
  ];
}

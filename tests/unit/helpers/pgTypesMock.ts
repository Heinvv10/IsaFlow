/**
 * The `types` half of a `vi.mock('pg', ...)` factory.
 *
 * Any module that builds its own pg Pool imports `@/lib/pgTypes` for its side
 * effect, and that module calls `pg.types.setTypeParser(...)` at import time.
 * A pg mock that supplies only `Pool` therefore throws
 * "Cannot read properties of undefined (reading 'setTypeParser')" before the
 * test body runs.
 *
 * Spread this into the mock's `default` (and top level, where the factory
 * exposes named exports too) so the side-effect import is satisfied. The
 * recorded calls are inspectable if a test wants to assert the DATE parser was
 * registered; most just need it not to throw.
 */
import { vi } from 'vitest';

export function pgTypesMock() {
  return {
    types: {
      setTypeParser: vi.fn(),
      // 1082 is the real OID for DATE; kept accurate so an assertion on the
      // registered OID means something.
      builtins: { DATE: 1082 },
    },
  };
}

import { describe, expect, test } from 'bun:test';
import { Data, Effect, Schedule } from 'effect';

class Transient extends Data.TaggedError('Transient')<Record<string, never>> {}
class Permanent extends Data.TaggedError('Permanent')<Record<string, never>> {}

describe('Effect v4 (runtime na Bun)', () => {
  test('retry z Schedule.spaced ponawia aż do sukcesu', async () => {
    let attempts = 0;
    const program = Effect.suspend(() => {
      attempts++;
      return attempts < 3 ? Effect.fail(new Transient({})) : Effect.succeed('ok');
    }).pipe(Effect.retry({ times: 5, schedule: Schedule.spaced('1 millis') }));

    const res = await Effect.runPromise(program);
    expect(res).toBe('ok');
    expect(attempts).toBe(3);
  });

  test('while: nie ponawia błędów permanentnych', async () => {
    let attempts = 0;
    const program = Effect.suspend((): Effect.Effect<string, Transient | Permanent> => {
      attempts++;
      return Effect.fail(new Permanent({}));
    }).pipe(
      Effect.retry({ times: 3, while: (e) => e._tag === 'Transient' }),
      Effect.catchTag('Permanent', () => Effect.succeed('obsłużony')),
    );
    const res = await Effect.runPromise(program);
    expect(res).toBe('obsłużony');
    expect(attempts).toBe(1);
  });

  test('gen + sleep + Ref (pacing/cooldown jak w nfz.ts)', async () => {
    const ref = yieldableRef();
    const program = Effect.gen(function* () {
      yield* Effect.sleep('1 millis');
      yield* ref.update((t) => Math.max(t, 10));
      return yield* ref.get;
    });
    expect(await Effect.runPromise(program)).toBe(10);
  });
});

// pomocniczy Ref poza Effect.gen — ten sam wzorzec co modułowy cooldown w nfz.ts
import { Ref } from 'effect';
function yieldableRef() {
  const r = Effect.runSync(Ref.make(0));
  return {
    update: (f: (t: number) => number) => Ref.update(r, f),
    get: Ref.get(r),
  };
}

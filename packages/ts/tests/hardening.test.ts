import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capability } from "../src/capability.ts";
import { KajiConfigurationError } from "../src/errors.ts";
import { createKaji } from "../src/kaji.ts";
import type { ExecutionResult, ExecutionEvidence } from "../src/execution/result.ts";
import { memoryStore } from "../src/store/memory.ts";
import type { ExecutionStore } from "../src/store/store.ts";
import { baseRequest, refundSchema } from "./execution-fixtures.ts";

// Callers outside the type system (plain JS, `any`) can return anything.
const untyped = <T>(value: unknown) => value as T;

describe("authorize fails closed", () => {
  for (const [label, value] of [
    ["undefined", undefined],
    ["null", null],
    ["a truthy string", "yes"],
    ["1", 1],
  ] as const) {
    it(`denies when authorize() returns ${label}`, async () => {
      const execute = vi.fn();
      const refund = capability({
        name: "payments.refund",
        input: refundSchema,
        authorize: () => untyped<boolean>(value),
        execute,
      });

      const result = await createKaji({ store: memoryStore() }).execute(refund, baseRequest());

      expect(result.status).toBe("denied");
      expect(execute).not.toHaveBeenCalled();
    });
  }

  it("still allows an explicit true", async () => {
    const refund = capability({
      name: "payments.refund",
      input: refundSchema,
      authorize: async () => true,
      execute: () => "ok",
    });

    const result = await createKaji({ store: memoryStore() }).execute(refund, baseRequest());

    expect(result.status).toBe("succeeded");
  });
});

describe("approval fails closed", () => {
  it("requires approval when the policy returns a Promise, and absorbs its rejection", async () => {
    const approve = vi.fn(async () => ({ approved: false }));
    const execute = vi.fn();
    const refund = capability({
      name: "payments.refund",
      input: refundSchema,
      authorize: () => true,
      approval: () => untyped<boolean>(Promise.reject(new Error("policy failed"))),
      execute,
    });

    const result = await createKaji({ store: memoryStore(), approve }).execute(
      refund,
      baseRequest(),
    );

    expect(result.status).toBe("rejected");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  for (const [label, value] of [
    ["undefined", undefined],
    ["null", null],
    ["a truthy value", 1],
  ] as const) {
    it(`requires approval when the policy returns ${label}`, async () => {
      const approve = vi.fn(async () => ({ approved: false }));
      const refund = capability({
        name: "payments.refund",
        input: refundSchema,
        authorize: () => true,
        approval: () => untyped<boolean>(value),
        execute: vi.fn(),
      });

      const result = await createKaji({ store: memoryStore(), approve }).execute(
        refund,
        baseRequest(),
      );

      expect(result.status).toBe("rejected");
      expect(approve).toHaveBeenCalledTimes(1);
    });
  }

  it("skips approval only for an explicit false", async () => {
    const approve = vi.fn(async () => ({ approved: false }));
    const refund = capability({
      name: "payments.refund",
      input: refundSchema,
      authorize: () => true,
      approval: () => false,
      execute: () => "ok",
    });

    const result = await createKaji({ store: memoryStore(), approve }).execute(
      refund,
      baseRequest(),
    );

    expect(result.status).toBe("succeeded");
    expect(approve).not.toHaveBeenCalled();
  });

  it("settles a throwing approval policy as rejected and does not leave the claim open", async () => {
    const store = memoryStore();
    const execute = vi.fn();
    const refund = capability({
      name: "payments.refund",
      input: refundSchema,
      authorize: () => true,
      approval: () => {
        throw new Error("policy bug");
      },
      execute,
    });
    const kaji = createKaji({ store, approve: async () => ({ approved: true }) });

    const first = await kaji.execute(refund, baseRequest());
    // A duplicate must observe the settled result, not hang on an open claim.
    const second = await kaji.execute(refund, baseRequest());

    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("timeoutMs validation", () => {
  for (const timeoutMs of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "5" as never]) {
    it(`rejects timeoutMs ${String(timeoutMs)} at createKaji()`, () => {
      expect(() => createKaji({ store: memoryStore(), timeoutMs })).toThrow(KajiConfigurationError);
    });
  }

  it("accepts a positive timeout up to the setTimeout maximum", () => {
    expect(() => createKaji({ store: memoryStore(), timeoutMs: 1 })).not.toThrow();
    expect(() => createKaji({ store: memoryStore(), timeoutMs: 2 ** 31 - 1 })).not.toThrow();
    expect(() => createKaji({ store: memoryStore() })).not.toThrow();
  });
});

describe("a duplicate waiting on an in-progress request", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function stuckStore(): ExecutionStore {
    // Models a claim whose owner crashed: `existing` with an outcome that
    // never resolves.
    return {
      claim: async () => ({ status: "existing", outcome: new Promise(() => {}) }),
      record: async () => {},
    };
  }

  const refund = (execute = vi.fn()) =>
    capability({ name: "payments.refund", input: refundSchema, authorize: () => true, execute });

  it("stops waiting when its own signal aborts after the claim resolved, as unknown", async () => {
    const controller = new AbortController();
    let claimed!: () => void;
    const claimReturned = new Promise<void>((resolve) => (claimed = resolve));
    const store: ExecutionStore = {
      claim: async () => {
        queueMicrotask(claimed);
        return { status: "existing", outcome: new Promise(() => {}) };
      },
      record: async () => {},
    };
    const kaji = createKaji({ store });

    const pending = kaji.execute(refund(), baseRequest({ signal: controller.signal }));
    await claimReturned;
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const result = await pending;

    // The original may still commit, so the waiter must not claim "nothing ran".
    expect(result.status).toBe("unknown");
    expect(result.evidence.inputFingerprint).not.toBe("");
  });

  it("returns the settled outcome when it is already available as the signal aborts", async () => {
    const controller = new AbortController();
    const outcome: ExecutionResult<unknown> = {
      status: "succeeded",
      result: "saved",
      evidence: {} as ExecutionEvidence,
    };
    const store: ExecutionStore = {
      claim: async () => {
        controller.abort();
        return { status: "existing", outcome: Promise.resolve(outcome) };
      },
      record: async () => {},
    };

    const result = await createKaji({ store }).execute(
      refund(),
      baseRequest({ signal: controller.signal }),
    );

    expect(result).toBe(outcome);
  });

  it("stops waiting when timeoutMs elapses", async () => {
    const kaji = createKaji({ store: stuckStore(), timeoutMs: 1_000 });

    const pending = kaji.execute(refund(), baseRequest());
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).status).toBe("unknown");
  });

  it("does not affect the original request, which still settles and is replayable", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const execute = vi.fn(async () => {
      await gate;
      return "done";
    });
    const kaji = createKaji({ store });
    const cap = refund(execute);
    const controller = new AbortController();

    const original = kaji.execute(cap, baseRequest());
    await vi.advanceTimersByTimeAsync(0);
    const waiter = kaji.execute(cap, baseRequest({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    expect((await waiter).status).toBe("unknown");
    release();
    expect((await original).status).toBe("succeeded");
    expect((await kaji.execute(cap, baseRequest())).status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns the real outcome when it settles before an abort", async () => {
    const controller = new AbortController();
    const outcome: ExecutionResult<unknown> = {
      status: "succeeded",
      result: "saved",
      evidence: {} as ExecutionEvidence,
    };
    const store: ExecutionStore = {
      claim: async () => ({ status: "existing", outcome: Promise.resolve(outcome) }),
      record: async () => {},
    };

    const result = await createKaji({ store }).execute(
      refund(),
      baseRequest({ signal: controller.signal }),
    );

    expect(result).toBe(outcome);
  });

  it("stops waiting when the signal is already aborted as the claim returns and nothing settles", async () => {
    const controller = new AbortController();
    const store: ExecutionStore = {
      claim: async () => {
        controller.abort();
        return { status: "existing", outcome: new Promise(() => {}) };
      },
      record: async () => {},
    };

    const result = await createKaji({ store }).execute(
      refund(),
      baseRequest({ signal: controller.signal }),
    );

    expect(result.status).toBe("unknown");
  });

  it("removes its abort listener once the wait ends", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const store: ExecutionStore = {
      claim: async () => ({
        status: "existing",
        outcome: Promise.resolve({ status: "succeeded", result: 1, evidence: {} as never }),
      }),
      record: async () => {},
    };

    await createKaji({ store }).execute(refund(), baseRequest({ signal: controller.signal }));

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("fail-closed handling of malformed approve() decisions", () => {
  const cap = () =>
    capability({
      name: "payments.refund",
      input: refundSchema,
      authorize: () => true,
      approval: () => true,
      execute: vi.fn(() => "ran"),
    });

  it("reads `approved` once, so a shape-shifting getter cannot flip a rejection", async () => {
    let reads = 0;
    const decision = {
      get approved() {
        return reads++ === 0 ? false : "yes";
      },
    };
    const c = cap();

    const result = await createKaji({
      store: memoryStore(),
      approve: async () => untyped(decision),
    }).execute(c, baseRequest());

    expect(result.status).toBe("rejected");
  });

  it("settles rejected, not a thrown error, when `approved` throws", async () => {
    const store = memoryStore();
    const decision = {
      get approved(): boolean {
        throw new Error("boom");
      },
    };
    const kaji = createKaji({ store, approve: async () => untyped(decision) });
    const c = cap();

    expect((await kaji.execute(c, baseRequest())).status).toBe("rejected");
    // The claim was settled, so a duplicate returns instead of hanging.
    expect((await kaji.execute(c, baseRequest())).status).toBe("rejected");
  });

  it("rejects non-boolean `approved` values", async () => {
    for (const approved of ["true", 1, null, undefined]) {
      const result = await createKaji({
        store: memoryStore(),
        approve: async () => untyped({ approved }),
      }).execute(cap(), baseRequest());

      expect(result.status).toBe("rejected");
    }
  });
});

describe("unexpected errors between claim and execute", () => {
  it("settles rejected when approve() returns a hostile thenable, leaving no open claim", async () => {
    const store = memoryStore();
    const cap = capability({
      name: "payments.refund",
      input: refundSchema,
      authorize: () => true,
      approval: () => true,
      execute: vi.fn(),
    });
    // A throwing `then` makes approve() blow up inside Kaji's own await.
    const kaji = createKaji({
      store,
      approve: () =>
        untyped({
          // oxlint-disable-next-line unicorn/no-thenable
          then() {
            throw new Error("hostile thenable");
          },
        }),
    });

    const first = await kaji.execute(cap, baseRequest());
    const second = await kaji.execute(cap, baseRequest());

    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
  });

  it("settles failed when something unexpected throws after the claim", async () => {
    // A caller-supplied signal-like object whose `aborted` getter starts
    // throwing once the request has been claimed.
    let reads = 0;
    const signal = {
      get aborted(): boolean {
        if (++reads > 2) throw new Error("getter failed");
        return false;
      },
      addEventListener() {},
      removeEventListener() {},
    };
    const store = memoryStore();
    const execute = vi.fn();
    const cap = capability({
      name: "payments.refund",
      input: refundSchema,
      authorize: () => true,
      execute,
    });
    const kaji = createKaji({ store });

    const first = await kaji.execute(cap, baseRequest({ signal }));
    const second = await kaji.execute(cap, baseRequest());

    expect(first.status).toBe("failed");
    expect(second.status).toBe("failed"); // settled, so the duplicate does not hang
    expect(execute).not.toHaveBeenCalled();
  });

  it("settles unknown when classifying a thrown value itself throws", async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap");
        },
      },
    );
    const store = memoryStore();
    const cap = capability({
      name: "payments.refund",
      input: refundSchema,
      authorize: () => true,
      execute: () => {
        throw hostile;
      },
    });
    const kaji = createKaji({ store });

    expect((await kaji.execute(cap, baseRequest())).status).toBe("unknown");
    expect((await kaji.execute(cap, baseRequest())).status).toBe("unknown");
  });
});

describe("misc hardening", () => {
  it("treats approval: null as no policy and rejects a non-function approval", () => {
    expect(() =>
      capability({
        name: "x",
        input: refundSchema,
        authorize: () => true,
        approval: untyped<never>(null),
        execute: () => 1,
      }),
    ).not.toThrow();
    expect(() =>
      capability({
        name: "x",
        input: refundSchema,
        authorize: () => true,
        approval: untyped<never>("yes"),
        execute: () => 1,
      }),
    ).toThrow(/approval must be a function/);
  });

  it("ignores later mutation of options.timeoutMs", async () => {
    const options = { store: memoryStore(), timeoutMs: 60_000 };
    const kaji = createKaji(options);
    (options as { timeoutMs: number }).timeoutMs = 1;
    const cap = capability({
      name: "x",
      input: refundSchema,
      authorize: () => true,
      execute: async (_input, context) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return context.signal.aborted;
      },
    });

    const result = await kaji.execute(cap, baseRequest());

    // With the mutated value in effect the signal would be aborted by now.
    expect(result.status === "succeeded" && result.result).toBe(false);
  });

  it("runs an approval: null capability without approval", async () => {
    const cap = capability({
      name: "x",
      input: refundSchema,
      authorize: () => true,
      approval: untyped<never>(null),
      execute: () => "ok",
    });

    const result = await createKaji({ store: memoryStore() }).execute(cap, baseRequest());

    expect(result.status).toBe("succeeded");
  });

  it("checks the signal again after the claim, before authorize", async () => {
    const controller = new AbortController();
    const store = memoryStore();
    const realClaim = store.claim.bind(store);
    store.claim = async (claim) => {
      const result = await realClaim(claim);
      controller.abort();
      return result;
    };
    const authorize = vi.fn(() => true);
    const cap = capability({ name: "x", input: refundSchema, authorize, execute: () => "ok" });

    const result = await createKaji({ store }).execute(
      cap,
      baseRequest({ signal: controller.signal }),
    );

    expect(result.status).toBe("cancelled");
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe("a request cancelled before the claim leaves the key free", () => {
  it("lets the same key run normally afterwards", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(() => "ok");
    const cap = capability({
      name: "payments.refund",
      input: refundSchema,
      authorize: () => true,
      execute,
    });
    const kaji = createKaji({ store: memoryStore() });

    const first = await kaji.execute(cap, baseRequest({ signal: controller.signal }));
    const retry = await kaji.execute(cap, baseRequest());

    expect(first.status).toBe("cancelled");
    expect(retry.status).toBe("succeeded");
  });
});

describe("a request cancelled after the claim keeps its key", () => {
  it("returns the saved cancelled result when retried with the same key", async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    const cap = capability({
      name: "payments.refund",
      input: refundSchema,
      authorize: () => {
        controller.abort();
        return true;
      },
      execute,
    });
    const kaji = createKaji({ store: memoryStore() });

    const first = await kaji.execute(cap, baseRequest({ signal: controller.signal }));
    const retry = await kaji.execute(cap, baseRequest());
    const fresh = await kaji.execute(cap, baseRequest({ idempotencyKey: "key_2" }));
    // Only a new key starts a new request; this one runs normally.

    expect(first.status).toBe("cancelled");
    expect(retry.status).toBe("cancelled");
    expect(fresh.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

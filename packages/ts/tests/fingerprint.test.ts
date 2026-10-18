import { describe, expect, it } from "vitest";
import { fingerprintInput, UnfingerprintableValueError } from "../src/store/fingerprint.ts";

describe("fingerprintInput", () => {
  it("produces identical fingerprints for identical validated values", () => {
    const a = fingerprintInput("payments.refund", { paymentId: "pay_1", amount: 10 });
    const b = fingerprintInput("payments.refund", { paymentId: "pay_1", amount: 10 });

    expect(a).toBe(b);
  });

  it("is not affected by object key insertion order", () => {
    const a = fingerprintInput("payments.refund", { amount: 10, paymentId: "pay_1" });
    const b = fingerprintInput("payments.refund", { paymentId: "pay_1", amount: 10 });

    expect(a).toBe(b);
  });

  it("changes when the input is materially different", () => {
    const a = fingerprintInput("payments.refund", { paymentId: "pay_1", amount: 10 });
    const b = fingerprintInput("payments.refund", { paymentId: "pay_1", amount: 20 });

    expect(a).not.toBe(b);
  });

  it("preserves array order", () => {
    const a = fingerprintInput("batch.process", { ids: ["a", "b"] });
    const b = fingerprintInput("batch.process", { ids: ["b", "a"] });

    expect(a).not.toBe(b);
  });

  it("preserves primitive type distinctions", () => {
    const asString = fingerprintInput("payments.refund", { amount: "10" });
    const asNumber = fingerprintInput("payments.refund", { amount: 10 });

    expect(asString).not.toBe(asNumber);
  });

  it("rejects unsupported durable values clearly", () => {
    expect(() => fingerprintInput("payments.refund", { amount: () => 10 })).toThrow(
      UnfingerprintableValueError,
    );
    expect(() => fingerprintInput("payments.refund", { amount: Number.NaN })).toThrow(
      UnfingerprintableValueError,
    );
    expect(() => fingerprintInput("payments.refund", [undefined])).toThrow(
      UnfingerprintableValueError,
    );
    expect(() => fingerprintInput("payments.refund", undefined)).toThrow(
      UnfingerprintableValueError,
    );
  });

  it("treats an undefined property as absent", () => {
    const withUndefined = fingerprintInput("payments.refund", { amount: 10, note: undefined });
    const without = fingerprintInput("payments.refund", { amount: 10 });

    expect(withUndefined).toBe(without);
  });

  it("distinguishes Date values and rejects an invalid Date", () => {
    const a = fingerprintInput("t", { at: new Date("2020-01-01T00:00:00Z") });
    const b = fingerprintInput("t", { at: new Date("2030-01-01T00:00:00Z") });
    const same = fingerprintInput("t", { at: new Date("2020-01-01T00:00:00Z") });

    expect(a).not.toBe(b);
    expect(a).toBe(same);
    expect(() => fingerprintInput("t", { at: new Date("nope") })).toThrow(
      UnfingerprintableValueError,
    );
  });

  it("does not confuse a Date, a string, and a number", () => {
    const iso = "2020-01-01T00:00:00.000Z";
    const date = fingerprintInput("t", { v: new Date(iso) });
    const string = fingerprintInput("t", { v: iso });
    const number = fingerprintInput("t", { v: new Date(iso).getTime() });

    expect(new Set([date, string, number]).size).toBe(3);
  });

  it("supports bigint without confusing it with a number or string", () => {
    const big = fingerprintInput("t", { n: 1n });
    const num = fingerprintInput("t", { n: 1 });
    const str = fingerprintInput("t", { n: "1n" });

    expect(new Set([big, num, str]).size).toBe(3);
  });

  it("rejects built-ins whose state would otherwise collapse to {}", () => {
    const values = [
      new Map([[1, 2]]),
      new Set([1]),
      /x/,
      Promise.resolve(),
      new URL("https://example.com/a"),
      new URLSearchParams("a=1"),
      new Headers({ a: "1" }),
      new Blob(["x"]),
      new File(["x"], "a.txt"),
      Object(1),
      new Error("x"),
      new ArrayBuffer(2),
      new DataView(new ArrayBuffer(2)),
      new WeakMap(),
    ];
    for (const value of values) {
      expect(() => fingerprintInput("t", { v: value })).toThrow(UnfingerprintableValueError);
    }
  });

  it("still compares objects with a custom toStringTag by their own properties", () => {
    class Decimal {
      readonly d: number[];
      constructor(d: number[]) {
        this.d = d;
      }
      get [Symbol.toStringTag]() {
        return "Decimal";
      }
    }

    const five = fingerprintInput("t", { amount: new Decimal([5]) });
    const six = fingerprintInput("t", { amount: new Decimal([6]) });

    expect(five).not.toBe(six);
  });

  it("rejects objects whose state would collapse to {}", () => {
    class Money {
      // oxlint-disable-next-line eslint/no-unused-private-class-members
      #cents: number;
      constructor(cents: number) {
        this.#cents = cents;
      }
    }
    class FakeMap extends Map<unknown, unknown> {
      get [Symbol.toStringTag]() {
        return "Object";
      }
    }
    const swapped = new Map([[1, 2]]);
    Object.setPrototypeOf(swapped, Object.prototype);

    for (const value of [new Money(5), new FakeMap([[1, 2]]), swapped]) {
      expect(() => fingerprintInput("t", { v: value })).toThrow(UnfingerprintableValueError);
    }
  });

  it("rejects built-ins from another realm and spoofed Date tags", async () => {
    const vm = (await import(["node", "vm"].join(":"))) as {
      runInNewContext: (code: string) => unknown;
    };
    const spoofed = { [Symbol.toStringTag]: "Date" };

    for (const value of [
      vm.runInNewContext("new Map([[1, 2]])"),
      vm.runInNewContext("new DataView(new ArrayBuffer(2))"),
      spoofed,
    ]) {
      expect(() => fingerprintInput("t", { v: value })).toThrow(UnfingerprintableValueError);
    }
  });

  it("keeps typed arrays distinguishable by content", () => {
    const a = fingerprintInput("t", { v: new Uint8Array([1, 2]) });
    const b = fingerprintInput("t", { v: new Uint8Array([1, 3]) });

    expect(a).not.toBe(b);
  });

  it("recognizes a Date from another realm", async () => {
    const vm = (await import(["node", "vm"].join(":"))) as {
      runInNewContext: (code: string) => unknown;
    };
    const foreign = vm.runInNewContext("new Date('2020-01-01T00:00:00Z')");
    const local = new Date("2020-01-01T00:00:00Z");

    expect(fingerprintInput("t", { at: foreign })).toBe(fingerprintInput("t", { at: local }));
  });

  it("rejects circular references instead of overflowing the stack", () => {
    const a: Record<string, unknown> = {};
    a.self = a;

    expect(() => fingerprintInput("t", a)).toThrow(UnfingerprintableValueError);
  });

  it("allows the same object to appear twice without a cycle", () => {
    const shared = { x: 1 };

    expect(() => fingerprintInput("t", { a: shared, b: shared })).not.toThrow();
  });

  it("does not depend on random or process-specific data", () => {
    const first = fingerprintInput("payments.refund", { paymentId: "pay_1", amount: 10 });
    const second = fingerprintInput("payments.refund", { paymentId: "pay_1", amount: 10 });

    expect(first).toBe(second);
  });
});

/**
 * Thrown when a value falls outside the durable value domain — plain
 * JSON-shaped data — and cannot be fingerprinted deterministically.
 * Capability input is schema-validated application data, so this is the
 * natural boundary: it excludes functions, symbols, and other values a
 * schema would not normally produce.
 */
export class UnfingerprintableValueError extends Error {
  constructor(reason: string) {
    super(`Cannot fingerprint input: ${reason}`);
    this.name = "UnfingerprintableValueError";
  }
}

/**
 * Produces a deterministic string for one capability's validated input.
 *
 * Object key order must not affect the result — two semantically identical
 * inputs must fingerprint identically regardless of how their keys were
 * constructed — so this canonicalizes objects by sorting keys before
 * serializing, rather than relying on `JSON.stringify`'s insertion order.
 */
export function fingerprintInput(capability: string, input: unknown): string {
  return `${capability}:${canonicalize(input)}`;
}

function canonicalize(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new UnfingerprintableValueError(`non-finite number ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (typeof value !== "object") {
    throw new UnfingerprintableValueError(`unsupported value of type ${typeof value}`);
  }
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Date]") {
    // Brand check, so a Date from another realm is recognized too.
    let time: number;
    try {
      time = Date.prototype.getTime.call(value);
    } catch {
      throw new UnfingerprintableValueError("object claims to be a Date but is not");
    }
    if (Number.isNaN(time)) {
      throw new UnfingerprintableValueError("invalid Date");
    }
    return `Date(${new Date(time).toISOString()})`;
  }
  // Built-ins keep their state in internal slots, not enumerable own
  // properties, so canonicalizing them as objects would collapse different
  // values to `{}` and make different inputs look identical. They are
  // detected by brand check (immune to a spoofed toStringTag or a swapped
  // prototype) and by tag.
  const builtin = builtinKind(value, tag);
  if (builtin !== undefined) {
    throw new UnfingerprintableValueError(
      `unsupported ${builtin}; convert it to plain data in your schema`,
    );
  }
  // Arrays, typed arrays, and objects (including class instances and
  // objects with a custom toStringTag, such as decimal types) are compared
  // by their enumerable own properties. An object that is not plain and has
  // none carries its state elsewhere (for example in #private fields), so
  // it cannot be compared.
  if (
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !isPlainObject(value) &&
    Object.keys(value).length === 0
  ) {
    throw new UnfingerprintableValueError(
      "unsupported object with no enumerable properties; convert it to plain data in your schema",
    );
  }
  if (ancestors.has(value)) {
    throw new UnfingerprintableValueError("circular reference");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
    }
    // An `undefined` property is treated as absent, matching how JSON and
    // most schema libraries treat an omitted optional field.
    const keys = Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort();
    const entries = keys.map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], ancestors)}`,
    );
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

const BUILTIN_TAGS = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "RegExp",
  "Promise",
  "Error",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "BigInt",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "Arguments",
  "File",
  "Blob",
  "URL",
  "URLSearchParams",
  "Headers",
  "Request",
  "Response",
  "FormData",
]);

function builtinKind(value: object, tag: string): string | undefined {
  const name = tag.slice(8, -1);
  if (BUILTIN_TAGS.has(name)) {
    return name;
  }
  const brands: ReadonlyArray<readonly [string, () => unknown]> = [
    ["Map", () => Map.prototype.has.call(value, undefined)],
    ["Set", () => Set.prototype.has.call(value, undefined)],
    ["WeakMap", () => WeakMap.prototype.has.call(value, {})],
    ["WeakSet", () => WeakSet.prototype.has.call(value, {})],
    ["RegExp", () => Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get?.call(value)],
    [
      "DataView",
      () => Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get?.call(value),
    ],
    [
      "ArrayBuffer",
      () => Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get?.call(value),
    ],
  ];
  for (const [kind, probe] of brands) {
    try {
      probe();
      return kind;
    } catch {
      // not this kind
    }
  }
  return undefined;
}

/** True for `{}`-style objects, including ones from another realm. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || Object.getPrototypeOf(proto) === null;
}

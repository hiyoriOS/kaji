import type { ExecutionContext } from "./execution/context.ts";
import type { SchemaOutput, StandardSchemaV1 } from "./schema.ts";

/**
 * A request to authorize or require approval for one capability execution.
 * Kept inline rather than named because it is not part of the store contract
 * and does not need to be constructed by callers.
 */
type PrincipalRequest<Input> = {
  readonly principalId: string;
  readonly input: Input;
};

/**
 * Declares one application action: its validated input contract,
 * authorization/approval rules, and the function Kaji will eventually
 * execute. A capability does not execute itself; the executor owns that.
 *
 * `input` is any Standard Schema V1-compatible schema — Zod, Valibot,
 * ArkType, or a hand-written implementation. Callbacks receive the schema's
 * validated OUTPUT type (SchemaOutput<Schema>), so a transformed schema's
 * output — not its input type — flows through authorize, approval, and
 * execute, inferred without explicit generics.
 */
export type CapabilityDefinition<Schema extends StandardSchemaV1, Result> = {
  readonly name: string;
  readonly input: Schema;
  readonly authorize: (
    request: PrincipalRequest<SchemaOutput<Schema>>,
  ) => boolean | Promise<boolean>;
  readonly approval?: (request: PrincipalRequest<SchemaOutput<Schema>>) => boolean;
  readonly execute: (
    input: SchemaOutput<Schema>,
    context: ExecutionContext,
  ) => Result | Promise<Result>;
};

/**
 * The declared capability, as frozen by docs/api.md.
 *
 * Only `name` is public today. `Output` and `Result` are retained as type
 * parameters (unused at this field) because `Kaji.execute()` needs
 * `Capability<Output, Result>` to recover both types; removing them now
 * would force that API to redesign this type. The unused-type-parameter
 * warning this produces is suppressed in .oxlintrc.json for this file.
 */
export type Capability<Output, Result> = {
  readonly name: string;
};

/**
 * Defines one application action that Kaji can later execute safely.
 *
 * `capability()` is the single canonical constructor. It validates its own
 * declaration (name, hooks, input schema) at construction time; it never
 * invokes `authorize`, `approval`, or `execute` itself, and never runs the
 * schema's validation at construction time.
 */
export function capability<Schema extends StandardSchemaV1, Result>(
  definition: CapabilityDefinition<Schema, Result>,
): Capability<SchemaOutput<Schema>, Result> {
  const name = definition.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("capability() requires a non-empty name.");
  }
  if (typeof definition.authorize !== "function") {
    throw new Error("capability() requires an authorize function.");
  }

  if (
    definition.approval !== undefined &&
    definition.approval !== null &&
    typeof definition.approval !== "function"
  ) {
    throw new Error("capability() approval must be a function when provided.");
  }

  // Minimal structural check only: the schema must look like Standard
  // Schema V1. The protocol requires only a `~standard` property — the
  // holder itself may be an object or a callable (ArkType's Type is a
  // callable). Vendor internals and additional fields are never
  // inspected, and validate is never invoked here.
  const input: unknown = definition.input;
  const standard =
    input !== null && (typeof input === "object" || typeof input === "function")
      ? (input as { "~standard"?: StandardSchemaV1["~standard"] })["~standard"]
      : undefined;
  if (standard === undefined || standard === null) {
    throw new Error(
      'capability() requires input to be a Standard Schema (missing "~standard" property).',
    );
  }
  if (standard.version !== 1) {
    throw new Error("capability() input schema must implement Standard Schema version 1.");
  }
  if (typeof standard.validate !== "function") {
    throw new Error('capability() input schema must provide a "~standard.validate" function.');
  }

  return Object.freeze({
    name,
    input: definition.input,
    authorize: definition.authorize,
    approval: definition.approval,
    execute: definition.execute,
  });
}

/**
 * Recovers the full declaration from a `Capability`. The public
 * `Capability<Output, Result>` type only advertises `name`, but the object
 * `capability()` returns always carries `input`/`authorize`/`approval`/
 * `execute` — the executor is their one legitimate reader.
 *
 * The recovered schema is widened to `StandardSchemaV1<unknown, Output>`:
 * execution only needs the validation protocol and the validated output
 * type, not the schema's original input type.
 */
export function capabilityDefinition<Output, Result>(
  capability: Capability<Output, Result>,
): CapabilityDefinition<StandardSchemaV1<unknown, Output>, Result> {
  return capability as unknown as CapabilityDefinition<StandardSchemaV1<unknown, Output>, Result>;
}

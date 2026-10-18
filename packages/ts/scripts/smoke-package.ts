import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(import.meta.dirname, "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "kaji-package-"));

try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", temporaryDirectory], {
      cwd: packageDirectory,
      encoding: "utf8",
    }),
  ) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const artifact = packed[0]!;
  const prohibitedFiles = artifact.files.filter(({ path }) =>
    /^(scripts|src|tests)\/|^(tsconfig\.json|tsdown\.config\.ts)$/.test(path),
  );
  if (prohibitedFiles.length > 0) {
    throw new Error(
      `Packed artifact contains development files: ${prohibitedFiles.map(({ path }) => path).join(", ")}`,
    );
  }

  const tarball = join(temporaryDirectory, artifact.filename);
  writeFileSync(
    join(temporaryDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: temporaryDirectory,
    stdio: "inherit",
  });
  writeFileSync(
    join(temporaryDirectory, "import.mjs"),
    [
      'import { capability, createKaji, knownFailure, memoryStore } from "@hiyorios/kaji";',
      "const noop = capability({",
      '  name: "smoke.test",',
      "  input: { '~standard': { version: 1, vendor: 'smoke', validate: (value) => ({ value }) } },",
      "  authorize: () => true,",
      "  execute: (input) => input,",
      "});",
      "if (typeof noop.name !== 'string') throw new Error('capability() did not return a name');",
      "if (typeof knownFailure(new Error('x')) !== 'object') throw new Error('knownFailure() did not return an error');",
      "",
      "const store = memoryStore();",
      "const claimed = await store.claim({",
      '  capability: "smoke.test",',
      '  principalId: "user_1",',
      '  idempotencyKey: "key_1",',
      '  inputFingerprint: "fp_1",',
      "});",
      "if (claimed.status !== 'claimed') throw new Error('memoryStore() did not grant the first claim');",
      "",
      "const kaji = createKaji({ store: memoryStore() });",
      "const result = await kaji.execute(noop, {",
      "  input: { value: 1 },",
      '  principalId: "user_1",',
      '  idempotencyKey: "key_2",',
      "});",
      "if (result.status !== 'succeeded') throw new Error('kaji.execute() did not succeed');",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(temporaryDirectory, "consumer.ts"),
    [
      'import { capability, createKaji, memoryStore } from "@hiyorios/kaji";',
      "",
      "// Hand-written Standard Schema: `version` needs `as const` and the",
      "// `types` field carries the validated output for callback inference.",
      "const smokeSchema = {",
      "  '~standard': {",
      "    version: 1 as const,",
      "    vendor: 'smoke',",
      "    validate: (value: unknown) => ({ value: value as { amount: number } }),",
      "    types: { input: 0 as unknown, output: 0 as unknown as { amount: number } },",
      "  },",
      "};",
      "",
      "const example = capability({",
      '  name: "smoke.typecheck",',
      "  input: smokeSchema,",
      "  authorize: () => true,",
      "  execute: (input) => input.amount,",
      "});",
      "",
      "export type Name = typeof example.name;",
      "",
      "const store = memoryStore();",
      "export type Store = typeof store;",
      "",
      "const kaji = createKaji({ store });",
      "export type ExecuteResult = ReturnType<typeof kaji.execute>;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(temporaryDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
    }),
  );

  execFileSync("node", ["import.mjs"], {
    cwd: temporaryDirectory,
    stdio: "inherit",
  });
  execFileSync(
    "node",
    [
      fileURLToPath(import.meta.resolve("typescript/bin/tsc")),
      "--project",
      join(temporaryDirectory, "tsconfig.json"),
    ],
    {
      cwd: temporaryDirectory,
      stdio: "inherit",
    },
  );

  readFileSync(
    join(temporaryDirectory, "node_modules", "@hiyorios", "kaji", "dist", "index.d.mts"),
  );
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}

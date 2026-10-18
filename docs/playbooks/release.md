# Release playbook

How to take `@hiyori/kaji` from a green `main` to a published npm release.
The system is tokenless: CI stages via OIDC trusted publishing; only a human
with 2FA can make a staged version public.

Pipeline:

```text
main
  → manual workflow dispatch (publish.yml, channel next|latest)
  → npm-release GitHub Environment, OIDC, full verification
  → npm private stage
  → human inspection
  → human approval with 2FA
  → public registry
  → verification, tag, GitHub release
  → docs install UI enabled (stable only)
```

Requirements:

- npm CLI ≥ 11.15.0 locally (staged publishing GA, 2026-05-22); CI pins
  `npm@11.19.0`. Node ≥ 22.14 required by both staged and trusted publishing.
- Package exists on the registry with a trusted publisher configured for
  `publish.yml` and the `npm-release` environment (ops/npm-trusted-publishing).
- Account 2FA enabled. Approval always requires 2FA; a granular token with
  "bypass 2FA" cannot approve a staged package.

## PREPARE

1. Confirm the release source is `main`. The workflow fails on any other ref.
2. Confirm CI is green on the release commit.
3. Select the package version in `packages/ts/package.json`:
   - `next` channel: prerelease version only, e.g. `0.3.0-rc.1`.
   - `latest` channel: stable version only, e.g. `0.3.0`.
4. Commit the version bump to `main` through a reviewed PR.
5. Confirm the version does not already exist: `npm view @hiyori/kaji@<version>`.

## STAGE

1. Dispatch: GitHub → Actions → **npm release** → Run workflow → branch
   `main` → channel `next` or `latest`.
2. Wait for verification. The workflow runs format, lint, typecheck, the full
   test suite (including failure/concurrency semantics), build, publint,
   attw, a tarball consumer smoke, and the refund proof example before any
   registry call.
3. The final step runs `npm stage publish <tarball> --tag <channel>
   --access public --provenance` on the exact tarball the gate validated
   (its sha256 is in the run summary) and writes the stage summary
   (package, version, channel, source sha, stage list) to the run
   summary. This stages the package privately; it cannot publish it.

## INSPECT

Run locally with an npm account that has write access to the package:

```sh
npm stage list @hiyori/kaji        # find the stage id
npm stage view <stage-id>           # metadata: version, tag, source
npm stage download <stage-id>       # fetch the exact staged tarball
```

Inspect the downloaded tarball:
```sh
shasum -a 256 *.tgz                 # compare with the run summary
tar -tzf *.tgz                      # file list must be package.json,
                                    # README.md, LICENSE, dist/*
npm pack --dry-run                  # (on an extracted copy) sizes
```

Clean-install the downloaded stage and exercise it before approving:

```sh
mkdir /tmp/kaji-verify && cd /tmp/kaji-verify && npm init -y
npm pkg set type=module
npm install /path/to/staged.tgz
node -e "import('@hiyori/kaji').then(m => console.log(typeof m.createKaji))"
```

Verify metadata: name `@hiyori/kaji`, expected version, dist-tag matches
the channel, `exports` points at `dist/index.mjs` + `dist/index.d.mts`,
zero runtime dependencies.

## APPROVE

Approval is interactive and always requires 2FA; CI cannot approve.

```sh
npm stage approve <stage-id>        # publishes to the registry
```

## VERIFY PUBLIC REGISTRY

After approval:

```sh
npm view @hiyori/kaji versions --json      # exact version present
npm view @hiyori/kaji dist-tags --json     # next → rc, latest → stable
npm view @hiyori/kaji@<version> dist.integrity
mkdir /tmp/kaji-registry && cd /tmp/kaji-registry && npm init -y && npm pkg set type=module
npm install @hiyori/kaji            # rc: npm install @hiyori/kaji@next
node -e "import('@hiyori/kaji').then(async m => {
  const kaji = m.createKaji({ store: m.memoryStore() });
  const cap = m.capability({ name: 't',
    input: { '~standard': { version: 1, vendor: 'smoke',
      validate: v => ({ value: v }) } },
    authorize: () => true, execute: i => i });
  const r = await kaji.execute(cap, { idempotencyKey: 'k', principalId: 'p', input: 'x' });
  if (r.status !== 'succeeded') throw new Error(r.status);
  console.log('registry install OK');
})"
```

Also verify: a duplicate replay returns the recorded outcome,
`knownFailure` settles `failed`, and an unrecognized throw settles
`unknown` (see `docs/api.md` for the contract).

## FINALIZE

1. Tag the exact release commit with a signed annotated tag:
   `git tag -s v<version> <source-sha>`. Confirm the signature with
   `git tag -v v<version>` (must report a good signature), then
   `git push origin v<version>`. Unsigned or unverified tags are a defect;
   the repository sets `tag.gpgsign true` so plain `git tag` also signs.
2. Create the GitHub Release for the tag; attach the staged tarball sha256.
3. Stable releases only: enable the docs install UI (homepage install
   command, header npm link, getting-started install, README install
   section). This is the `docs/npm-live` task. Never enable before
   `npm view @hiyori/kaji dist-tags` shows `latest` = the stable version.

## ROLLBACK / REJECTION

- Reject a staged candidate before approval:
  `npm stage reject <stage-id>` (2FA). Fix code, then re-stage.
- Staged versions occupy their semver slot: a rejected version number can
  be re-staged, but a PUBLISHED version number is permanent. If anything
  was already publicly published, fix forward with a NEW version; never
  try to overwrite or delete a published version.
- A bad stable release: publish a fix release and move `latest`
  (`npm dist-tag add @hiyori/kaji@<version> latest`). Do not remove
  versions from the registry.

## Invariants

- CI never publishes. The workflow's final action is `npm stage publish`.
- Every release tag is a GPG-signed annotated tag, verified locally with
  `git tag -v` before push; GitHub must show it as Verified.
- No npm token exists in the repository, CI, or docs. Staging authenticates
  with OIDC through the `npm-release` environment.
- Staging runs only from `main`, one release at a time, never concurrent.
- `latest` cannot carry a prerelease; `next` cannot carry a stable version.
- An existing public version is never staged, overwritten, or reused.

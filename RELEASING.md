# Releasing to npm

The workflow `.github/workflows/release.yml` publishes with provenance (a signed statement of which
commit and workflow built the package) from a GitHub environment that needs your approval. After
the first release it uses npm **trusted publishing** (OpenID Connect): no token exists anywhere.

## One-time setup (maintainer)

1. **GitHub environment.** Repository **Settings → Environments → New environment**, name `npm`. Add
   yourself under *Required reviewers*, so that every publish needs an explicit approval. Optionally
   restrict *Deployment branches and tags* to the pattern `v*`.
2. **npm account.** Turn on two-factor authentication ("authorization and publishing") and keep the
   recovery codes safe.
3. **First release.** Trusted publishing is configured in the *settings of an existing package* on
   npmjs.com, so the package must exist first (checked against the npm documentation, 2026-11-11).
   For the first release only, create a **granular access token** on npmjs.com limited to publishing
   `spillgate`, with the shortest expiry, and add it as a secret `NPM_TOKEN` of the environment `npm`.
4. **Switch to trusted publishing.** After the first release, open the package on npmjs.com →
   *Settings → Trusted Publisher → GitHub Actions* and enter: organization/user `FelixMiddelhoff`,
   repository `spillgate-js`, workflow filename `release.yml`, environment `npm`. A new configuration
   must complete its first successful publish within 2 days. Then **delete the `NPM_TOKEN` secret and
   revoke the token.** Trusted publishing needs npm 11.5.1 or newer and Node 22.14 or newer; the
   workflow uses Node 24.

The package name is reserved only by the first publish, so do the first release soon after step 1.

## Each release

1. Update `CHANGELOG.md` and set `version` in `package.json` (for example `0.1.0`). Commit to `main`
   and wait for a green CI.
2. Tag exactly that version and push the tag:
   ```
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```
3. The `release` workflow builds once, checks that the tag equals the version, runs the whole suite
   and the rule coverage check, packs, installs the tarball into an empty project, and waits for your
   approval in the `npm` environment. After the approval it publishes that same tarball with provenance.
4. Check from a clean directory: `npm view spillgate version` and `npm install spillgate`.
5. Create the GitHub release from the tag with the changelog text.

## Never

Never delete or re-publish a version (npm refuses it; unpublishing breaks users). A wrong release is
deprecated (`npm deprecate`) and fixed with the next patch version. Versions at or above 1.0 need
separate, explicit consent.

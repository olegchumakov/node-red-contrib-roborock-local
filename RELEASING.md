# Releasing

npm publishes this package from GitHub Actions with [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC). There is no `NPM_TOKEN` secret. Each publish uses a short-lived token for `.github/workflows/publish.yml` on GitHub-hosted runners.

## Cut a release

1. Bump `version` in `package.json` and add a matching section to `CHANGELOG.md`. Commit that on `main`.
2. Create a GitHub Release for that version. The publish workflow runs when the release is **published**, not when a draft or a pull request is opened.
3. The workflow checks out the release commit, installs the latest npm CLI (11.5.1 or newer, required for OIDC; Node is 22, which satisfies the 22.14 minimum), runs `npm ci` and `npm test`, then `npm publish --provenance --access public`. Provenance is also generated automatically for a public package published this way from a public repository.

`id-token: write` lets GitHub mint the OIDC token. The job does not set `NODE_AUTH_TOKEN`.

## Trusted publisher on npmjs.com

Package settings → Trusted Publisher → GitHub Actions. Allow **npm publish** (configurations created after 3 September 2026 default to staged publish only, which this workflow does not use).

| Field | Value |
| --- | --- |
| Organization or user | `olegchumakov` |
| Repository | `node-red-contrib-roborock-local` |
| Workflow filename | `publish.yml` |

The filename is only `publish.yml`, not `.github/workflows/publish.yml`. All three fields are case-sensitive.

After a publish succeeds, the package's publishing access can be set to require two-factor authentication and disallow tokens. Revoke the old automation token after that. Trusted publishers keep working.

## What provenance and the Flow Library check

`repository.url` is `git+https://github.com/olegchumakov/node-red-contrib-roborock-local.git`. That is this GitHub repository, which npm requires for provenance.

The Node-RED Flow Library uses the `node-red` keyword and the `node-red` section in `package.json`. That section requires Node-RED `>=3.0.0` and lists all nine nodes: `roborock-account`, `roborock-device`, `roborock-vacuum`, `roborock-command`, `roborock-status`, `roborock-clean-rooms`, `roborock-settings`, `roborock-maps`, and `roborock-consumables`.

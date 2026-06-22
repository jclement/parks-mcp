---
name: deploy
description: Ship a new version of Camp, Eh? (parks-mcp) — validate, commit, and push so CI builds and publishes the container image. Use when the user asks to deploy, ship, release, or "push it out".
---

# Deploy parks-mcp

Deployment is **image-based**. Pushing to `main` triggers `.github/workflows/docker.yml`,
which builds a multi-arch image and pushes it to **`ghcr.io/jclement/parks-mcp`**
(`:latest` plus a `:sha-<short>` tag, and version tags for `v*`). The production host
pulls that image. **Do not run docker / docker compose locally** — the local
compose + gatecrash setup under `deploy/` is reference only; production lives elsewhere.

## Steps
1. Validate (cheap, prevents a broken CI build): `bunx tsc --noEmit` and `bun test` — both must pass.
2. Commit with a clear message. End the body with
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and commit with `--no-gpg-sign`
   (the GPG signing agent refuses in this repo).
3. Push: `git push origin main`. The remote is **SSH** (`git@github.com:jclement/parks-mcp.git`)
   and requires a yubikey touch — let the user complete it.
4. Confirm CI: `gh run list --limit 1` then `gh run watch` until `build-image` succeeds.

## Notes
- The deployable artifact is `ghcr.io/jclement/parks-mcp:latest` (or the commit's `:sha-` tag).
- If anyone needs to pull the image anonymously, the GHCR **package** visibility must be set to
  public (repo public ≠ package public): user → Packages → parks-mcp → settings.
- Secrets (gatecrash token, `MCP_PATH`) live only in the deploy host's env — never commit them;
  `deploy/.env` is git-ignored.
- On container start the harvester re-warms its caches; near-term availability fills in minutes,
  the full 90-day window takes longer.

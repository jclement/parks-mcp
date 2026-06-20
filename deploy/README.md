# deploy/

Brings up the **parks-mcp** server and a **gatecrash** tunnel client together, so
the MCP endpoint is reachable through your gatecrash server.

## Layout

- `docker-compose.yml` — builds `parks-mcp` (from the repo root `Dockerfile`,
  listening on `:8000`) and runs `ghcr.io/jclement/gatecrash` sharing its network
  namespace, forwarding `--target 127.0.0.1:8000` to it.
- `.env` — gatecrash credentials + `MCP_PATH` (secret; git-ignored).
- `.env.example` — template.

## Run

```sh
cd deploy
docker compose up -d --build
docker compose ps
docker compose logs -f gatecrash   # watch the tunnel connect
```

`parks-mcp` becomes healthy first (compose waits on its healthcheck), then
gatecrash connects to `aardvark.onewheelgeek.net:55808` with the `parks:` token.

## Reaching the MCP endpoint

The public URL is whatever your gatecrash server maps the `parks` tunnel to (its
hostname/scheme is configured server-side on `aardvark.onewheelgeek.net`), with the
MCP path appended:

```
https://<parks-tunnel-host>/burrow/9f3a7c2e1d/mcp
```

Point a Streamable-HTTP MCP client at that URL. The root `/` of the tunnel serves
the decoy minigame; `/healthz` returns `ok`.

## Notes

- Change `MCP_PATH` in `.env` to your own unguessable value and keep it secret.
- To debug locally, uncomment the `ports:` block in `docker-compose.yml` to expose
  `:8000` on the host, then `curl localhost:8000/healthz`.
- gatecrash shares parks-mcp's network namespace (`network_mode: service:parks-mcp`),
  which is why the target is `127.0.0.1:8000`.

# Running a Public Node Behind nginx (Hardened)

This guide describes how to expose a bcash full node to the public internet as a
**read-only index/broadcast API** while keeping the wallet RPC and dangerous node
RPC methods completely unreachable.

It reflects a real deployment where nginx terminates TLS and reverse-proxies to a
loopback-bound node managed by systemd.

## Threat model

A bcash node started with `--no-auth=true` accepts **unauthenticated** JSON-RPC on
its HTTP port. If that port (directly, or via a reverse proxy) is reachable from the
internet, anyone can call:

- **Wallet RPC** — `dumpwallet`, `dumpprivkey`, `sendtoaddress`, `signmessage`, … →
  private-key theft and fund loss.
- **Dangerous node RPC** — `stop`, `invalidateblock`, `reconsiderblock`, … →
  denial of service / chain manipulation.

All JSON-RPC is dispatched over `POST /`. The public API you actually want to expose
is different traffic:

- `GET` index reads — `/`, `/?slp=true`, `/tx/<txid>`, `/mempool`,
  `/coin/address/<addr>`, …
- Websocket subscriptions — `/socket.io/`
- Raw transaction relay — `POST /broadcast`

The hardening below keeps that public surface working and blocks everything else.
It uses **two independent layers** so a mistake in one does not re-expose the wallet:

1. **Node layer** — `--no-wallet=true` makes `bin/node` skip loading
   `lib/wallet/plugin`, so no wallet server starts and the wallet RPC methods do not
   exist at all.
2. **Proxy layer** — nginx only forwards `GET`/`HEAD` to `POST /` is blocked, so the
   JSON-RPC dispatch endpoint (and any other non-GET route) returns `403` before it
   ever reaches the node.

> **Note on indexers.** `--no-wallet` disables *only* the wallet. The tx/address/SLP
> indexers are separate and stay up — keep `--index-tx`, `--index-address`, and
> `--index-slp` on so the public `GET` reads keep working.

> **Note on `--no-auth`.** With the node bound to `127.0.0.1` and nginx as the sole
> gatekeeper, `--no-auth=true` is workable. For defense-in-depth you may instead drop
> `--no-auth` and set an `--api-key`, so even a proxy misconfiguration cannot expose
> write methods. This guide documents the `--no-auth` + nginx-guardrail setup.

## 1. systemd unit

`/lib/systemd/system/bcash.service`:

```ini
[Unit]
Description=bcash full node
After=network.target

[Service]
ExecStart=/root/bcash/bin/bcash \
  --index-tx=true --index-address=true --index-slp=true \
  --max-inbound=4 --max-files=5000 --cache-size=1000 \
  --http-host=127.0.0.1 \
  --no-auth=true \
  --no-wallet=true
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Key flags:

| Flag | Purpose |
|---|---|
| `--http-host=127.0.0.1` | Bind the HTTP/RPC port to loopback only — never reachable except through nginx. |
| `--no-wallet=true` | Do not load the wallet plugin. No wallet server, no wallet RPC. |
| `--no-auth=true` | Accept unauthenticated RPC on loopback (safe only because nginx guards the edge). |
| `--index-tx` / `--index-address` / `--index-slp` | Keep the public index reads working. |

The node listens on `127.0.0.1:8332` (HTTP/REST/RPC). With `--no-wallet`, the wallet
server that would otherwise listen on `127.0.0.1:8334` is **not started** — confirming
its absence is part of verification below.

## 2. nginx server block

The reverse proxy exposes the public TLS endpoint and forwards to the loopback node.
Replace a single catch-all `location /` with **three** locations so only the intended
traffic is proxied:

`/etc/nginx/sites-available/<your-site>`:

```nginx
server {
    server_name node.example.com;

    # Raw tx relay — allow POST through to the app.
    location = /broadcast {
        proxy_pass http://127.0.0.1:8332;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Websocket subscriptions — needs the Upgrade/Connection headers.
    location /socket.io/ {
        proxy_pass http://127.0.0.1:8332;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Everything else: GET/HEAD index reads only.
    # Non-GET (incl. POST / JSON-RPC dispatch) -> 403.
    location / {
        limit_except GET HEAD { deny all; }
        proxy_pass http://127.0.0.1:8332;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    listen <PUBLIC_IP>:8332 ssl http2;
    ssl_certificate     /etc/letsencrypt/live/node.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/node.example.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}
```

How it works:

- `limit_except GET HEAD { deny all; }` in `location /` is the guardrail — it returns
  **`403`** for any non-GET/HEAD method, which blocks `POST /` (JSON-RPC), `POST
  /graphql`, and everything else that isn't an explicit exception below.
- `location = /broadcast` is an **exact match** and takes precedence over `location /`,
  so `POST /broadcast` is still allowed through for raw-tx relay.
- `location /socket.io/` is the **only** block that sets the `Upgrade`/`Connection`
  headers, so websocket subscriptions upgrade correctly. Don't add those headers to the
  other blocks.

## 3. Apply

```bash
# Validate the nginx config first.
nginx -t

# IMPORTANT: restart, do NOT reload.
# A SIGHUP reload does not reliably pick up newly-added location blocks.
systemctl restart nginx

# Apply the systemd unit change and (re)start the node.
systemctl daemon-reload
systemctl enable bcash.service
systemctl restart bcash.service     # restart is required to pick up ExecStart changes

# Wait until the node is listening on loopback.
ss -ltn | grep 127.0.0.1:8332
```

> Always back up both files with a timestamped copy before editing, e.g.
> `cp -a /lib/systemd/system/bcash.service{,.bak.$(date +%Y%m%d-%H%M%S)}`.

## 4. Verify

Run these against the **public** URL and confirm each result. If any `POST`-block
check returns `200` instead of `403`, the new config is not active — `systemctl
restart nginx` (not reload) and re-check.

| Check | Command (abbrev.) | Expect |
|---|---|---|
| Index read | `GET /` | `200` |
| SLP read | `GET /?slp=true` | `200` |
| Mempool read | `GET /mempool` | `200` |
| Broadcast reachable | `POST /broadcast` body `{}` | `400` `"TX is required"` (reached app = allowed) |
| JSON-RPC blocked | `POST /` `{"method":"getblockchaininfo"}` | `403` (blocked by nginx) |
| Other POST blocked | `POST /graphql` | `403` |
| Websocket upgrade | `GET /socket.io/?transport=websocket` (HTTP/1.1, Upgrade headers) | `101 Switching Protocols` |
| Wallet server gone | `ss -ltn \| grep 127.0.0.1:8334` | no output |
| Service healthy | `systemctl is-active bcash` / `is-enabled bcash` | `active` / `enabled` |

Example commands:

```bash
BASE=https://node.example.com:8332

curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/"
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/?slp=true"
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/mempool"

# Reaches the app (allowed) and is rejected for an empty body -> 400 "TX is required".
curl -sk -H 'Content-Type: application/json' -d '{}' "$BASE/broadcast"

# Blocked by nginx before reaching the node -> 403.
curl -sk -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' -d '{"method":"getblockchaininfo"}' "$BASE/"
curl -sk -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' -d '{}' "$BASE/graphql"

# Websocket upgrade. Force HTTP/1.1; --max-time so it can't hang.
curl -sk --http1.1 --max-time 3 -i \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$BASE/socket.io/?transport=websocket" | head -1
```

> **curl artifacts on the websocket probe.** Over HTTP/2 the upgrade probe returns
> `404` — that's a curl/HTTP-2 artifact, not a failure; force `--http1.1`. A plain
> polling probe (`?transport=polling`) also returns `404`, which is normal because
> `bsock` is websocket-only.

## Do not test with `stop`

When verifying a public node, never send the `stop` RPC method and never `POST /` with
any state-changing method against a production node — a misconfiguration could shut the
node down. The `POST /` block test above intentionally uses the read-only
`getblockchaininfo` method purely to confirm nginx returns `403` *before* the request
reaches the node.

## If the wallet was previously exposed

If this node ran with `--no-auth=true` and an internet-reachable `POST /` **before**
these guardrails were added, treat any private keys that were in the wallet as
potentially compromised: `dumpprivkey`/`dumpwallet` are read-only and leave no trace in
the wallet database or logs, so their use cannot be proven or disproven after the fact.
Generate a fresh wallet on a machine that was never exposed, move any funds, and never
reuse the old addresses.

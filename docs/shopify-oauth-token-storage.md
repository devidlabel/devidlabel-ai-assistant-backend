# Shopify OAuth token storage

This Worker uses the existing Devid Label Shopify app OAuth flow. Do not create a second Shopify app.

## Cloudflare KV namespace

Create the persistent token/state KV namespace:

```bash
npx wrangler kv namespace create SHOPIFY_TOKENS_KV
```

After Wrangler returns the real namespace id, add the real binding to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SHOPIFY_TOKENS_KV"
id = "REAL_KV_NAMESPACE_ID"
```

Do not commit fake namespace ids that would break deploys.

## Encryption secret

Generate a 32-byte base64 key:

```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

Store it as a Cloudflare Worker secret:

```bash
npx wrangler secret put SHOPIFY_TOKEN_ENCRYPTION_KEY
```

The Worker stores the offline Shopify Admin API OAuth token in KV at:

```text
shopify:offline_token:${shopDomain}
```

Only the AES-GCM encrypted token and IV are saved. The raw token is never returned by debug endpoints and must never be logged.

## OAuth state

`/install` stores temporary OAuth state in the same KV namespace:

```text
shopify:oauth_state:${state}
```

State entries expire after 10 minutes. `/auth/callback` must find the state in KV before exchanging the Shopify code and then deletes it after a successful installation.

## Post-merge checklist

1. Create the KV namespace.
2. Add the real `SHOPIFY_TOKENS_KV` binding to `wrangler.toml`.
3. Set `SHOPIFY_TOKEN_ENCRYPTION_KEY` as a Worker secret.
4. Deploy the Worker manually.
5. Reinstall/authorize the existing Shopify app for `SHOPIFY_SHOP_DOMAIN`.
6. Call `/debug/shopify` with `X-Assistant-Admin-Token`.
7. Retest `/order/lookup`.

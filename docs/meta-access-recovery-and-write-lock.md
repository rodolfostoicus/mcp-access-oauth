# Meta access recovery and single-writer control

This runbook separates two independent authentication layers:

1. Cloudflare Access authenticates the MCP client to this Worker.
2. `META_ACCESS_TOKEN` authorizes the Worker to Meta Graph API assets.

A successful login to Meta in a browser does not renew the Worker's Meta token or restore its ad-account asset assignment.

## Recovering Meta error `(#200)` after a security checkpoint

Use this sequence when `meta_get_token_permissions` still reports `ads_read` and `ads_management` as granted, Pages remain visible, but `meta_get_ad_account` returns OAuth error `#200` for the configured account.

1. In Meta Business Settings, open ad account `3422857277981490` and verify that the user or System User backing the `Integra IA` token is assigned to that exact account with permission to view performance and manage campaigns.
2. In Business Integrations, renew the `Integra IA` authorization if Meta requests review after a password change or security checkpoint. Keep the required Pages and the ad account selected.
3. Generate or renew the production token through Meta's supported flow. Prefer a dedicated Business System User token over a personal browser token.
4. Replace the Worker secret without committing the value:

   ```bash
   wrangler secret put META_ACCESS_TOKEN
   ```

5. Run the read-only preflight in this order:

   - `meta_get_token_permissions`
   - `meta_get_ad_account`
   - `meta_list_campaigns`

6. Do not call any Meta write tool until all three reads succeed for the configured account.

Do not change the user's Meta password again solely to repair this connector. Error `#200` with valid scopes is an asset-assignment or authorization problem; an invalid or expired token normally fails earlier as a token error.

## Concurrent ChatGPT sessions

Connector version 2.3.1 combines two account-scoped Durable Objects:

- `META_API_GATE` serializes all Meta Graph requests across chats, spaces attempts by at least 250 ms, applies one bounded retry only to a short rate-limited `GET`, and enters cooldown after a persistent or long limit. It never retries a `POST`.
- `META_WRITE_LOCK` provides the exclusive write lease described below.

The write lease behaves as follows:

- Read-only tools remain available to every chat.
- The first session that attempts a real write receives an exclusive 10-minute lease for the configured ad account.
- A write from another session fails closed with `WRITE_LOCKED` before the real Meta mutation.
- A real-write attempt by the same session renews the lease before the Meta call; the lease remains active after a failed or ambiguous call as a safety measure.
- The owning session may release it with `meta_release_write_lease`; otherwise it expires automatically.
- Validate-only requests do not acquire the lease.

Operationally, keep one control chat for mutations and use any additional chats only for reports, reviews, or planning.

## Production preflight

After deployment, verify:

1. `meta_get_token_permissions` performs the minimal three-read check unless an optional diagnostic is requested, and effective readiness requires access to the configured account.
2. `meta_get_write_lease` returns an inactive lease.
3. A validate-only request succeeds without acquiring a lease.
4. A confirmed write from one MCP session acquires the lease.
5. A second MCP session receives `WRITE_LOCKED` and performs no Meta mutation.
6. The owning session can read back the changed Meta object and release the lease.

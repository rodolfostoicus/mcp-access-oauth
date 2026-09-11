# Meta access recovery and single-writer control

This runbook separates two independent authentication layers:

1. Cloudflare Access authenticates the MCP client to this Worker.
2. `META_ACCESS_TOKEN` authorizes the Worker to Meta Graph API assets.

A successful login to Meta in a browser does not renew the Worker's Meta token or restore its ad-account asset assignment.

## Recovering Meta error `(#200)` after a security checkpoint

Use this sequence when `meta_get_token_permissions` still reports `ads_read` and `ads_management` as granted, Pages remain visible, but `meta_get_ad_account` returns OAuth error `#200` for the configured account.

1. Run `meta_get_token_permissions` with `business_access_diagnostic_id` set to the historically recorded Stoicus Business ID `644876512865789`. This opt-in diagnostic is read-only. It checks bounded lists of system users and owned/shared ad accounts, returns only the token subject and configured account, and skips unrelated Page/WhatsApp calls. An incomplete or denied list does not prove absence. An observed `ADMIN` role is not a successful authorization test for asset assignment.
2. In Meta Business Settings, inspect the exact ad account `3422857277981490` and the identity backing the production token. Confirm the owner business, current asset assignment, and tasks to view performance and manage campaigns. Do not identify a user solely by the display name `Integra IA`. Historical system-user IDs and the ID returned by `/me` require mapping; a difference alone does not prove that the token is wrong.
3. If the assignment is absent, an authorized administrator should restore it to the confirmed identity. The current official SDK exposes `POST /act_3422857277981490/assigned_users` with `user=<confirmed system-user ID>` and `tasks=["ADVERTISE","ANALYZE"]`. Existence of this endpoint or granted `business_management` alone does not establish the token's authority to execute it. This connector's diagnostic never performs that POST. Do not add `MANAGE` or change ownership to solve campaign access.
4. Retry one minimal account read after any authorized recovery. If the assignment is already correct but access remains denied, inspect business/app restrictions, security review, and any Meta-requested authorization renewal. In Business Integrations, the application is distinct from the user/system-user name. The historical app is `STOICUS MKT IA` (`1633140634900008`); verify the actual token's application before renewing or replacing anything.
5. Generate or renew the production token through Meta's supported flow only when the evidence calls for it. A browser login or MCP OAuth refresh does not replace `META_ACCESS_TOKEN`. If replacement is necessary, use the existing Worker secret, without committing or sharing its value:

   ```bash
   wrangler secret put META_ACCESS_TOKEN
   ```

6. Run the read-only preflight in this order:

   - `meta_get_token_permissions`
   - `meta_get_ad_account`
   - `meta_list_campaigns`

7. Do not call any Meta write tool until all three reads succeed for the configured account.

Do not change the user's Meta password again solely to repair this connector. Error `#200` confirms that the requested operation was denied; the exact message and administrative evidence determine the cause. Granted scopes do not prove asset access, and denied API access does not prove that ads stopped delivering. Do not loop on denied reads or infer that concurrent chats caused a checkpoint solely from their timing.

Official SDK references: [SystemUser](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/systemuser.py), [Business](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/business.py), [AdAccount](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py).

## Concurrent ChatGPT sessions

Connector version 2.3.2 combines two account-scoped Durable Objects:

- `META_API_GATE` serializes all Meta Graph requests across chats, spaces attempts by at least 250 ms, applies one bounded retry only to a short rate-limited `GET`, and enters cooldown after a persistent or long limit. It never retries a `POST`.
- `META_WRITE_LOCK` provides the exclusive write lease described below.

The write lease behaves as follows:

- Read-only tools remain available to every chat.
- The first session that attempts a real write receives an exclusive 10-minute lease for the configured ad account.
- A write from another session fails closed with `WRITE_LOCKED` before the real Meta mutation.
- A real-write attempt by the same session renews the lease before the Meta call; the lease remains active after a failed or ambiguous call as a safety measure.
- The owning session may release it with `meta_release_write_lease`; otherwise it expires automatically.
- Validate-only requests do not acquire the lease.

The lease coordinates real writes only; `META_API_GATE` separately throttles all Graph reads and writes. Neither mechanism cures Meta permission errors. Resume recurring reviews only after account access is restored; keep denied checks brief and do not create overlapping replacement monitors.

Operationally, keep one control chat for mutations and use any additional chats only for reports, reviews, or planning.

## Production preflight

After deployment, verify:

1. `meta_get_token_permissions` performs the minimal three-read check unless an optional diagnostic is requested, and effective readiness requires access to the configured account.
2. `meta_get_write_lease` returns an inactive lease.
3. A validate-only request succeeds without acquiring a lease.
4. When an independently authorized, necessary mutation is due, its confirmed write from one MCP session acquires the lease. Do not create an ad change solely to test the lock.
5. If a second independently authorized write is attempted from another session while the lease is active, it receives `WRITE_LOCKED` and performs no Meta mutation. Do not introduce an otherwise unnecessary live write for this check; use the offline test suite for deliberate contention testing.
6. The owning session reads back its necessary Meta change and releases the lease.

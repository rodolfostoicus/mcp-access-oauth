# WhatsApp destination preservation — 2.2.2

## Diagnosed regression

Version 2.2.1 used `promoted_object.whatsapp_phone_number` to resolve the
legacy client's WhatsApp intent, but then deleted the field before the Graph
API request. This field is a documented Meta Promoted Object field, not a
local helper. Dropping it lets validation use Page/default-number resolution
instead of the explicitly selected phone.

Consequently, a Page/WhatsApp error from that request did not establish the
Business status of the requested phone. Do not migrate, disconnect, or
re-register a production number based on that result.

## Narrow correction

- Preserve the selected `whatsapp_phone_number` in the outbound promoted object.
- Keep the existing engagement/conversations routing, account ownership and
  exact-name guards, confirmations, idempotency, and PAUSED creation behavior.
- Add read-only Page WhatsApp diagnostics to the existing permissions action.
  Diagnostic failures remain isolated from permission/readiness results.
- Return the connector version through existing read-only actions so that
  production deployment can be verified without a Meta mutation.
- Do not change OAuth, routes, runtime variables, WABA, provider, webhooks,
  Page links, budgets, statuses, or existing campaigns.

## Verification

Run `npm test` and `npm run type-check:worker`. The worker-specific type-check
targets the deployed `src/` entry point; the older root `index.ts` is preserved
and is not deployed by Wrangler. Tests run the actual tool handlers with a
mock Graph transport and synthetic identifiers; no live credentials or network
are used by the tests.

For live verification:

1. Capture current campaign/ad-set/ad snapshots using read-only actions.
2. Confirm `connector_version` is `2.2.2` after the approved deployment.
3. Read Page `whatsapp_number`, `has_whatsapp_number`, and
   `has_whatsapp_business_number` where available. These Page fields are not
   a complete inventory of every selectable WABA number.
4. Validate only with the explicitly authorized phone and unchanged briefing.
5. Record the exact sanitized Meta result. A failed validation is not successful
   creation and does not prove that all other fields have been validated.
6. Re-read active objects and confirm their settings are unchanged.

The successful ATLS November campaign uses `OUTCOME_LEADS`, `ON_AD`, and
`LEAD_GENERATION`. A WhatsApp follow-up after a submitted lead form is distinct
from direct click-to-WhatsApp with `CONVERSATIONS`. Do not silently change the
BREVAR objective or infer native WhatsApp eligibility from Lead Ads success.

## Sources

- Meta Promoted Object: https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-promoted-object
- Meta Page: https://developers.facebook.com/docs/graph-api/reference/page/
- Meta CTWA: https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-whatsapp

## Rollback

If this connector release introduces a regression, revert only this release
through a reviewed follow-up commit and deploy with `--keep-vars`. Do not
delete campaigns or alter the working WhatsApp provider as a rollback action.

## Follow-up: opt-in professional-targeting diagnosis — 2.2.3

Production 2.2.2 was confirmed by readback. Re-validating the selected phone
advanced past the old WhatsApp error. Meta rejected Advantage+ with hard
minimum age 26 (1870188), then rejected the strict audience using the single
Medical Doctor (MD) job-title ID (2446395). Removing only that job-title filter
in a validate-only diagnostic produced `success: true`; nothing was created.
Changing home-only to home/recent did not resolve the job-title rejection.

This does not authorize publishing without a medical-professional filter.
The account read action now accepts optional, bounded `work_position_queries`
(at most five) and `work_position_ids` (at most twenty) to query the account's
read-only `targetingsearch` and `targetingvalidation` endpoints. Search is limited
to job titles, BR, engagement/conversations, and twenty results per query.
An ordinary empty account read performs no extra targeting requests. Errors
remain explicit and isolated; no request is converted to a write.

These are self-declared job titles, not CRM verification. Do not interpret a
valid ID as proof of sufficient audience size or professional eligibility.
The authorized age, profession, regions, budget and destination remain required
before any actual ad-set creation. Meta's current location-types documentation
specifies home/recent, not guaranteed residence-only targeting.

API contract reference: the official Meta SDK `AdAccount.get_targeting_search`
and `get_targeting_valid_a_t_i_on` in
https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py

## Existing audience inventory — 2.2.4

The user identified a possible existing audience named Médicos Sul. Account
reads accept an optional `audience_inventory` with a strict `kind` of `saved`
or `custom`, `limit` 1–100, and an optional opaque `after` cursor (max 2,000
characters). The route is fixed to the configured account's `saved_audiences`
or `customaudiences` GET edge. No member records are requested and no audience
is created, edited or attached to an ad set by this diagnostic.

Default account reads still perform one account GET. Metadata errors are
isolated and explicit. Pagination exposes sanitized cursors and `has_next`;
it never exposes or follows raw Graph paging URLs. A terminal `after` cursor
without `next` does not imply another page. Search names locally without
assuming a server filtering operator.

A saved medical audience is a targeting preset, not proof of a physician list.
Inspect its targeting and any custom-audience references. Custom subtype,
data-source and delivery metadata distinguish lists from website, engagement
or lookalike audiences; they do not establish professional credentials or
consent of individual members. Name alone cannot authorize wider geography,
age or professions. Preserve existing audience definitions and active ads.

Official Meta SDK contract references:
- https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/savedaudience.py
- https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/customaudience.py
- https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/api.py

# BREVAR 2027 preparation — connector 2.3.18

This change extends the existing Worker. It does not create a new plugin, configure a webhook, integrate Google Sheets, modify authentication, or enable ad delivery.

## Native lead forms

`meta_create_lead_form` keeps the existing name/Page/request-id contract. `CUSTOM` questions require `key` and `label`; omit `options` for a short answer such as a CRM number. Existing string options become native `{key,value}` choices. Up to 50 bounded choices accommodate all 27 CRM UFs. Entered CRM information is not professional verification.

`context_card.headline` is an input alias and is sent as native `context_card.title`. Optional `custom_disclaimer` exposes a title, body text and consent checkboxes. `is_checked_by_default` is always false. Optional `thank_you_page` supports title, body, button text and `VIEW_WEBSITE`; its URL must equal `follow_up_action_url`.

`validate_only:true` is a **local preview**, explicitly `meta_validated:false`; it is not a Meta form validation. A real create requires:

`CREATE LEAD FORM <page_id> <exact_name>`

Creation reads the exact saved form. Its result retains the original `{idempotent_replay,result}` envelope and adds `actual`, configuration `checks`, and `verified`. Read-back failure or mismatch preserves the created ID and never recreates or deletes the form. `meta_get_lead_form_details` reads the exact Page/form/name, including questions, consent, context and thank-you fields. Native omitted checkbox defaults follow the documented required=true and prechecked=false defaults.

All Page-scoped form calls derive the selected Page token **inside the serialized account gate** from the existing connection. The token is held only in request memory, sent in an Authorization header, never returned or stored in KV, and redacted from errors. The gate accepts Page-token routing only for bounded form/lead/test endpoints. Missing Page access or required tasks fails before a form POST.

## Brand identity and image lead ads

`meta_get_lead_page_identity(page_id)` cross-checks the exact accessible Page's public Instagram relationships against the configured ad account's Instagram actors. A same display name is insufficient. Its metadata contains public IDs/usernames and Page tasks, never tokens.

`meta_create_lead_form_image_ad_draft` supports `ON_AD` + `LEAD_GENERATION` and one exact owned form. Required fields include adset ID/name, Page, form, image hash, title, primary text, name and request UUID. Optional `placement_images` has exactly `feed_4x5`, `square_1x1`, `story_9x16`; the default `image_hash` must equal `feed_4x5`. It verifies account-owned image hashes and requested aspect ratios. Placement customization requires explicit Facebook/Instagram-only targeting. Instagram delivery requires a verified explicit actor and `expected_instagram_username`; the input actor alias is sent as current native `instagram_user_id`.

The native CTA contains `lead_gen_form_id`; it is not a website form link. The approved Meta sentinel link is `https://fb.me/`. Feed, vertical and default square assets are bound to native placement rules. Fourteen explicit image/text enhancement opt-outs prevent transformation enrollment from being silently accepted by this handler. Meta must still confirm these API fields and the resulting native configuration.

A real create requires:

`CREATE LEAD FORM IMAGE AD <adset_id> <exact_name>`

The tool always creates PAUSED. Native read-back verifies status/hierarchy, Page, Instagram actor, form, primary text, headline, image, enhancement opt-outs, every hash/adlabel mapping and asset-feed text/CTA/link/rule fields. A mismatch returns the created ID with `verified:false`; it never retries, recreates, activates, or changes a budget.

## Budget and pending flight

An `OUTCOME_LEADS` campaign without campaign budgets supports independent ad-set budgets and explicitly disables ad-set budget sharing. The ad-set creator accepts explicit `ON_AD`, requiring the lead objective, `LEAD_GENERATION`, and the promoted Page.

Pending ad sets use an **existing lifetime R$300 cap**, PAUSED status, a clearly documented temporary technical 15-day window, and the exact suffix ` | INÍCIO PENDENTE`. Technical timestamps are not the final advertising dates. The user chooses the actual dates when releasing the campaign. Do not create provisional daily-budget ad sets: switching daily/lifetime budget types has not been proved safe for this workflow.

`meta_configure_lead_adset_flight` requires a pending PAUSED BREVAR 2027 ad set with lifetime 30000 minor units, daily zero, a PAUSED unbudgeted lead campaign, and budget sharing disabled. It preserves all budgets and changes only start/end, day-parting schedule, pacing and the pending suffix. The end is exactly 15×24 hours after the explicitly zoned future start. For America/Noronha accounts, 07:00–24:00 corresponds to 06:00–23:00 in Brasilia; America/Sao_Paulo accounts use 06:00–23:00 directly.

It validates with Meta, verifies unchanged hierarchy, waits 31 seconds before a real same-object POST, rechecks the parent and child, and verifies the saved configuration. It retains its operation lease on an uncertain dispatched write. A real update requires:

`FINALIZE LEAD FLIGHT <adset_id> START <exact_start_time> 15D BRL 300.00`

`meta_set_delivery_status(ACTIVE)` blocks a pending ad set, an ad under a pending ad set, and a lead campaign with any pending child. Campaign child pagination is bounded and fails closed when incomplete. A terminal cursor without `paging.next` is a completed page. These connector guards do not govern changes made directly in Meta's UI.

## Leads and synthetic testing

`meta_list_form_leads` requires granted `leads_retrieval`, exact Page/form/name, and bounded retrieval. Personal fields are opt-in; `test_leads_only:true` selects the native test dataset. No result claims a verified CRM, enrollment or Sheets integration.

`meta_create_form_test_lead` generates conspicuously synthetic fields only. It accepts no real person's name, phone, email or CRM. A local preview is not a Meta test. A real test creation requires:

`CREATE TEST LEAD <page_id> <form_id> SYNTHETIC`

An existing test lead prevents another create; there is no automatic deletion. Test leads must be kept out of qualified-lead and enrollment metrics. This capability does not configure a webhook, subscribe a Page, grant missing permissions, or establish a Google Sheets delivery mechanism. The real integration still requires a separately verified route and credentials.

## Validation boundary and primary sources

Offline regression checks exercise the actual TypeScript handlers with mocked transport and storage. They demonstrate payloads, ownership checks, token handling, no-retry behavior, pending-flight guards and read-back failures. They do not establish API acceptance, public delivery, platform policy approval or a functioning lead-to-Sheets integration. Run live Meta previews and exact read-back before those claims.

Primary references:

- [Meta native lead-ad guide](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/create/)
- [Meta Page leadgen form reference](https://developers.facebook.com/docs/graph-api/reference/page/leadgen_forms/)
- [Meta asset-feed reference](https://developers.facebook.com/docs/marketing-api/reference/ad-asset-feed-spec/)
- [Official Meta Python SDK Page create_lead_gen_form parameters](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py)
- [Official Meta SDK form and test-lead edges](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/leadgen-form.js)
- [Official Meta SDK context-card native title](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/lead-gen-context-card.js)
- [Official Meta SDK Instagram native object-story identity](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/ad-creative-object-story-spec.js)
- [Official Meta SDK placement rule fields](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/ad-asset-customization-rule-customization-spec.js)
- [Official Meta SDK creative enhancement fields](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/ad-creative-features-spec.js)

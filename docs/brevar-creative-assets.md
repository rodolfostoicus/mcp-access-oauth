# BREVAR artwork delivery — 2.2.5

The existing WhatsApp draft tool accepts an image URL, but the previous official WebP URL failed Meta's download validation (100/2446511). Four reviewed images were created from the user-supplied BREVAR and Stoicus logos: two concepts, with feed and story versions. The campaign message addresses physicians only, for BREVAR Fundamentos in Blumenau on 3 October 2026.

This release adds an exact allowlist of those public marketing images to the existing Worker at `/creative-assets/`. Each JPEG pathname contains a SHA-256 prefix. `src/creative-data/` stores the reviewed bytes; `src/creative-manifest.ts` is the complete allowlist. The reproducible conversion script performs JPEG encoding only, preserving the generated images' dimensions and composition.

Only GET and HEAD are accepted. Unknown assets return 404; write methods return 405. MIME signatures, immutable caching and nosniff headers are checked. This route does not proxy external URLs, accept uploads, use credentials or expose other files. Existing OAuth and MCP routing continues unchanged for all other paths, including the `/mcp-v2` alias.

The read-only ad listing now includes the existing creative's story specification, image hash and thumbnail for post-creation verification of Page, WhatsApp CTA, number and artwork. The input schema, ownership checks and pagination are unchanged.

The release itself changes no Meta object. Subsequent campaign operations must remain confined to BREVAR campaign `120246498336430258` and ad set `120246578853280258`, creating ads PAUSED. ATLS campaign `120246569914850258` remains outside the mutation scope. BREVAR retains BRL 700 lifetime budget, age 26–55, physician work positions only and the existing geographic and schedule bounds. Activation remains a separate action.

Verification: actual-handler regression tests, asset route tests, worker-specific TypeScript checking and offline bundling. All four production JPEG responses were checked byte-for-byte against their SHA-256 digests. The generic repository-wide TypeScript command encounters an existing unrelated root `index.ts` import issue; `type-check:worker` covers the deployed `src/` entrypoint. Local checks do not by themselves establish deployment or Meta acceptance; these require live read-back.

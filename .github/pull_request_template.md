## Summary

<!-- Bullets work best here. What changed and why, in the order a reviewer should read it. End with "Closes #N" / "Relates to #N"; break out a "Related issues" section only when relationships need explanation. -->

## Key changes

<!-- One bullet per meaningful change. Name the subsystem (plugin / sidecar / both) when it disambiguates. -->

## Notes (optional)

<!-- Add free-form H2/H3 sections when reviewers need design rationale, protocol/breaking-change notes, or mechanics. Use specific headers ("Wire protocol", "Migration", "Why X over Y"), not a generic "Implementation details" dump. Call out wire-protocol or settings-schema changes explicitly. Delete the section if the change is self-explanatory. -->

## Test plan

- [ ] `npm run check` (TS typecheck + lint + vitest + esbuild)
- [ ] `cargo test` (+ `cargo clippy` if Rust changed)
- [ ] Manual:

# Protocol reference

The API-style reference for every PERMANENT COLLECTION contract, rendered on
the site at `/docs`. The markdown tree here is the canonical source; the site
serves a pre-rendered copy of the same content.

## Layout

| Path | What it is |
| --- | --- |
| `introduction/`, `contracts/`, `guides/`, `offchain/`, `reference/` | **Generated output.** Don't edit these files directly |
| `_prose/` | Hand-authored per-contract prose supplements (see [`_prose/SPEC.md`](_prose/SPEC.md)) |
| `_pages/` | Hand-written pages (overview, guides, off-chain docs) |

## Regenerating

```bash
pnpm generate:docs
```

`scripts/generate-docs.ts` merges the checked-in ABIs (`app/lib/abis/*.json`)
and `contracts/deployments.mainnet.json` with the prose in `_prose/` and
`_pages/`, then emits:

- the final markdown pages here
- `app/lib/docs/manifest.json` + `content.json` (sidebar + pre-rendered HTML
  the site imports)
- `app/public/abis/*.json`, `app/public/protocol-manifest.json`,
  `app/public/llms.txt`, `app/public/docs-search-index.json`

The generator is strict: every ABI function, event, and error must have a
prose block, every state-changing function must declare its access model, and
prose naming unknown ABI items fails the run. Signatures, event topics, and
error lists are derived from the ABIs and can't drift from the deployed
contracts.

If a contract's checked-in ABI is regenerated (`pnpm generate:abis`, needs
`contracts/out/` from a forge build), rerun `pnpm generate:docs` and the
validator will point at any prose gaps the refresh introduced.

# Contributing

## How this repository works

This is the public, published source of Permanent Collection's working repository. Each merge to the working repo's `master` is published here as a clean snapshot commit — the working repo's real commit subject, on a fresh decoupled history (the public repo does not share SHAs with the private repo, and carries none of the pre-launch development residue). Internal issue tracking and pull-request review happen on the private working repo, so `#NNN` references in commit messages point at that repo's issues and PRs and may not resolve here.

## What's open to contribution

The deployed contracts are immutable, so contract changes can't ship to mainnet. Contributions are welcome for:

- the frontend (`app/`)
- the indexer (`indexer/`)
- documentation (`docs/`)
- the test suite (`contracts/test/`)

## Submitting changes

Open a PR against this repo. An accepted change is applied to the private working repo with your authorship preserved (`Co-authored-by`), merged to its `master`, and mirrored back here; your PR is then closed with a reference to the mirrored commit.

## Issues

Issues here are the community inbox: bug reports, questions, integration help. For anything security-sensitive, use the private reporting channel described in [SECURITY.md](SECURITY.md).

## Building

See the Quickstart in [README.md](README.md). Note the artcoins submodule needs an explicit recursive checkout (`git submodule update --init --recursive --checkout contracts/lib/artcoins`, which also pulls its nested library submodules), and the first contracts build is heavy (via-IR, roughly 15 minutes cold).

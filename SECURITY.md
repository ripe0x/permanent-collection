# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting: the **Report a vulnerability** button under this repository's Security tab. Don't open a public issue for anything you believe is exploitable.

The protocol's contracts are live on Ethereum mainnet and immutable: no upgrade path, no pause, no admin override on custody. Most contract-level findings therefore can't be patched in place. Reports still matter: operational responses are often possible (frontend, indexer, the seller allowlist, the small set of bounded parameter carve-outs), and a documented finding protects everyone interacting with the system.

## Scope

- Contracts: `contracts/src/`, deployed at the addresses in [contracts/deployments.mainnet.json](contracts/deployments.mainnet.json), all source-verified on Etherscan
- Frontend, indexer: `app/`, `indexer/`

## Background reading

- [docs/SECURITY.md](docs/SECURITY.md): trust model, reentrancy posture, admin surface

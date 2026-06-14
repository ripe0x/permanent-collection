# The artcoins pin — what it is, and how to check it

`contracts/lib/artcoins` is a git **submodule**: not a copy of the artcoins
code, but a *bookmark* to one exact commit of the separate
[artcoins](https://github.com/ripe0x/artcoins) repo (the public mirror of the
artcoins working repo's `master`; same commits, same SHAs). PC's contracts
compile and deploy against artcoins, so PC has to record which exact version to
use. That recorded commit is **the pin**.

"Bump the pin to `abc1234`" just means "move the bookmark to artcoins commit
`abc1234`."

## The one rule

**The gitlink is the only source of truth.** The pin is whatever this returns:

```bash
git rev-parse HEAD:contracts/lib/artcoins
```

A SHA written in a doc, a memory note, a commit message, or a chat is just prose.
It drifts, and it is **not** authoritative. When in doubt, don't trust prose —
run:

```bash
scripts/artcoins-pin.sh check
```

It reports, in plain English:

- the pinned commit (the gitlink),
- whether that commit is actually **pushed** to artcoins on GitHub (if it isn't,
  CI and fresh clones break with "object not found"),
- whether it's the live **tip** of artcoins `master` or behind it,
- the commit's message + date, so you can see *what* it is.

Exit 0 means the pin is on GitHub and consistent. Non-zero means something is
wrong, and it tells you what.

## Why it's a submodule and not just copied in

It's tempting to "just copy artcoins into PC and delete the submodule." Don't —
it's worse here. artcoins compiles against its **own** bundled copies of
v4-core, OpenZeppelin, solady, etc. (PC's build points artcoins's imports at
`lib/artcoins/lib/...`). The submodule carries the exact audited source **and**
its exact dependency closure, which is the guarantee that PC deploys the bytecode
that was audited. Copying artcoins in would either duplicate thousands of library
files (two copies of every shared lib) or recompile artcoins against PC's own
library versions, silently changing the deployed bytecode. So the submodule
stays; the fix for "pin confusion" is the `check` command above, not removal.

## Moving the pin (bumping)

Only when you've changed artcoins **and** want PC to use the new version. Order
matters: **push artcoins first**, or PC's bump won't resolve.

```bash
# 1. Commit + push in the artcoins working repo so the commit is on GitHub
#    (its master mirrors to ripe0x/artcoins, which is what the pin resolves from).
cd /path/to/artcoins-working-repo && git push

# 2. In the PC main clone, move the gitlink + materialize the source.
cd /path/to/permanent-collection
git -C contracts/lib/artcoins fetch origin
git -C contracts/lib/artcoins checkout <sha>
git add contracts/lib/artcoins

# 3. Confirm the pin + run the suite (the pin changed).
scripts/artcoins-pin.sh check
cd contracts && forge test -j 4

# 4. Commit + push. The pre-push hook re-runs forge on pin-bump pushes.
```

**In a linked worktree** the submodule often has no local `.git`, so step 2's
`checkout` won't work directly. Either bump from the main clone, or move the
gitlink with
`git update-index --cacheinfo 160000,<sha>,contracts/lib/artcoins` and
materialize the source via
`git submodule update --init --recursive --checkout contracts/lib/artcoins`.
Then `scripts/artcoins-pin.sh check` to confirm.

## The launch freeze

When the final audited artcoins commit is blessed, tag it in the artcoins repo
(e.g. `pc-launch-v1`) and pin PC to that exact commit. The Phase-1 mainnet
deploy must be from the same commit — validated against the real Phase-1 stack
— so that *deployed == audited*. After launch the pin never moves again.

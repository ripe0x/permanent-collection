#!/usr/bin/env bash
#
# artcoins-pin.sh — tell the truth about the artcoins submodule pin.
#
# The "pin" is the exact artcoins commit PC compiles and deploys against. It is
# recorded as the git submodule gitlink at contracts/lib/artcoins. THAT GITLINK
# is the single source of truth. A SHA written in a doc, a memory note, or a
# commit message is just prose — it drifts and is NOT authoritative.
#
# Usage:
#   scripts/artcoins-pin.sh            # same as: check
#   scripts/artcoins-pin.sh check      # report the pin state in plain English
#
# `check` is read-only. It uses `gh` to read the artcoins repo on GitHub;
# everything else is local git. Exit 0 if the pin is reachable on
# GitHub and consistent; non-zero if it is NOT pushed (which breaks CI + clones).
#
# Full explainer: docs/ARTCOINS_PIN.md

set -uo pipefail

REPO="ripe0x/artcoins"             # the repo .gitmodules resolves the submodule from
GITLINK="contracts/lib/artcoins"           # submodule path inside PC

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { red "Not in a git repo."; exit 2; }
cd "$ROOT" || exit 2

check() {
  local pin opin tip behind
  pin="$(git rev-parse "HEAD:$GITLINK" 2>/dev/null)" \
    || { red "No submodule gitlink at $GITLINK — run this from the permanent-collection repo."; exit 2; }

  echo "Pinned artcoins commit (the gitlink — the single source of truth):"
  echo "    $pin"

  # Surface a local-only bump: does this branch's pin match canonical master's?
  if git rev-parse --verify -q origin/master >/dev/null 2>&1; then
    opin="$(git rev-parse "origin/master:$GITLINK" 2>/dev/null || true)"
    if [ -n "$opin" ] && [ "$opin" != "$pin" ]; then
      ylw "    note: origin/master pins ${opin:0:12}… — your branch differs (local bump, not yet merged)"
    fi
  fi
  echo

  if ! command -v gh >/dev/null 2>&1; then
    ylw "gh CLI not found — can't verify GitHub state. Install gh, or check the repo manually."
    exit 0
  fi

  # 1) Is the pinned commit actually pushed to artcoins on GitHub?
  if ! gh api "repos/$REPO/commits/$pin" >/dev/null 2>&1; then
    red "✗ NOT reachable on $REPO (GitHub)."
    red "  CI and fresh clones would fail with 'object not found'."
    red "  Fix: push the artcoins commit so it reaches $REPO (master mirrors there"
    red "  from the working repo), then re-run. See docs/ARTCOINS_PIN.md."
    exit 1
  fi
  grn "✓ Pushed to GitHub:  \"$(gh api "repos/$REPO/commits/$pin" --jq '.commit.message | split("\n")[0]')\"  ($(gh api "repos/$REPO/commits/$pin" --jq '.commit.committer.date'))"

  # 2) Is it the live tip of artcoins master, or behind it?
  tip="$(gh api "repos/$REPO/branches/master" --jq '.commit.sha' 2>/dev/null || true)"
  if [ "$tip" = "$pin" ]; then
    grn "✓ It is the live tip of artcoins master (nothing newer is unpinned)."
  elif [ -n "$tip" ]; then
    # compare base=pin, head=master: ahead_by = master ahead of the pin;
    # behind_by = pin ahead of master (e.g. a branch pin not yet merged).
    ahead="$(gh api "repos/$REPO/compare/$pin...master" --jq '.ahead_by' 2>/dev/null || echo '?')"
    behind="$(gh api "repos/$REPO/compare/$pin...master" --jq '.behind_by' 2>/dev/null || echo '?')"
    if [ "$ahead" != "0" ] && [ "$behind" = "0" ]; then
      ylw "• The pin is behind master by $ahead commit(s). Fine if intentional; bump to pick up the latest (docs/ARTCOINS_PIN.md)."
    elif [ "$behind" != "0" ] && [ "$ahead" = "0" ]; then
      ylw "• The pin is $behind commit(s) ahead of master (e.g. a branch pin not yet merged). Fine if intentional."
    else
      ylw "• The pin and master have diverged (master +$ahead, pin +$behind). Check docs/ARTCOINS_PIN.md."
    fi
  fi

  echo
  grn "Pin is consistent: it is on GitHub, and what you build is what's recorded."
}

case "${1:-check}" in
  check) check ;;
  -h|--help|help) sed -n '2,18p' "$0" ;;
  *) red "unknown command: $1"; echo "usage: scripts/artcoins-pin.sh check"; exit 2 ;;
esac

"use client";

/* 111 ↔ ETH swap UI. Routes through Uniswap's Universal Router with a V4
 * swap against the native-ETH-paired 111 pool. Mirrors the artcoins
 * SwapWidget pattern: live quote via the V4 Quoter, slippage UI with
 * presets + custom, price-impact display from getSlot0(), single-engine
 * state machine (idle → preparing → awaiting-signature → awaiting-tx →
 * confirming → success/error), and a pre-flight eth_call simulation so
 * reverts surface as readable text instead of phantom "user rejected".
 *
 * Sell path uses a one-shot Permit2 PermitSingle signature — no separate
 * on-chain ERC20 approve tx. 111 inherits Solady's ERC20, which grants
 * infinite ERC20 → Permit2 allowance automatically.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi, formatEther, parseEther, parseUnits, type Hex } from "viem";
import {
  useAccount,
  useBalance,
  useChainId,
  usePublicClient,
  useReadContract,
} from "wagmi";
import { useQuery } from "@tanstack/react-query";

import { abi as quoterAbi } from "@/lib/abis/V4Quoter";
import { abi as stateViewAbi } from "@/lib/abis/StateView";
import { ConnectButton } from "./ConnectButton";
import {
  getContractAddresses,
  getTokenSymbol,
  getV4Infrastructure,
} from "@/lib/config";
import { useProtocolLive } from "@/lib/useProtocolLive";
import {
  formatEth,
  getEvmNowAddressUrl,
  getEvmNowTxUrl,
  shortAddress,
} from "@/lib/format";
import {
  buildPoolKey,
  computePoolId,
  TOKEN_IS_TOKEN_0,
} from "@/lib/swap/poolKey";

const TOKEN_SYMBOL = getTokenSymbol();
import { chainDeadlineBaseSeconds } from "@/lib/swap/chainTime";
import { usePermit2SignSwap } from "@/lib/swap/usePermit2SignSwap";
import {
  encodeAttributionHookData,
  hasAnyAttribution,
} from "@/lib/swap/attribution";
import { useReferrer } from "@/lib/swap/useReferrer";
import { ReferralShare } from "./ReferralShare";
import {
  formatTokenAmount,
  formatUsd,
  getMinimumOut,
  getPriceImpactFromAmounts,
  tokenPriceInPaired,
} from "@/lib/swap/swapMath";
import {
  formatCountdown,
  formatSkimBps,
  useAntiSniperWindow,
} from "@/lib/swap/useAntiSniperWindow";
import { useEthUsd } from "@/lib/data/useEthUsd";
import { useLiveBidBalance } from "@/lib/data/useLiveBidBalance";

type Side = "buy" | "sell";

const SLIPPAGE_PRESETS = [50, 100, 300]; // bps: 0.5%, 1%, 3%
const SLIPPAGE_MIN_BPS = 1;
const SLIPPAGE_MAX_BPS = 5000;
const DEFAULT_SLIPPAGE_BPS = 100;
// Threshold (as a fraction) above which we surface the informational
// high-impact advisory. Price impact is measured vs the pool mid and
// bundles the protocol fee + depth at this size; it is NOT a revert
// signal (see the advisory block below), so this is purely a "heads up,
// this rate is well below mid" cue. 10% keeps it quiet on routine swaps.
const HIGH_PRICE_IMPACT_THRESHOLD = 0.1;
const DEFAULT_DEADLINE_SECS = 10 * 60; // 10 minutes
const QUOTE_DEBOUNCE_MS = 300;

function formatSlippage(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

function formatPriceImpact(impact: number): string {
  if (Math.abs(impact) < 0.0001) return "<0.01%";
  const pct = (Math.abs(impact) * 100).toFixed(2);
  return impact > 0 ? `+${pct}%` : `−${pct}%`;
}

function priceImpactClass(impact: number): string {
  if (impact > 0) return "pi-good";
  if (impact <= -0.05) return "pi-bad";
  return "pi-mute";
}

function useExpectedChain(): number {
  return Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "1");
}

function SlippageControl({
  slippageBps,
  onChange,
}: {
  slippageBps: number;
  onChange: (bps: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setCustomMode(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const commitCustom = () => {
    const pct = parseFloat(customValue);
    if (!Number.isFinite(pct) || pct <= 0) {
      setCustomMode(false);
      setCustomValue("");
      return;
    }
    const bps = Math.round(pct * 100);
    const clamped = Math.min(Math.max(bps, SLIPPAGE_MIN_BPS), SLIPPAGE_MAX_BPS);
    onChange(clamped);
    setCustomMode(false);
    setCustomValue("");
    setOpen(false);
  };

  const isCustomSelection = !SLIPPAGE_PRESETS.includes(slippageBps);

  return (
    <div ref={rootRef} className="slip-root">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="slip-toggle"
      >
        <span className="slip-label">Slippage</span>
        <span className="slip-value">
          {formatSlippage(slippageBps)}
          <span className="slip-caret">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <div className="slip-row">
          {SLIPPAGE_PRESETS.map((bps) => {
            const selected = slippageBps === bps && !customMode;
            return (
              <button
                key={bps}
                type="button"
                onClick={() => {
                  onChange(bps);
                  setOpen(false);
                  setCustomMode(false);
                }}
                className={`slip-chip ${selected ? "slip-chip-on" : ""}`}
              >
                {formatSlippage(bps)}
              </button>
            );
          })}
          {customMode ? (
            <div className="slip-custom-wrap">
              <input
                type="text"
                inputMode="decimal"
                autoFocus
                value={customValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (/^[0-9]*\.?[0-9]*$/.test(v)) setCustomValue(v);
                }}
                onBlur={commitCustom}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCustom();
                  if (e.key === "Escape") {
                    setCustomMode(false);
                    setCustomValue("");
                  }
                }}
                placeholder="0.0"
                className="slip-custom-input"
              />
              <span className="slip-pct">%</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setCustomMode(true);
                setCustomValue(
                  isCustomSelection ? (slippageBps / 100).toString() : "",
                );
              }}
              className={`slip-chip ${isCustomSelection ? "slip-chip-on" : ""}`}
            >
              Custom
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function SwapBox() {
  const { address } = useAccount();
  const connectedChainId = useChainId();
  const expectedChainId = useExpectedChain();
  const onWrongNetwork =
    connectedChainId !== undefined && connectedChainId !== expectedChainId;

  const addrs = getContractAddresses();
  const v4 = getV4Infrastructure();
  // Pre-launch (no token deployed) there is no pool to read — every chain /
  // price read below is gated on this so we never query a zero-address pool
  // or show a phantom price. The whole swap UI renders, but inert.
  const live = useProtocolLive();
  const poolKey = useMemo(() => buildPoolKey(addrs.token), [addrs.token]);
  const poolId = useMemo(() => computePoolId(poolKey), [poolKey]);

  // Anti-sniper window state. Single immutable RPC read for the config,
  // then 1 Hz local tick computes currentFee + countdown. See the hook for
  // how the schedule is recomputed without per-render RPC cost. Pre-launch
  // there's no pool — pass undefined so the hook makes no read.
  const antiSniper = useAntiSniperWindow(live ? poolId : undefined);

  const swap = usePermit2SignSwap({ chainId: expectedChainId });

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("0");
  const [debouncedAmount, setDebouncedAmount] = useState("0");
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);

  // Snapshot of the last successful swap — captured on the swap→success
  // transition. Used by the success card to show what was just swapped
  // without depending on the (still-mutable) input fields. Cleared when
  // the user starts typing a new amount.
  const [completedSwap, setCompletedSwap] = useState<{
    paidAmount: bigint;
    paidSymbol: string;
    receivedAmount: bigint;
    receivedSymbol: string;
    txHash: `0x${string}`;
  } | null>(null);

  // Debounce input → quote read. Fast typists don't fire a Quoter call
  // per keystroke. The Max button writes through both via setAmountImmediate
  // so it feels instant.
  useEffect(() => {
    if (amount === debouncedAmount) return;
    const t = setTimeout(() => setDebouncedAmount(amount), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [amount, debouncedAmount]);

  const setAmountImmediate = useCallback((v: string) => {
    setAmount(v);
    setDebouncedAmount(v);
  }, []);

  const onTabChange = (next: Side) => {
    if (next === side) return;
    setSide(next);
    setAmountImmediate("0");
    if (swap.state === "error") swap.reset();
  };

  // ── Balances ───────────────────────────────────────────────────
  const ethBal = useBalance({
    address,
    chainId: expectedChainId,
    query: {
      enabled: !!address && live,
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
    },
  });
  const tokenBal = useReadContract({
    address: addrs.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: expectedChainId,
    query: {
      enabled: !!address && live,
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
    },
  });

  // ── Total supply (for MC) ──────────────────────────────────────
  // Stable across normal operation (only changes when the BuybackBurner
  // burns tokens to 0xdead), so a long stale-time is fine.
  const totalSupply = useReadContract({
    address: addrs.token,
    abi: erc20Abi,
    functionName: "totalSupply",
    chainId: expectedChainId,
    query: { enabled: live },
  });

  // ── USD pricing (Gecko proxy, with synthetic fallback) ─────────
  // Mirror of the artcoins token page: ask GeckoTerminal for ETH/USD
  // and token/USD; when Gecko hasn't indexed the token (the common
  // case for a fresh launch), synthesize tokenPriceUsd from the pool's
  // on-chain spot × ETH/USD. ETH/USD comes from the shared useEthUsd
  // hook (one react-query entry app-wide); the token side stays local.
  // The proxy lives at /api/price/<chain>/<addr>.
  const ethPriceUsd = useEthUsd();
  const tokenPriceQuery = useQuery({
    queryKey: ["gt-price", expectedChainId, addrs.token.toLowerCase()],
    queryFn: async () => {
      const r = await fetch(`/api/price/${expectedChainId}/${addrs.token}`);
      return (await r.json()) as {
        priceUsd: number | null;
        change24h: number | null;
      };
    },
    staleTime: 60_000,
    enabled: live,
  });

  // ── Parse input ────────────────────────────────────────────────
  const parsedAmount = useMemo(() => {
    const cleaned = debouncedAmount.replace(/,/g, "").trim();
    if (!cleaned || cleaned === "." || cleaned === "0.") return 0n;
    try {
      return side === "buy" ? parseEther(cleaned) : parseUnits(cleaned, 18);
    } catch {
      return 0n;
    }
  }, [debouncedAmount, side]);

  // ── Quote ──────────────────────────────────────────────────────
  // For the native-ETH-paired 111 pool: buying (ETH→token) is zeroForOne
  // (currency0 = 0x0 = ETH); selling (token→ETH) is !zeroForOne.
  const zeroForOne = side === "buy";

  const quote = useReadContract({
    address: v4.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: {
          currency0: poolKey.currency0,
          currency1: poolKey.currency1,
          fee: poolKey.fee,
          tickSpacing: poolKey.tickSpacing,
          hooks: poolKey.hooks,
        },
        zeroForOne,
        exactAmount: parsedAmount,
        hookData: "0x" as Hex,
      },
    ],
    chainId: expectedChainId,
    query: {
      enabled: parsedAmount > 0n && live,
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
      // The pool moves with every swap from anyone. A stale quote
      // would either show wrong slippage or revert at submit. Opt
      // in to 30s background polling — high enough not to thrash
      // the RPC, low enough that a user who sits on the quote for
      // a minute sees a refreshed number before submitting. Was
      // previously inherited from the global default; explicit now
      // that the default is off.
      refetchInterval: 30_000,
    },
  });
  const amountOut = (quote.data as readonly [bigint, bigint] | undefined)?.[0];
  const minOut = useMemo(
    () => (amountOut ? getMinimumOut(amountOut, slippageBps) : 0n),
    [amountOut, slippageBps],
  );

  // ── Spot reference for price-impact ────────────────────────────
  const slot0 = useReadContract({
    address: v4.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [computePoolId(poolKey)],
    chainId: expectedChainId,
    query: {
      enabled: live,
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
      // Price-impact is computed against the live spot; same cadence
      // as the quote so they stay in lockstep.
      refetchInterval: 30_000,
    },
  });
  const sqrtPriceX96 = (
    slot0.data as readonly [bigint, number, number, number] | undefined
  )?.[0];

  const priceImpact = useMemo(() => {
    if (!amountOut || parsedAmount === 0n) return 0;
    return getPriceImpactFromAmounts(
      parsedAmount,
      amountOut,
      sqrtPriceX96,
      zeroForOne,
    );
  }, [amountOut, parsedAmount, sqrtPriceX96, zeroForOne]);

  // Synthesized USD values. tokenPriceUsd preferentially uses Gecko's
  // direct quote; falls back to on-chain spot × ETH/USD for tokens
  // Gecko hasn't indexed yet. MC = totalSupply × tokenPriceUsd.
  const change24h = tokenPriceQuery.data?.change24h ?? null;
  const tokenPriceUsd = useMemo(() => {
    const direct = tokenPriceQuery.data?.priceUsd;
    if (direct != null) return direct;
    const ethPerToken = tokenPriceInPaired(sqrtPriceX96, TOKEN_IS_TOKEN_0);
    if (ethPerToken == null || ethPriceUsd == null) return null;
    return ethPerToken * ethPriceUsd;
  }, [tokenPriceQuery.data, sqrtPriceX96, ethPriceUsd]);
  const marketCapUsd = useMemo(() => {
    const supply = totalSupply.data as bigint | undefined;
    if (!supply || tokenPriceUsd == null) return null;
    return (Number(supply) / 1e18) * tokenPriceUsd;
  }, [totalSupply.data, tokenPriceUsd]);

  // USD captions on the "You pay" / "You receive" inputs. Buy: pay ETH,
  // receive token. Sell: pay token, receive ETH. Mirrors artcoins's
  // `usdCaption` helper.
  const inputUsd = useMemo(() => {
    if (parsedAmount === 0n) return null;
    const priceUsd = side === "buy" ? ethPriceUsd : tokenPriceUsd;
    if (priceUsd == null) return null;
    return (Number(parsedAmount) / 1e18) * priceUsd;
  }, [parsedAmount, side, ethPriceUsd, tokenPriceUsd]);
  // Gate the USD caption on parsedAmount > 0 so a stale cached `amountOut`
  // (from a previous non-zero input) doesn't leak through when the user
  // clears the field back to 0/empty.
  const outputUsd = useMemo(() => {
    if (!amountOut || parsedAmount === 0n) return null;
    const priceUsd = side === "buy" ? tokenPriceUsd : ethPriceUsd;
    if (priceUsd == null) return null;
    return (Number(amountOut) / 1e18) * priceUsd;
  }, [amountOut, parsedAmount, side, tokenPriceUsd, ethPriceUsd]);

  // ── Post-swap balance refetch ──────────────────────────────────
  // Shared with <LiveBidStat/> via react-query's cache, so refetching here
  // ticks the live-bid chip up across the page.
  const liveBid = useLiveBidBalance();
  const prevSwapState = useRef(swap.state);
  useEffect(() => {
    if (prevSwapState.current !== "success" && swap.state === "success") {
      ethBal.refetch();
      tokenBal.refetch();
      slot0.refetch();
      totalSupply.refetch();
      // ETH/USD (shared useEthUsd entry) is NOT refetched here — the user's
      // swap can't move the global ETH price; its 60s staleTime is the right
      // refresh. The token's own quote does move with the pool, so refetch it.
      tokenPriceQuery.refetch();
      // Snapshot the just-completed swap for the success card —
      // captured here so the card stays accurate even if the user
      // starts typing into the input field (which would otherwise
      // mutate `parsedAmount` / `amountOut` out from under us).
      if (swap.txHash && amountOut !== undefined && parsedAmount > 0n) {
        setCompletedSwap({
          paidAmount: parsedAmount,
          paidSymbol: side === "buy" ? "ETH" : TOKEN_SYMBOL,
          receivedAmount: amountOut,
          receivedSymbol: side === "buy" ? TOKEN_SYMBOL : "ETH",
          txHash: swap.txHash,
        });
      }
      // The hook splits and flushes the skim inside the swap tx itself,
      // the bid leg forwards to LiveBidAdapter at the end of _afterSwap,
      // no manual sweep, so the buffered live bid grows on the SAME
      // swap. This refetch busts the live-bid endpoint's shared cache and
      // re-pulls, so the swapper sees their own trade instantly; the
      // hook's interval poll catches everyone else's trades within a few
      // seconds (fork and mainnet alike).
      void liveBid.refetch();
      // Auto-reset the input + swap state so the button doesn't say
      // "Swap again" and the user lands in a clean state. The
      // success card stays visible via `completedSwap` (cleared
      // when the user types a new amount).
      setAmountImmediate("0");
      swap.reset();
    }
    prevSwapState.current = swap.state;
  }, [
    swap.state,
    swap.txHash,
    ethBal,
    tokenBal,
    slot0,
    totalSupply,
    tokenPriceQuery,
    side,
    parsedAmount,
    amountOut,
    liveBid,
    swap,
    setAmountImmediate,
  ]);

  // ── Referral attribution ───────────────────────────────────────
  // Resolves to the team address (the `DEFAULT_REFERRER` runtime config)
  // unless a `?ref=0x...` affiliate link overrides it. Passed as swap
  // hookData so the referral slice routes to the referrer instead of
  // staying in the protocol leg. There is no visible UI for this —
  // it's a silent default.
  const referrer = useReferrer();

  // ── Submit ─────────────────────────────────────────────────────
  // Public client used to derive the deadline base at submit. We can't
  // use `Date.now()` alone (anvil dev forks warp chain time hours off
  // wall clock via `start-dev-fork.sh`), nor the latest block timestamp
  // alone (idle anvil freezes it, then stamps the next block with real
  // wall-clock time — overshooting a `frozenTs + buffer` deadline). The
  // base is `max(blockTs, wallClock)`. See `lib/swap/chainTime.ts`.
  const publicClient = usePublicClient();
  const onSubmit = useCallback(async () => {
    if (!address || parsedAmount === 0n || !amountOut) return;
    const nowSec = publicClient
      ? await chainDeadlineBaseSeconds(publicClient)
      : Math.floor(Date.now() / 1000);
    const deadline = BigInt(nowSec + DEFAULT_DEADLINE_SECS);

    // Encode attribution as a 1-tuple PoolSwapData struct. See
    // lib/swap/attribution.ts — the 2-tuple-of-bytes encoding silently
    // fails to decode in the hook.
    const attrArgs = { referrer: referrer ?? undefined };
    const hookData: Hex = hasAnyAttribution(attrArgs)
      ? encodeAttributionHookData(attrArgs)
      : ("0x" as Hex);

    void swap.execute({
      isBuy: side === "buy",
      poolKey,
      tokenIsToken0: TOKEN_IS_TOKEN_0,
      token: addrs.token,
      amountIn: parsedAmount,
      minOut,
      recipient: address,
      deadline,
      hookData,
    });
  }, [
    address,
    parsedAmount,
    amountOut,
    swap,
    side,
    poolKey,
    addrs.token,
    minOut,
    referrer,
    publicClient,
  ]);

  // ── Derived UI state ───────────────────────────────────────────
  const sideBalance =
    side === "buy"
      ? (ethBal.data?.value ?? 0n)
      : ((tokenBal.data as bigint | undefined) ?? 0n);
  const overBalance = parsedAmount > 0n && parsedAmount > sideBalance;
  const isWorking =
    swap.state === "preparing" ||
    swap.state === "awaiting-signature" ||
    swap.state === "awaiting-tx" ||
    swap.state === "confirming";
  const quoteUnavailable =
    parsedAmount > 0n && !quote.isFetching && amountOut === undefined;

  const buttonLabel = (() => {
    if (!live) return "Not launched yet";
    if (!address) return "Connect Wallet";
    if (onWrongNetwork) return `Wrong network (chain ${connectedChainId})`;
    if (isWorking) return swap.statusLabel || "Working…";
    if (parsedAmount === 0n) return "Enter amount";
    if (overBalance)
      return `Insufficient ${side === "buy" ? "ETH" : TOKEN_SYMBOL}`;
    if (quote.isFetching && !amountOut) return "Quoting…";
    if (quoteUnavailable) return "No quote available";
    return side === "buy" ? `Buy ${TOKEN_SYMBOL}` : `Sell ${TOKEN_SYMBOL}`;
  })();

  const buttonDisabled =
    !live ||
    !address ||
    onWrongNetwork ||
    isWorking ||
    parsedAmount === 0n ||
    overBalance ||
    !amountOut ||
    quoteUnavailable;

  return (
    <>
      <div className="swap-box">
        {/* Pre-launch there's no pool, so no price or market cap — show
                "—", never a phantom number. */}
        <PriceStats
          priceUsd={live ? tokenPriceUsd : null}
          change24h={live ? change24h : null}
          marketCapUsd={live ? marketCapUsd : null}
        />

        {antiSniper.active && (
          <div className="swap-sniper" role="note" aria-live="polite">
            <div className="swap-sniper-head">
              <span className="swap-sniper-tag">Anti-sniper window</span>
              <span className="swap-sniper-countdown tnum">
                {formatCountdown(antiSniper.secondsRemaining)}
              </span>
            </div>
            <div className="swap-sniper-body">
              This pool is skimming{" "}
              <strong className="tnum">
                {formatSkimBps(antiSniper.currentSkimBps)}
              </strong>{" "}
              of each trade right now (decays from{" "}
              <strong className="tnum">
                {formatSkimBps(antiSniper.startingSkimBps)}
              </strong>{" "}
              →{" "}
              <strong className="tnum">
                {formatSkimBps(antiSniper.endingSkimBps)}
              </strong>{" "}
              linearly over the launch window).
            </div>
            <div className="swap-sniper-body">
              The overage on top of the baseline fee send{" "}
              <strong>100% to the live bid </strong>, so early-window snipers
              pay extra and every extra wei goes into the standing live bid.
            </div>
          </div>
        )}

        <div className="swap-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={side === "buy"}
            className={`swap-tab ${side === "buy" ? "swap-tab-on" : ""}`}
            onClick={() => onTabChange("buy")}
          >
            Buy {TOKEN_SYMBOL}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={side === "sell"}
            className={`swap-tab ${side === "sell" ? "swap-tab-on" : ""}`}
            onClick={() => onTabChange("sell")}
          >
            Sell {TOKEN_SYMBOL}
          </button>
        </div>

        <div className="swap-row">
          <label className="swap-label" htmlFor="swap-amount">
            {side === "buy" ? "You pay" : "You sell"}
          </label>
          <div className="swap-input">
            <input
              id="swap-amount"
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                // Only accept a non-negative decimal (digits + a
                // single dot); reject letters and other junk so the
                // field can't show un-parseable input. Same guard as
                // the custom-slippage input.
                const v = e.target.value;
                if (!/^[0-9]*\.?[0-9]*$/.test(v)) return;
                setAmount(v);
                // Dismiss the prior-swap success card the
                // moment the user starts a new trade.
                if (completedSwap) setCompletedSwap(null);
              }}
              disabled={isWorking}
            />
            <span className="swap-unit">
              {side === "buy" ? "ETH" : TOKEN_SYMBOL}
            </span>
          </div>
          {inputUsd !== null && (
            <div className="swap-usd">~{formatUsd(inputUsd)}</div>
          )}
          <div className="swap-meta">
            {address ? (
              <>
                <span>
                  Balance:{" "}
                  <strong className="tnum">
                    {side === "buy"
                      ? formatEth(ethBal.data?.value ?? 0n)
                      : `${Number(
                          formatEther(
                            (tokenBal.data as bigint | undefined) ?? 0n,
                          ),
                        ).toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })} ${TOKEN_SYMBOL}`}
                  </strong>
                </span>
                <button
                  type="button"
                  className="swap-max"
                  onClick={() => {
                    if (side === "buy") {
                      const max =
                        (ethBal.data?.value ?? 0n) - parseEther("0.01");
                      if (max > 0n) setAmountImmediate(formatEther(max));
                    } else {
                      setAmountImmediate(
                        formatEther(
                          (tokenBal.data as bigint | undefined) ?? 0n,
                        ),
                      );
                    }
                  }}
                >
                  Max
                </button>
              </>
            ) : (
              <span>Connect a wallet to swap.</span>
            )}
          </div>
        </div>

        <div className="swap-row">
          <label className="swap-label">You receive</label>
          <div className="swap-input swap-input-readonly">
            <input
              readOnly
              value={
                parsedAmount > 0n && amountOut
                  ? formatTokenAmount(amountOut)
                  : ""
              }
              placeholder={
                parsedAmount > 0n && quote.isFetching ? "Quoting…" : "0"
              }
            />
            <span className="swap-unit">
              {side === "buy" ? TOKEN_SYMBOL : "ETH"}
            </span>
          </div>
          {outputUsd !== null && (
            <div className="swap-usd">~{formatUsd(outputUsd)}</div>
          )}
        </div>

        {amountOut !== undefined && parsedAmount > 0n && (
          <div className="swap-impact-row">
            <span>Price impact</span>
            <span className={priceImpactClass(priceImpact)}>
              {formatPriceImpact(priceImpact)}
            </span>
          </div>
        )}

        <SlippageControl slippageBps={slippageBps} onChange={setSlippageBps} />

        {/* Informational high-impact advisory. Price impact is measured
         *  against the pool's mid price and bundles the protocol fee plus
         *  liquidity depth at this size; it is fully reflected in the
         *  quote above. Slippage tolerance is anchored to that quote
         *  (minOut = amountOut * (1 - slip)), so a large impact does NOT
         *  imply the swap will revert. It reverts only if the pool drifts
         *  past your slippage between quote and submit, which is
         *  independent of how far the quote already sits below mid. So
         *  this is purely advisory, never a "bump your slippage" nudge. */}
        {(() => {
          if (!amountOut || parsedAmount === 0n) return null;
          if (priceImpact > -HIGH_PRICE_IMPACT_THRESHOLD) return null;
          return (
            <div className="swap-price-impact-note" role="note">
              High price impact. This swap lands{" "}
              {formatPriceImpact(priceImpact)} below the pool&apos;s mid price
              (the protocol fee plus liquidity depth at this size). It&apos;s
              already reflected in the amount you receive above, and your
              slippage tolerance protects that amount, so it won&apos;t cause a
              revert.
            </div>
          );
        })()}

        {/* Post-swap success card — Uniswap-style prominent
         *  confirmation. Snapshots the just-completed swap so the
         *  amounts are accurate even if the user starts typing.
         *  Driven by `completedSwap`, not `swap.state`: the success
         *  effect auto-resets swap state so the button doesn't say
         *  "Swap again". Card clears when the user types a new
         *  non-zero amount. */}
        {completedSwap && (
          <div className="swap-success-card" role="status" aria-live="polite">
            <div className="swap-success-head">
              <span className="swap-success-icon" aria-hidden="true">
                ✓
              </span>
              <span className="swap-success-title">Swap successful</span>
            </div>
            <div className="swap-success-amounts">
              <span className="tnum">
                {formatTokenAmount(completedSwap.paidAmount)}{" "}
                {completedSwap.paidSymbol}
              </span>
              <span className="swap-success-arrow" aria-hidden="true">
                →
              </span>
              <span className="tnum">
                {formatTokenAmount(completedSwap.receivedAmount)}{" "}
                {completedSwap.receivedSymbol}
              </span>
            </div>
            <a
              href={getEvmNowTxUrl(completedSwap.txHash, expectedChainId)}
              target="_blank"
              rel="noopener noreferrer"
              className="swap-success-link"
            >
              View transaction →
            </a>
          </div>
        )}

        <div className="swap-actions">
          {/* Pre-launch the pool doesn't exist, so there's nothing to
           * connect a wallet for — show an inert button, not an active
           * Connect (which would open a wallet modal that leads nowhere).
           * Once live, ConnectButton renders the right thing for the
           * wallet state: connect → switch network → connected. */}
          {!live ? (
            <button type="button" className="primary swap-primary" disabled>
              Not launched yet
            </button>
          ) : !address || onWrongNetwork ? (
            <ConnectButton />
          ) : (
            <button
              type="button"
              className="primary swap-primary"
              onClick={onSubmit}
              disabled={buttonDisabled}
            >
              {buttonLabel}
            </button>
          )}
        </div>

        {!live && (
          <p className="swap-notlive" role="note">
            {TOKEN_SYMBOL} hasn&apos;t launched yet — no contracts are deployed.
            Trading, the live bid, and the collection go live at launch.
          </p>
        )}

        <div className="swap-status" aria-live="polite">
          {quoteUnavailable && (
            <span className="error">
              Quote unavailable — try a smaller amount or wait for the pool to
              absorb recent activity.
            </span>
          )}
          {swap.state === "preparing" && (
            <span>{swap.statusLabel || "Preparing…"}</span>
          )}
          {swap.state === "awaiting-signature" && (
            <span>Step 1 of 2 · sign the permit in your wallet (no gas).</span>
          )}
          {swap.state === "awaiting-tx" && side === "sell" && (
            <span>Step 2 of 2 · confirm the transaction in your wallet.</span>
          )}
          {swap.state === "confirming" && swap.txHash && (
            <span>
              Confirming on-chain…{" "}
              <TxLink hash={swap.txHash} chainId={expectedChainId} />
            </span>
          )}
          {/* Success state is rendered prominently in the
           *  <div.swap-success-card> above — no duplicate line
           *  here. */}
          {swap.state === "error" && swap.error && (
            <SwapErrorNotice text={swap.error} />
          )}
        </div>

        <style>{styles}</style>
      </div>
      {/* The fineprint (trade mechanics + contract / market links) only
            makes sense once contracts exist. Pre-launch the links would point
            at the zero address and the Permit2 note describes a flow that
            isn't live yet — hide the whole block. */}
      {live && (
        <div className="swap-belowbox">
          <p className="swap-fineprint">
            Trades route through Uniswap V4 with the artcoins hook. Sell orders
            use a single Permit2 signature, no separate approval transaction.
          </p>
          <p className="swap-fineprint swap-fineprint-muted swap-fineprint-links">
            <span>Token:</span>{" "}
            <a
              href={getEvmNowAddressUrl(addrs.token, expectedChainId)}
              target="_blank"
              rel="noreferrer"
              className="fineprint-link tnum"
            >
              {shortAddress(addrs.token)}
            </a>
            <span aria-hidden="true"> · </span>
            <a
              href={`https://dexscreener.com/ethereum/${addrs.token}`}
              target="_blank"
              rel="noreferrer"
              className="fineprint-link"
            >
              Dexscreener ↗
            </a>
          </p>
          {/* Always-present, subtle "copy your referral link" affordance.
           *  Connected users get their own `?ref=` link to share; swaps
           *  routed through it attribute the referral slice to them. */}
          {address && (
            <div className="swap-referral-line">
              <ReferralShare referrer={address} minimal />
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Two-line error display: short headline + collapsible details. The
 *  engine's `formatViemError` chain is verbose; surfacing the first line
 *  (which is usually a `shortMessage` like "User rejected the request"
 *  or the leading classification from the engine) up front keeps the
 *  panel readable, while the full chain stays one click away for
 *  debugging. */
function SwapErrorNotice({ text }: { text: string }) {
  const sep = text.indexOf("\n\n");
  const splitAt = sep !== -1 ? sep : text.indexOf("\n");
  const headline = splitAt === -1 ? text : text.slice(0, splitAt).trim();
  const details = splitAt === -1 ? "" : text.slice(splitAt).trim();
  return (
    <div className="swap-error">
      <span className="swap-error-headline">{headline}</span>
      {details && (
        <details className="swap-error-details">
          <summary>Show details</summary>
          <pre>{details}</pre>
        </details>
      )}
    </div>
  );
}

/** Two-column header above the swap controls: market cap + price (with
 *  optional 24h change). Mirrors the artcoins token page's PriceStats
 *  block. Renders "—" placeholders when Gecko hasn't returned yet so
 *  the layout doesn't jump on hydration. */
function PriceStats({
  priceUsd,
  change24h,
  marketCapUsd,
}: {
  priceUsd: number | null;
  change24h: number | null;
  marketCapUsd: number | null;
}) {
  const changeClass =
    change24h == null || change24h === 0
      ? "change-mute"
      : change24h > 0
        ? "change-up"
        : "change-down";
  const changeText =
    change24h == null
      ? null
      : `${change24h > 0 ? "+" : ""}${change24h.toFixed(Math.abs(change24h) >= 100 ? 0 : 2)}%`;
  return (
    <dl className="swap-stats">
      <div className="swap-stat">
        <dt>Market Cap</dt>
        <dd className="tnum">{formatUsd(marketCapUsd)}</dd>
      </div>
      <div className="swap-stat">
        <dt>Price</dt>
        <dd>
          <span className="tnum">{formatUsd(priceUsd)}</span>
          {changeText && (
            <span className={`swap-change ${changeClass} tnum`}>
              {changeText}
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function TxLink({ hash, chainId }: { hash: `0x${string}`; chainId: number }) {
  return (
    <a
      className="tx-link"
      href={getEvmNowTxUrl(hash, chainId)}
      target="_blank"
      rel="noreferrer"
    >
      view tx
    </a>
  );
}

const styles = `
.swap-box {
    border: 1px solid var(--ink);
    padding: clamp(28px, 4vw, 44px);
    display: flex;
    flex-direction: column;
    gap: 18px;
    background: var(--bg);
}
.swap-stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    margin: 0 0 4px;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
}
.swap-stat {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.swap-stat + .swap-stat {
    border-left: 1px solid var(--line);
}
.swap-stat dt {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 0;
}
.swap-stat dd {
    margin: 0;
    font-family: var(--mono);
    font-size: 15px;
    color: var(--ink);
    display: flex;
    align-items: baseline;
    gap: 8px;
}
.swap-change {
    font-size: 11px;
}
.swap-change.change-up { color: #2a8a3e; }
.swap-change.change-down { color: var(--danger); }
.swap-change.change-mute { color: var(--muted); }
.swap-usd {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    margin-top: -2px;
}
.swap-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
}
.swap-tab {
    background: var(--bg);
    padding: 12px 16px;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    transition: background 100ms ease, color 100ms ease;
}
/* Only un-selected tabs darken on hover. The selected tab already has an
   ink background, so darkening its text would render black-on-black. */
.swap-tab:not(.swap-tab-on):hover { color: var(--ink); }
.swap-tab-on {
    background: var(--ink);
    color: var(--bg);
}
.swap-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.swap-label {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
}
.swap-input {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--line);
    background: var(--bg);
}
.swap-input input {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 24px;
    padding: 16px 18px;
    border: none;
    background: transparent;
    color: var(--ink);
}
.swap-input-readonly input { color: var(--muted); }
.swap-input input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
}
.swap-unit {
    display: flex;
    align-items: center;
    padding: 0 18px;
    font-family: var(--mono);
    font-size: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    border-left: 1px solid var(--line);
}
.swap-meta {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    align-items: center;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
.swap-meta strong {
    color: var(--ink);
    font-weight: 500;
}
.swap-max {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
}
.swap-impact-row {
    display: flex;
    justify-content: space-between;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
}
.swap-price-impact-note {
    border: 1px solid var(--line);
    background: var(--panel);
    padding: 8px 12px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    line-height: 1.5;
}
.swap-success-card {
    border: 1px solid var(--line);
    border-left: 3px solid #2a8a3e;
    background: var(--panel);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: swap-success-enter 280ms ease-out;
}
@keyframes swap-success-enter {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
}
.swap-success-head {
    display: flex;
    align-items: center;
    gap: 10px;
}
.swap-success-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #2a8a3e;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
}
.swap-success-title {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink);
}
.swap-success-amounts {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink);
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}
.swap-success-arrow {
    color: var(--muted);
}
.swap-success-link {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    text-decoration: none;
    border-bottom: 1px dotted var(--muted);
    align-self: flex-start;
    padding-bottom: 1px;
}
.swap-success-link:hover {
    color: var(--ink);
    border-bottom-color: var(--ink);
}
.swap-sniper {
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    background: var(--panel);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.swap-sniper-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
}
.swap-sniper-tag {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
}
.swap-sniper-countdown {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
    letter-spacing: 0.04em;
}
.swap-sniper-body {
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.5;
    color: var(--muted);
}
.swap-sniper-body strong {
    color: var(--ink);
    font-weight: 500;
}
.pi-good { color: #2a8a3e; }
.pi-bad  { color: var(--danger); }
.pi-mute { color: var(--muted); }
.slip-root {
    font-family: var(--mono);
    font-size: 11px;
}
.slip-toggle {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--muted);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}
.slip-toggle:hover { color: var(--ink); }
.slip-label { color: var(--muted); }
.slip-value { display: inline-flex; gap: 6px; align-items: center; color: var(--ink); }
.slip-caret { color: var(--muted); }
.slip-row {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
}
.slip-chip {
    padding: 6px 10px;
    border: 1px solid var(--line);
    color: var(--muted);
    background: var(--bg);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    transition: border-color 100ms ease, color 100ms ease;
    cursor: pointer;
}
.slip-chip:hover {
    color: var(--ink);
    border-color: var(--ink);
}
.slip-chip-on {
    color: var(--ink);
    border-color: var(--ink);
}
.slip-custom-wrap {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--ink);
    padding: 4px 8px;
    gap: 2px;
}
.slip-custom-input {
    width: 44px;
    background: transparent;
    border: none;
    outline: none;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink);
}
.slip-pct { color: var(--muted); }
.swap-actions { display: flex; }
.swap-primary { flex: 1; }
.swap-primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
.swap-notlive {
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.55;
    letter-spacing: 0.02em;
    color: var(--muted);
    margin: 10px 0 0;
}
.swap-status {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
}
/* The status div is a permanent aria-live region, but when it has no
   message it should cost no space — swallow its own flex gap. */
.swap-status:empty {
    margin-top: -18px;
}
.swap-status .error { color: var(--danger); }
.tx-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
}
.swap-error {
    padding: 12px 14px;
    background: rgba(0, 0, 0, 0.04);
    border-left: 2px solid var(--danger);
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.swap-error-headline {
    color: var(--danger);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    word-break: break-word;
}
.swap-error-details {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
}
.swap-error-details summary {
    cursor: pointer;
    color: var(--muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-size: 10px;
    user-select: none;
}
.swap-error-details summary:hover {
    color: var(--ink);
}
.swap-error-details pre {
    margin: 8px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
    max-height: 220px;
    overflow: auto;
    color: var(--muted);
}
.swap-belowbox {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 14px;
}
.swap-referral-line {
    border-top: 1px solid var(--line);
    padding-top: 10px;
    margin-top: 2px;
}
.swap-fineprint {
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.55;
    color: var(--muted);
    margin: 0;
}
.swap-fineprint strong {
    color: var(--ink);
    font-weight: 500;
}
.swap-fineprint-muted {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--muted);
    opacity: 0.7;
}
.swap-fineprint-links {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: baseline;
    opacity: 0.85;
}
.fineprint-link {
    color: var(--muted);
    text-decoration: none;
    border-bottom: 1px dotted var(--muted);
    padding-bottom: 1px;
    transition: color 120ms ease, border-color 120ms ease;
}
.fineprint-link:hover {
    color: var(--ink);
    border-bottom-color: var(--ink);
}
`;

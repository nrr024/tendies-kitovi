// Whale tracker za TENDIES na Robinhood Chainu (chain 4663)
// 1) cita Uniswap V3 Swap dogadjaje iz TENDIES poolova
// 2) svaka kupovina >= minUsd => wallet koji je potpisao tx postaje "kit" i ulazi na watchlist
// 3) za sve kitove prati svaki TENDIES ulaz/izlaz (kupovina, prodaja, slanje drugom walletu)
// 4) profil walleta sa Blockscout-a (broj tx, ETH, sta jos drzi)
// 5) pise docs/data.json koji cita dashboard
// Samo cita lanac. Nema kljuceva, nista ne kupuje.

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));
const STATE = path.join(here, "data", "state.json");
const OUT = path.join(here, "docs", "data.json");

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const BLOCKSCOUT = "https://robinhoodchain.blockscout.com/api/v2";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const CHAIN_ID = 4663n;
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase();
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168".toLowerCase();
const FEE_TIERS = [100, 500, 3000, 10000];

const swapIface = new ethers.Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
const erc20Iface = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const SWAP_TOPIC = swapIface.getEvent("Swap").topicHash;
const TRANSFER_TOPIC = erc20Iface.getEvent("Transfer").topicHash;

const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const poolAbi = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (a) => a.toLowerCase();
const pad = (a) => ethers.zeroPadValue(a, 32);
const unpad = (t) => lc(ethers.getAddress("0x" + t.slice(26)));

// cena token1 izrazena u token0 jedinicama -> vraca koliko token1 vredi jedan token0
export function priceFromSqrt(sqrtPriceX96, dec0, dec1) {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s * 10 ** (Number(dec0) - Number(dec1)); // token1 po 1 token0
}

// Oznake su heuristika, ne presuda
export function labels(w, now) {
  const L = [];
  const acquired = w.boughtTok + w.recvTok;
  const out = w.soldTok + w.sentTok;
  const outPct = acquired > 0 ? out / acquired : 0;
  const ageDays = (now - w.firstSeen) / 86400;
  if (w.profile?.isContract) L.push("ugovor");
  if (w.profile?.txCount != null && w.profile.txCount < 15) L.push("svez wallet");
  if (w.profile?.txCount != null && w.profile.txCount > 5000) L.push("bot?");
  if (outPct >= 0.5 && w.firstOutTs && w.firstOutTs - w.firstSeen < 48 * 3600) L.push("flipper");
  else if (outPct >= 0.5) L.push("izlazi");
  else if (w.buyCount >= 3 && outPct < 0.1) L.push("akumulira");
  else if (outPct < 0.1 && ageDays >= 7) L.push("drzi");
  if (w.links.length) L.push("povezan");
  return L;
}

function loadState() {
  if (fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, "utf8"));
  return { lastBlock: null, wallets: {}, whaleBuys: [], blockTs: {} };
}

async function getLogsAdaptive(provider, filter, from, to, onChunk) {
  let step = cfg.initialChunk;
  let cur = from;
  while (cur <= to) {
    const end = Math.min(cur + step - 1, to);
    try {
      const logs = await provider.getLogs({ ...filter, fromBlock: cur, toBlock: end });
      await onChunk(logs, cur, end);
      cur = end + 1;
      if (logs.length < 2000) step = Math.min(step * 2, cfg.maxChunk);
    } catch (e) {
      if (step <= 500) throw e;
      step = Math.floor(step / 2);
      await sleep(300);
    }
  }
}

async function bs(pathname) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(BLOCKSCOUT + pathname, { headers: { accept: "application/json" } });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(800); }
  }
  return null;
}

async function profile(addr) {
  const a = await bs(`/addresses/${addr}`);
  const c = await bs(`/addresses/${addr}/counters`);
  const t = await bs(`/addresses/${addr}/tokens?type=ERC-20`);
  const holdings = (t?.items || [])
    .map((it) => {
      const dec = Number(it.token?.decimals ?? 18);
      const amt = Number(it.value) / 10 ** dec;
      const rate = Number(it.token?.exchange_rate ?? 0);
      return { symbol: String(it.token?.symbol ?? "?").slice(0, 16), address: lc(it.token?.address_hash ?? it.token?.address ?? ""), amount: amt, usd: rate ? amt * rate : null };
    })
    .sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1))
    .slice(0, 8);
  return {
    isContract: !!a?.is_contract,
    ethBalance: a?.coin_balance ? Number(ethers.formatEther(a.coin_balance)) : null,
    txCount: c?.transactions_count != null ? Number(c.transactions_count) : null,
    tokenCount: t?.items?.length ?? null,
    holdings,
    checkedAt: Math.floor(Date.now() / 1000),
  };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  // javni RPC povremeno vrati 503/429 — ponovi do 6 puta sa pauzom
  const rawSend = provider._send.bind(provider);
  provider._send = async (payload) => {
    for (let i = 0; ; i++) {
      try { return await rawSend(payload); }
      catch (e) {
        const msg = String(e?.shortMessage || e?.message || e);
        if (i >= 5 || !/503|502|504|429|timeout|ECONNRESET|socket|Service Unavailable|Too Many/i.test(msg)) throw e;
        await sleep(1500 * 2 ** i);
      }
    }
  };
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) throw new Error(`Pogresna mreza: ${net.chainId}`);

  const token = lc(cfg.token.address);
  const tok = new ethers.Contract(token, erc20Abi, provider);
  const tDec = Number(await tok.decimals());
  const factory = new ethers.Contract(
    await new ethers.Contract(ROUTER, ["function factory() view returns (address)"], provider).factory(),
    ["function getPool(address,address,uint24) view returns (address)"],
    provider
  );

  // ETH cena iz najdubljeg USDG/WETH poola
  const usdgC = new ethers.Contract(USDG, erc20Abi, provider);
  const uDec = Number(await usdgC.decimals());
  let ethUsd = 0, uwDepth = -1;
  for (const fee of FEE_TIERS) {
    const p = await factory.getPool(USDG, WETH, fee);
    if (p === ethers.ZeroAddress) continue;
    const depth = Number(await usdgC.balanceOf(p)) / 10 ** uDec;
    if (depth <= uwDepth) continue;
    const pc = new ethers.Contract(p, poolAbi, provider);
    const [t0, s0] = [lc(await pc.token0()), await pc.slot0()];
    const px = t0 === WETH ? priceFromSqrt(s0.sqrtPriceX96, 18, uDec) : 1 / priceFromSqrt(s0.sqrtPriceX96, uDec, 18);
    if (px > 100 && px < 100000) { ethUsd = px; uwDepth = depth; }
  }
  if (!ethUsd) throw new Error("Ne mogu da odredim cenu ETH");

  // TENDIES poolovi (WETH i USDG parovi)
  const pools = [];
  for (const [other, oDec, oUsd] of [[WETH, 18, ethUsd], [USDG, uDec, 1]]) {
    const oC = new ethers.Contract(other, erc20Abi, provider);
    for (const fee of FEE_TIERS) {
      const p = await factory.getPool(token, other, fee);
      if (p === ethers.ZeroAddress) continue;
      const depthUsd = (Number(await oC.balanceOf(p)) / 10 ** oDec) * oUsd;
      if (depthUsd < cfg.minPoolUsd) continue;
      const pc = new ethers.Contract(p, poolAbi, provider);
      const tIs0 = lc(await pc.token0()) === token;
      const s0 = await pc.slot0();
      const otherPerToken = tIs0 ? priceFromSqrt(s0.sqrtPriceX96, tDec, oDec) : 1 / priceFromSqrt(s0.sqrtPriceX96, oDec, tDec);
      pools.push({ address: lc(p), other, oDec, oUsd, fee, tIs0, depthUsd, priceUsd: otherPerToken * oUsd });
    }
  }
  if (!pools.length) throw new Error("Nema TENDIES poola sa dovoljno likvidnosti");
  const poolSet = new Set(pools.map((p) => p.address));
  const deepest = pools.reduce((a, b) => (b.depthUsd > a.depthUsd ? b : a));
  const priceUsd = deepest.priceUsd;

  const state = loadState();
  const latest = (await provider.getBlockNumber()) - cfg.confirmations;
  if (state.lastBlock == null) {
    // procena bloka za backfill na osnovu prosecnog vremena bloka
    const head = await provider.getBlock(latest);
    const back = await provider.getBlock(Math.max(1, latest - 1_000_000));
    const bt = (head.timestamp - back.timestamp) / (head.number - back.number) || 0.25;
    state.lastBlock = Math.max(1, latest - Math.floor((cfg.backfillDays * 86400) / bt));
    console.log(`Prvi sken: backfill ${cfg.backfillDays} dana (~${(cfg.backfillDays * 86400 / bt / 1e6).toFixed(1)}M blokova, blok ~${bt.toFixed(2)}s)`);
  }
  const from = state.lastBlock + 1;
  const to = Math.min(latest, from + cfg.maxBlocksPerRun - 1);

  const blockTs = new Map(Object.entries(state.blockTs || {}).map(([k, v]) => [Number(k), v]));
  const tsOf = async (n) => {
    if (!blockTs.has(n)) blockTs.set(n, (await provider.getBlock(n)).timestamp);
    return blockTs.get(n);
  };

  console.log(`ETH $${ethUsd.toFixed(2)} | TENDIES $${priceUsd.toPrecision(4)} | poolova ${pools.length} | blokovi ${from}..${to}`);

  if (from <= to) {
    // 1) svi swapovi u rasponu -> mapa po tx
    const swapByTx = new Map();
    const whaleCandidates = [];
    await getLogsAdaptive(provider, { address: pools.map((p) => p.address), topics: [SWAP_TOPIC] }, from, to, async (logs) => {
      for (const log of logs) {
        const pool = pools.find((p) => p.address === lc(log.address));
        const ev = swapIface.parseLog(log);
        const tAmt = pool.tIs0 ? ev.args.amount0 : ev.args.amount1;
        const oAmt = pool.tIs0 ? ev.args.amount1 : ev.args.amount0;
        const tokens = Math.abs(Number(tAmt)) / 10 ** tDec;
        const usd = (Math.abs(Number(oAmt)) / 10 ** pool.oDec) * pool.oUsd;
        const side = tAmt < 0n ? "buy" : "sell";
        const k = log.transactionHash;
        const agg = swapByTx.get(k) || { buy: { tokens: 0, usd: 0 }, sell: { tokens: 0, usd: 0 }, block: log.blockNumber };
        agg[side].tokens += tokens;
        agg[side].usd += usd;
        swapByTx.set(k, agg);
      }
    });
    for (const [tx, s] of swapByTx) if (s.buy.usd >= cfg.minUsd) whaleCandidates.push({ tx, ...s });

    // 2) ko je kupio (potpisnik transakcije)
    const known = new Set(state.whaleBuys.map((b) => b.tx));
    for (const c of whaleCandidates) {
      if (known.has(c.tx)) continue;
      const t = await provider.getTransaction(c.tx);
      const who = lc(t.from);
      const ts = await tsOf(c.block);
      state.whaleBuys.push({ tx: c.tx, wallet: who, usd: c.buy.usd, tokens: c.buy.tokens, ts, block: c.block });
      if (!state.wallets[who]) {
        state.wallets[who] = {
          address: who, firstSeen: ts, firstBlock: c.block, trackedFrom: from,
          boughtTok: 0, boughtUsd: 0, soldTok: 0, soldUsd: 0, recvTok: 0, sentTok: 0,
          buyCount: 0, sellCount: 0, firstOutTs: null, lastTs: ts, links: [], events: [], profile: null,
        };
        console.log(`Novi kit: ${who} ($${c.buy.usd.toFixed(0)})`);
      }
    }

    // 3) TENDIES transferi za sve kitove u rasponu
    const addrs = Object.keys(state.wallets);
    const seenEv = new Set();
    for (let i = 0; i < addrs.length; i += 40) {
      const group = addrs.slice(i, i + 40).map(pad);
      for (const topics of [[TRANSFER_TOPIC, group], [TRANSFER_TOPIC, null, group]]) {
        await getLogsAdaptive(provider, { address: token, topics }, from, to, async (logs) => {
          for (const log of logs) {
            const id = `${log.transactionHash}:${log.index}`;
            if (seenEv.has(id)) continue;
            seenEv.add(id);
            const fromA = unpad(log.topics[1]);
            const toA = unpad(log.topics[2]);
            const amt = Number(BigInt(log.data)) / 10 ** tDec;
            const ts = await tsOf(log.blockNumber);
            const sw = swapByTx.get(log.transactionHash);
            for (const [who, dir] of [[toA, "in"], [fromA, "out"]]) {
              const w = state.wallets[who];
              if (!w || log.blockNumber < w.trackedFrom) continue;
              const other = dir === "in" ? fromA : toA;
              let type, usd = null;
              if (dir === "in" && sw?.buy.tokens > 0) {
                type = "kupovina"; usd = sw.buy.usd * Math.min(1, amt / sw.buy.tokens);
                w.boughtTok += amt; w.boughtUsd += usd; w.buyCount++;
              } else if (dir === "out" && sw?.sell.tokens > 0) {
                type = "prodaja"; usd = sw.sell.usd * Math.min(1, amt / sw.sell.tokens);
                w.soldTok += amt; w.soldUsd += usd; w.sellCount++;
              } else if (dir === "in") {
                type = "primio"; w.recvTok += amt;
              } else {
                type = "poslao"; w.sentTok += amt;
              }
              if (dir === "out" && !w.firstOutTs) w.firstOutTs = ts;
              if (!poolSet.has(other) && state.wallets[other] && !w.links.includes(other)) w.links.push(other);
              w.lastTs = Math.max(w.lastTs, ts);
              w.events.push({ ts, type, tokens: amt, usd, counterparty: other, tx: log.transactionHash });
              if (w.events.length > cfg.maxEventsPerWallet) w.events.splice(0, w.events.length - cfg.maxEventsPerWallet);
            }
          }
        });
      }
    }
    state.lastBlock = to;
  }

  // 4) stanje i profil (novi kitovi odmah, ostali jednom dnevno, ogranicen broj po runu)
  const now = Math.floor(Date.now() / 1000);
  let profiled = 0;
  for (const w of Object.values(state.wallets)) {
    w.balance = Number(await tok.balanceOf(w.address)) / 10 ** tDec;
    const stale = !w.profile || now - w.profile.checkedAt > 86400;
    if (stale && profiled < cfg.maxProfilesPerRun) {
      const p = await profile(w.address);
      if (p) w.profile = p;
      profiled++;
      await sleep(250);
    }
  }

  // 5) izlaz za dashboard
  state.whaleBuys.sort((a, b) => b.ts - a.ts);
  state.whaleBuys = state.whaleBuys.slice(0, cfg.maxWhaleBuys);
  const flow = (sec) => {
    let buy = 0, sell = 0;
    for (const w of Object.values(state.wallets))
      for (const e of w.events)
        if (now - e.ts <= sec && e.usd != null) e.type === "kupovina" ? (buy += e.usd) : e.type === "prodaja" ? (sell += e.usd) : 0;
    return { buy, sell };
  };
  const wallets = Object.values(state.wallets).map((w) => {
    const avgEntry = w.boughtTok > 0 ? w.boughtUsd / w.boughtTok : null;
    return {
      address: w.address,
      labels: labels(w, now),
      firstSeen: w.firstSeen, lastTs: w.lastTs,
      balance: w.balance, valueUsd: w.balance * priceUsd,
      boughtTok: w.boughtTok, boughtUsd: w.boughtUsd, soldTok: w.soldTok, soldUsd: w.soldUsd,
      recvTok: w.recvTok, sentTok: w.sentTok, buyCount: w.buyCount, sellCount: w.sellCount,
      avgEntry, vsEntryPct: avgEntry ? (priceUsd / avgEntry - 1) * 100 : null,
      links: w.links, profile: w.profile, events: [...w.events].reverse().slice(0, 50),
    };
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    updated: now,
    explorer: EXPLORER,
    token: { name: cfg.token.name, address: token, priceUsd, ethUsd },
    pools: pools.map((p) => ({ address: p.address, pair: p.other === WETH ? "WETH" : "USDG", fee: p.fee / 1e4, depthUsd: p.depthUsd })),
    minUsd: cfg.minUsd,
    scannedTo: state.lastBlock, latest, caughtUp: state.lastBlock >= latest,
    flows: { d1: flow(86400), d7: flow(7 * 86400) },
    whaleBuys: state.whaleBuys.slice(0, 100),
    wallets,
  }));

  // cache timestamp-a drzi mali
  const keep = [...blockTs.entries()].sort((a, b) => b[0] - a[0]).slice(0, 2000);
  state.blockTs = Object.fromEntries(keep);
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state));
  console.log(`Gotovo: ${wallets.length} kitova, ${state.whaleBuys.length} velikih kupovina, sken do bloka ${state.lastBlock}${state.lastBlock < latest ? " (nastavlja sledeci run)" : ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(String(e?.shortMessage || e?.message || e));
    process.exit(1);
  });
}

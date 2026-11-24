import {
  AmmoraRouteClient, AmmoraDataApiClient, ammoraRouteDeployments, getAmmoraRouteDeployment,
  TAMM_GIWA_SEPOLIA_WETH,
} from "@ammora-protocol/sdk";
import { createPublicClient, createWalletClient, custom, defineChain, http, isAddress, erc20Abi, formatUnits, parseUnits } from "viem";

const CHAIN_ID = 91342;
const DATA_API = "https://ammora-giwa-sepolia-data.fly.dev";
const D = getAmmoraRouteDeployment(ammoraRouteDeployments, CHAIN_ID);
const chain = defineChain({ id: D.chainId, name: D.chainName, nativeCurrency: D.nativeCurrency,
  rpcUrls: { default: { http: [...D.rpcUrls] } }, blockExplorers: { default: { name: "Explorer", url: D.blockExplorerUrl } } });
const pub = createPublicClient({ chain, transport: http(D.rpcUrls[0]) });
const $ = (id) => document.getElementById(id);
const eth = window.ethereum;
let account = null, wallet = null;

/* ===== TOKENS: add a new one with a single line ===== */
const TOKENS = [
  { symbol: "WETH", icon: "🔷", address: TAMM_GIWA_SEPOLIA_WETH },
  { symbol: "Custom token", icon: "➕", address: "custom" },
];

const msg = (t, cls = "") => { const m = $("msg"); m.textContent = t; m.className = `status ${cls}`; };
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const explorer = (path) => `${D.blockExplorerUrl.replace(/\/$/, "")}/${path}`;
const decimalsOf = async (a) => {
  try { return await pub.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }); }
  catch (e) {
    if (/returned no data/i.test(e?.message ?? "")) throw new Error(`${short(a)} is not a token contract on GIWA Sepolia. Check the address.`);
    throw e;
  }
};
const makeRoutes = async (w) => AmmoraRouteClient.create({ client: pub, verificationBlock: (await pub.getBlockNumber()) - 12n, wallet: w });

const ui = (s) => ({ sel: $("token" + s), box: $("custom" + s), addr: $("addr" + s), info: $("info" + s) });
const addrOf = (s) => { const { sel, addr } = ui(s); const t = TOKENS[sel.value]; return t.address === "custom" ? addr.value.trim() : t.address; };

for (const [s, idx] of [["From", 0], ["To", 1]]) {
  const { sel, box, addr, info } = ui(s);
  sel.innerHTML = TOKENS.map((t, i) => `<option value="${i}">${t.icon} ${t.symbol}</option>`).join("");
  sel.selectedIndex = idx;
  sel.onchange = () => { box.classList.toggle("show", TOKENS[sel.value].address === "custom"); info.textContent = ""; };
  sel.onchange();
  addr.oninput = async () => {
    info.textContent = "";
    const a = addr.value.trim();
    if (!isAddress(a)) return;
    try {
      const [n, sy] = await Promise.all(["name", "symbol"].map((f) => pub.readContract({ address: a, abi: erc20Abi, functionName: f })));
      info.textContent = `${n} (${sy})`;
    } catch { info.textContent = "Could not read token: check the address"; }
  };
}

$("flip").onclick = () => {
  const a = ui("From"), b = ui("To");
  [a.sel.selectedIndex, b.sel.selectedIndex] = [b.sel.selectedIndex, a.sel.selectedIndex];
  [a.addr.value, b.addr.value] = [b.addr.value, a.addr.value];
  for (const x of [a, b]) { x.sel.onchange(); x.addr.oninput(); }
};

async function loadLaunches() {
  const box = $("launches");
  try {
    const { items } = await new AmmoraDataApiClient(DATA_API).getLaunches({ chainId: BigInt(CHAIN_ID) });
    box.replaceChildren();
    if (!items.length) { box.textContent = "No launches yet."; return; }
    for (const l of items.slice(0, 24)) {
      const d = document.createElement("div"); d.className = "item";
      const av = document.createElement("div"); av.className = "av";
      const h = parseInt(l.address.slice(2, 8), 16) % 360;
      av.style.background = `linear-gradient(135deg,hsl(${h} 85% 60%),hsl(${(h + 70) % 360} 85% 55%))`;
      const a = document.createElement("div"); a.textContent = short(l.address); a.style.fontWeight = "600";
      const c = document.createElement("span"); c.className = `chip ${/^[A-Z_]+$/.test(l.status) ? l.status : ""}`; c.textContent = l.status;
      const s = document.createElement("div"); s.className = "mut"; s.textContent = `block ${l.createdBlock}`;
      const k = document.createElement("a"); k.textContent = "explorer"; k.target = "_blank"; k.rel = "noopener";
      k.href = explorer(`token/${l.address}`); k.onclick = (e) => e.stopPropagation();
      d.append(av, a, c, s, k);
      d.onclick = () => {
        const t = ui("To"); t.sel.selectedIndex = TOKENS.findIndex((x) => x.address === "custom");
        t.sel.onchange(); t.addr.value = l.address; t.addr.oninput(); schedule();
        msg(`Token selected ${short(l.address)}`); $("swapcard").scrollIntoView({ behavior: "smooth" });
      };
      box.append(d);
    }
  } catch (e) { box.textContent = `Could not load launches (${e?.message ?? e}). The Data API may block browser requests.`; }
}

async function ensureChain() {
  const hex = "0x" + CHAIN_ID.toString(16);
  try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
  catch (e) {
    if (e.code !== 4902) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: D.chainName,
      nativeCurrency: D.nativeCurrency, rpcUrls: [...D.rpcUrls], blockExplorerUrls: [D.blockExplorerUrl] }] });
  }
}

$("connect").onclick = async () => {
  try {
    if (!eth) return msg("No wallet found. Install MetaMask or another browser wallet.", "er");
    [account] = await eth.request({ method: "eth_requestAccounts" });
    await ensureChain();
    wallet = createWalletClient({ account, chain, transport: custom(eth) });
    $("connect").textContent = short(account); $("swap").disabled = false; $("swap").textContent = "Swap";
    msg("Wallet connected to GIWA Sepolia.", "ok");
  } catch (e) { msg(`Wallet error: ${e?.shortMessage ?? e?.message ?? e}`, "er"); }
};

function readForm() {
  const tin = addrOf("From"), tout = addrOf("To");
  if (!isAddress(tin) || !isAddress(tout)) throw new Error("Enter two valid token addresses.");
  const slip = Number($("slip").value);
  if (!(slip > 0 && slip <= 50)) throw new Error("Slippage must be between 0 and 50 percent.");
  return { tin, tout, slippageBps: Math.round(slip * 100) };
}

/* ===== Price estimate: works WITHOUT a wallet (read-only quote) and updates as you type ===== */
const meta = new Map(); // token address -> { decimals, symbol }
const tokenMeta = async (a) => {
  const k = a.toLowerCase();
  if (!meta.has(k)) {
    const decimals = await decimalsOf(a);
    const symbol = await pub.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }).catch(() => short(a));
    meta.set(k, { decimals, symbol });
  }
  return meta.get(k);
};
let cached = { at: 0, routes: null };
const readOnlyRoutes = async () => { // reuse the verified client for 45 s to spare the public RPC
  if (!cached.routes || Date.now() - cached.at > 45000) cached = { routes: await makeRoutes(), at: Date.now() };
  return cached.routes;
};
const fmt = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumSignificantDigits: 7 }) : String(v); };

let seq = 0;
async function runQuote(manual) {
  const my = ++seq, out = $("amountTo");
  const say = (t, cls = "") => { if (my === seq) msg(t, cls); };
  const amtStr = $("amt").value.trim(), tin = addrOf("From"), tout = addrOf("To");
  if (!amtStr) { out.value = ""; return say(manual ? "Enter an amount to swap." : ""); }
  if (!/^\d+(\.\d+)?$/.test(amtStr)) { out.value = ""; return say("Enter a valid number, for example 0.01", "er"); }
  if (Number(amtStr) <= 0) { out.value = ""; return say(""); }
  if (!isAddress(tin) || !isAddress(tout)) { out.value = ""; return say("Paste the token address you want to receive to see a price. No wallet needed."); }
  if (tin.toLowerCase() === tout.toLowerCase()) { out.value = ""; return say("Choose two different tokens.", "er"); }
  try {
    say("Calculating price...");
    const slip = Number($("slip").value);
    if (!(slip > 0 && slip <= 50)) throw new Error("Slippage must be between 0 and 50 percent.");
    const [a, b] = await Promise.all([tokenMeta(tin), tokenMeta(tout)]);
    const amountIn = parseUnits(amtStr, a.decimals);
    const q = await (await readOnlyRoutes()).quoteExactIn({ tokenIn: tin, tokenOut: tout, amountIn, slippageBps: Math.round(slip * 100), recipient: account ?? undefined });
    if (my !== seq) return; // a newer request has started, drop this result
    const outHuman = formatUnits(q.expectedAmountOut, b.decimals);
    out.value = fmt(outHuman);
    say(`Rate: 1 ${a.symbol} ≈ ${fmt(Number(outHuman) / Number(amtStr))} ${b.symbol}\nMinimum received: ${fmt(formatUnits(q.minimumAmountOut, b.decimals))} ${b.symbol}\nPrice impact: ${q.priceImpactBps ?? "n/a"} bps · Route hops: ${q.hops.length}\nEstimate only. No wallet needed.`, "ok");
  } catch (e) { out.value = ""; say(`Quote failed: ${e?.shortMessage ?? e?.message ?? e}`, "er"); }
}
let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => runQuote(false), 600); };
for (const id of ["amt", "slip", "addrFrom", "addrTo"]) $(id).addEventListener("input", schedule);
for (const id of ["tokenFrom", "tokenTo"]) $(id).addEventListener("change", schedule);
$("flip").addEventListener("click", schedule);
$("quote").onclick = () => runQuote(true);

$("swap").onclick = async () => {
  try {
    if (!wallet) return msg("Connect a wallet first.", "er");
    const { tin, tout, slippageBps } = readForm();
    const dIn = await decimalsOf(tin), dOut = await decimalsOf(tout);
    const amountIn = parseUnits($("amt").value.trim(), dIn);
    await ensureChain();
    const routes = await makeRoutes(wallet);
    const q = await routes.quoteExactIn({ tokenIn: tin, tokenOut: tout, amountIn, slippageBps, recipient: account });
    if (!confirm(`Swap ${$("amt").value} (${short(tin)}) for at least ${formatUnits(q.minimumAmountOut, dOut)} (${short(tout)}) on GIWA Sepolia TESTNET?`)) return;
    const prepared = await routes.prepareExactIn(q, { payer: account, recipient: account });
    const res = await routes.execute(prepared, { sendApprovals: true, exactApproval: true, simulate: true, onStatus: (s) => msg(`Status: ${JSON.stringify(s)}`) });
    msg(`Done. Tx: ${res.hash}\n${explorer(`tx/${res.hash}`)}`, "ok");
  } catch (e) { msg(`Swap failed: ${e?.shortMessage ?? e?.message ?? e}`, "er"); }
};

loadLaunches();
runQuote(false);

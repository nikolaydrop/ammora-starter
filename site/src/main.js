import {
  AmmoraRouteClient, AmmoraDataApiClient, ammoraRouteDeployments, getAmmoraRouteDeployment,
  TAMM_MANAGED_ADDRESS, TAMM_GIWA_SEPOLIA_WETH,
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
let account = null, wallet = null, lastQuote = null;

const msg = (t, cls = "") => { const m = $("msg"); m.textContent = t; m.className = cls; };
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const explorer = (path) => `${D.blockExplorerUrl.replace(/\/$/, "")}/${path}`;
const decimalsOf = (a) => pub.readContract({ address: a, abi: erc20Abi, functionName: "decimals" });
const makeRoutes = async (w) => AmmoraRouteClient.create({ client: pub, verificationBlock: (await pub.getBlockNumber()) - 12n, wallet: w });

$("tin").value = TAMM_GIWA_SEPOLIA_WETH;
$("tout").value = TAMM_MANAGED_ADDRESS;

async function loadLaunches() {
  const box = $("launches");
  try {
    const { items } = await new AmmoraDataApiClient(DATA_API).getLaunches({ chainId: BigInt(CHAIN_ID) });
    box.replaceChildren();
    if (!items.length) { box.textContent = "No launches found."; return; }
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
      d.onclick = () => { $("tout").value = l.address; msg(`Receive token set to ${short(l.address)}`); };
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
    $("acct").textContent = short(account); $("connect").textContent = "Connected"; $("swap").disabled = false;
    msg("Wallet connected to GIWA Sepolia.", "ok");
  } catch (e) { msg(`Wallet error: ${e?.shortMessage ?? e?.message ?? e}`, "er"); }
};

function readForm() {
  const tin = $("tin").value.trim(), tout = $("tout").value.trim();
  if (!isAddress(tin) || !isAddress(tout)) throw new Error("Enter two valid token addresses.");
  const slip = Number($("slip").value);
  if (!(slip > 0 && slip <= 50)) throw new Error("Slippage must be between 0 and 50 percent.");
  return { tin, tout, slippageBps: Math.round(slip * 100) };
}

$("quote").onclick = async () => {
  try {
    msg("Getting quote...");
    const { tin, tout, slippageBps } = readForm();
    const [dIn, dOut] = await Promise.all([decimalsOf(tin), decimalsOf(tout)]);
    const amountIn = parseUnits($("amt").value.trim(), dIn);
    const routes = await makeRoutes();
    lastQuote = await routes.quoteExactIn({ tokenIn: tin, tokenOut: tout, amountIn, slippageBps, recipient: account ?? undefined });
    lastQuote.dOut = dOut;
    msg(`Expected: ${formatUnits(lastQuote.expectedAmountOut, dOut)}\nMinimum: ${formatUnits(lastQuote.minimumAmountOut, dOut)}\nPrice impact: ${lastQuote.priceImpactBps ?? "n/a"} bps\nHops: ${lastQuote.hops.length}`, "ok");
  } catch (e) { msg(`Quote failed: ${e?.shortMessage ?? e?.message ?? e}`, "er"); }
};

$("swap").onclick = async () => {
  try {
    if (!wallet) return msg("Connect a wallet first.", "er");
    const { tin, tout, slippageBps } = readForm();
    const dIn = await decimalsOf(tin), dOut = await decimalsOf(tout);
    const amountIn = parseUnits($("amt").value.trim(), dIn);
    await ensureChain();
    const routes = await makeRoutes(wallet);
    const q = await routes.quoteExactIn({ tokenIn: tin, tokenOut: tout, amountIn, slippageBps, recipient: account });
    if (!confirm(`Swap ${$("amt").value} of ${short(tin)} for at least ${formatUnits(q.minimumAmountOut, dOut)} of ${short(tout)} on GIWA Sepolia TESTNET?`)) return;
    const prepared = await routes.prepareExactIn(q, { payer: account, recipient: account });
    const res = await routes.execute(prepared, { sendApprovals: true, exactApproval: true, simulate: true, onStatus: (s) => msg(`Status: ${JSON.stringify(s)}`) });
    msg(`Done. Tx: ${res.hash}\n${explorer(`tx/${res.hash}`)}`, "ok");
  } catch (e) { msg(`Swap failed: ${e?.shortMessage ?? e?.message ?? e}`, "er"); }
};

loadLaunches();

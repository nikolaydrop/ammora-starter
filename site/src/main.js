import {
  AmmoraRouteClient, AmmoraDataApiClient, ammoraRouteDeployments, getAmmoraRouteDeployment,
  TAMM_GIWA_SEPOLIA_WETH, AMMORA_NATIVE_TOKEN, discoverAmmoraPools,
  giwaSepoliaAutoRoute, giwaSepoliaAutoRouteCatalog, giwaSepoliaAutoRouteDeploymentCatalog,
} from "@ammora-protocol/sdk";
import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, isAddress, erc20Abi, formatUnits, parseUnits } from "viem";

/* ===== TOKEN LIST: to add a coin, add ONE line here (symbol, name, address, decimals, icon) ===== */
const TOKEN_LIST = [
  { symbol: "ETH",  name: "Ether (native)", address: AMMORA_NATIVE_TOKEN,    decimals: 18, icon: "⟠" },
  { symbol: "WETH", name: "Wrapped Ether",  address: TAMM_GIWA_SEPOLIA_WETH, decimals: 18, icon: "🔷" },
  { symbol: "tAMM", name: "tAmm Coin",      address: "0x10b3cc2fc981277ada576891cf649d0aba768b06", decimals: 6, icon: "🪙" },
  // { symbol: "ABC", name: "My coin", address: "0x...", decimals: 18, icon: "🐙" },
];
const TOKENS = TOKEN_LIST.map((t) => ({ ...t, address: getAddress(t.address.toLowerCase()) }));

const CHAIN_ID = 91342;
const DATA_API = "https://ammora-giwa-sepolia-data.fly.dev";
const D = getAmmoraRouteDeployment(ammoraRouteDeployments, CHAIN_ID);
const chain = defineChain({ id: D.chainId, name: D.chainName, nativeCurrency: D.nativeCurrency,
  rpcUrls: { default: { http: [...D.rpcUrls] } }, blockExplorers: { default: { name: "Explorer", url: D.blockExplorerUrl } } });
const pub = createPublicClient({ chain, transport: http(D.rpcUrls[0]) });
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const eth = window.ethereum;
let account = null, wallet = null;

const msg = (t, cls = "") => { const m = $("msg"); m.textContent = t; m.className = `status ${cls}`; };
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const explorer = (path) => `${D.blockExplorerUrl.replace(/\/$/, "")}/${path}`;
const withTimeout = (p, ms, text) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(text)), ms))]);
const fmt = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumSignificantDigits: 7 }) : String(v); };
const decimalsOf = async (a) => {
  try { return await pub.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }); }
  catch (e) {
    if (/returned no data/i.test(e?.message ?? "")) throw new Error(`${short(a)} is not a token contract on GIWA Sepolia. Check the address.`);
    throw e;
  }
};

/* ---------- token metadata: listed tokens come from the config, custom tokens are read from the contract ---------- */
const meta = new Map(TOKENS.map((t) => [t.address.toLowerCase(), { decimals: t.decimals, symbol: t.symbol, name: t.name }]));
const tokenMeta = async (a) => {
  const k = a.toLowerCase();
  if (meta.has(k)) return meta.get(k);
  const decimals = await decimalsOf(a);
  const [symbol, name] = await Promise.all(["symbol", "name"].map((f) => pub.readContract({ address: a, abi: erc20Abi, functionName: f }).catch(() => null)));
  const m = { decimals, symbol: symbol ?? short(a), name: name ?? "Token" };
  meta.set(k, m);
  return m;
};

/* ---------- on-chain pool discovery (RPC only, no Data API). The default client has no pools of its own. ---------- */
const POOL_SEARCH_BLOCKS = 2_000_000n; // about 23 days of 1-second blocks
const POOLS_KEY = "octoswap:pools:v1", POOLS_TTL = 30 * 60 * 1000;
const ser = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v));
const de = (s) => JSON.parse(s, (k, v) => (v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v));
let poolsPromise = null;
const findPools = () => (poolsPromise ??= (async () => {
  try { const c = JSON.parse(localStorage.getItem(POOLS_KEY) ?? "null"); if (c && Date.now() - c.at < POOLS_TTL) return de(c.pools); } catch { /* no cache */ }
  const head = await pub.getBlockNumber();
  const pools = await discoverAmmoraPools({
    clients: [pub], deployment: giwaSepoliaAutoRoute,
    fromBlock: head - POOL_SEARCH_BLOCKS, toBlock: head - 12n,
    initialWindow: 20_000n, minimumWindow: 500n, maximumWindow: 500_000n,
  });
  try { localStorage.setItem(POOLS_KEY, JSON.stringify({ at: Date.now(), pools: ser(pools) })); } catch { /* storage is optional */ }
  return pools;
})().catch((e) => { poolsPromise = null; throw e; }));
const makeRoutes = async (w) => {
  try {
    const pools = await findPools();
    return await AmmoraRouteClient.create({
      client: pub, routeCatalog: giwaSepoliaAutoRouteCatalog, deploymentCatalog: giwaSepoliaAutoRouteDeploymentCatalog,
      aggregationPools: pools, verificationBlock: await pub.getBlockNumber(), wallet: w,
    });
  } catch (e) { try { localStorage.removeItem(POOLS_KEY); } catch { /* ignore */ } poolsPromise = null; throw e; }
};

/* ---------- token picker (custom dropdown with icon, symbol and name) ---------- */
const SIDES = ["From", "To"];
const st = { From: { index: 0 }, To: { index: 2 } };  // index in TOKENS, or -1 for a custom token
const customMeta = { From: null, To: null };
const ui = (s) => ({ root: $("pick" + s), box: $("custom" + s), addr: $("addr" + s), info: $("info" + s) });
const addrOf = (s) => (st[s].index >= 0 ? TOKENS[st[s].index].address : ui(s).addr.value.trim());
const closeMenus = () => {
  for (const m of document.querySelectorAll(".menu")) m.hidden = true;
  for (const b of document.querySelectorAll(".pickbtn")) b.setAttribute("aria-expanded", "false");
};
function renderPicker(s) {
  const { root, box } = ui(s), i = st[s].index, t = i >= 0 ? TOKENS[i] : null;
  root.querySelector(".pickbtn").replaceChildren(el("span", "ti", t ? t.icon : "➕"), el("span", "ts", t ? t.symbol : (customMeta[s]?.symbol ?? "Custom")), el("span", "chev", "▾"));
  box.classList.toggle("show", i < 0);
}
function buildPicker(s) {
  const btn = el("button", "pickbtn"); btn.type = "button";
  btn.setAttribute("aria-haspopup", "listbox"); btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-label", s === "From" ? "Choose the token to pay with" : "Choose the token to receive");
  const menu = el("ul", "menu"); menu.setAttribute("role", "listbox"); menu.hidden = true;
  const add = (i, icon, symbol, name) => {
    const li = el("li", "opt"); li.setAttribute("role", "option"); li.tabIndex = 0;
    const tm = el("span", "tm"); tm.append(el("b", null, symbol), el("small", null, name));
    li.append(el("span", "ti", icon), tm);
    const pick = () => { st[s].index = i; renderPicker(s); closeMenus(); if (i < 0) ui(s).addr.focus(); schedule(); };
    li.onclick = pick;
    li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
    menu.append(li);
  };
  TOKENS.forEach((t, i) => add(i, t.icon, t.symbol, t.name));
  add(-1, "➕", "Custom token", "Paste a contract address");
  btn.onclick = (e) => { e.stopPropagation(); const open = menu.hidden; closeMenus(); menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  ui(s).root.replaceChildren(btn, menu);
  renderPicker(s);
}
document.addEventListener("click", (e) => { if (!e.target.closest(".picker")) closeMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });

/* after a valid address is pasted, read symbol, name and decimals from the contract and show them */
async function readCustom(s) {
  const { addr, info } = ui(s), a = addr.value.trim();
  customMeta[s] = null; renderPicker(s); info.textContent = "";
  if (!a) return;
  if (!isAddress(a)) { if (a.length >= 42) info.textContent = "Invalid address. Check the characters and capital letters."; return; }
  info.textContent = "Reading token...";
  try {
    const m = await tokenMeta(a);
    if (addr.value.trim() !== a) return;
    customMeta[s] = m; renderPicker(s);
    info.textContent = `${m.symbol} · ${m.name} · ${m.decimals} decimals`;
  } catch (e) {
    const m = e?.message ?? "";
    if (addr.value.trim() === a) info.textContent = /not a token contract/.test(m) ? m : "Could not read this token. Check the address and your connection.";
  }
}
const useCustomAddress = (s, address) => { st[s].index = -1; ui(s).addr.value = address; renderPicker(s); readCustom(s); schedule(); };

$("flip").onclick = () => {
  [st.From, st.To] = [st.To, st.From];
  [customMeta.From, customMeta.To] = [customMeta.To, customMeta.From];
  const a = ui("From"), b = ui("To");
  [a.addr.value, b.addr.value] = [b.addr.value, a.addr.value];
  [a.info.textContent, b.info.textContent] = [b.info.textContent, a.info.textContent];
  SIDES.forEach(renderPicker);
};

/* ---------- slippage: quick buttons plus a custom input ---------- */
const syncChips = () => { for (const b of document.querySelectorAll(".sbtn")) b.classList.toggle("on", Number(b.dataset.v) === Number($("slip").value)); };
for (const b of document.querySelectorAll(".sbtn")) b.onclick = () => { $("slip").value = b.dataset.v; syncChips(); schedule(); };
$("slip").addEventListener("input", syncChips);

/* ---------- launches list ---------- */
async function loadLaunches() {
  const box = $("launches"), hint = $("launchHint");
  try {
    const { items } = await withTimeout(new AmmoraDataApiClient(DATA_API).getLaunches({ chainId: BigInt(CHAIN_ID) }), 10000, "timeout");
    box.replaceChildren();
    if (!items.length) { box.textContent = "No launches yet 🐙"; return; }
    for (const l of items.slice(0, 24)) {
      const d = el("div", "item");
      const av = el("div", "av"), h = parseInt(l.address.slice(2, 8), 16) % 360;
      av.style.background = `linear-gradient(135deg,hsl(${h} 85% 60%),hsl(${(h + 70) % 360} 85% 55%))`;
      const a = el("div", null, short(l.address)); a.style.fontWeight = "600";
      const c = el("span", `chip ${/^[A-Z_]+$/.test(l.status) ? l.status : ""}`, l.status);
      const s = el("div", "mut", `block ${l.createdBlock}`);
      const k = el("a", null, "explorer"); k.target = "_blank"; k.rel = "noopener";
      k.href = explorer(`token/${l.address}`); k.onclick = (e) => e.stopPropagation();
      d.append(av, a, c, s, k);
      d.onclick = () => { useCustomAddress("To", l.address); msg(`Token selected: ${short(l.address)}`); $("swapcard").scrollIntoView({ behavior: "smooth" }); };
      box.append(d);
    }
    hint.hidden = false;
  } catch (e) {
    console.warn("Launches could not be loaded:", e?.message ?? e);
    box.textContent = "Couldn't load launches"; hint.hidden = true;
  }
}

/* ---------- wallet ---------- */
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
  if (!isAddress(tin) || !isAddress(tout)) throw new Error("Pick or paste two valid tokens.");
  if (tin.toLowerCase() === tout.toLowerCase()) throw new Error("Choose two different tokens.");
  const slip = Number($("slip").value);
  if (!(slip > 0 && slip <= 50)) throw new Error("Slippage must be between 0 and 50 percent.");
  return { tin, tout, slippageBps: Math.round(slip * 100) };
}

/* ---------- price estimate: works WITHOUT a wallet (read-only quote) and updates as you type ---------- */
let cached = { at: 0, routes: null };
const readOnlyRoutes = async (say) => { // reuse the verified client for 45 s to spare the public RPC
  if (cached.routes && Date.now() - cached.at <= 45000) return cached.routes;
  let tick;
  if (!poolsPromise) {
    const t0 = Date.now(), note = () => say(`Searching Ammora pools on-chain (first visit only, up to a minute)... ${Math.round((Date.now() - t0) / 1000)} s`);
    note(); tick = setInterval(note, 1000);
  }
  try { cached = { routes: await withTimeout(makeRoutes(), 120000, "Pool search timed out. The RPC may limit log ranges. Try again in a minute."), at: Date.now() }; }
  finally { clearInterval(tick); }
  return cached.routes;
};
const setInfo = (d) => { $("info").hidden = !d; if (d) { $("iRate").textContent = d.rate; $("iMin").textContent = d.min; $("iSlip").textContent = d.slip; } };

let seq = 0;
async function runQuote() {
  const my = ++seq, out = $("amountTo"), live = () => my === seq;
  const say = (t, cls = "") => { if (live()) msg(t, cls); };
  const reset = (t = "", cls = "") => { if (live()) { out.value = ""; setInfo(null); msg(t, cls); } };
  const amtStr = $("amt").value.trim(), tin = addrOf("From"), tout = addrOf("To");
  if (!amtStr) return reset();
  if (!/^\d+(\.\d+)?$/.test(amtStr)) return reset("Enter a valid number, for example 0.01", "er");
  if (Number(amtStr) <= 0) return reset();
  if (!isAddress(tin) || !isAddress(tout)) return reset("Pick or paste the tokens to see a price. No wallet needed.");
  if (tin.toLowerCase() === tout.toLowerCase()) return reset("Choose two different tokens.", "er");
  try {
    out.value = ""; setInfo(null); say("Calculating price...");
    const slip = Number($("slip").value);
    if (!(slip > 0 && slip <= 50)) throw new Error("Slippage must be between 0 and 50 percent.");
    const [a, b] = await Promise.all([tokenMeta(tin), tokenMeta(tout)]);
    const amountIn = parseUnits(amtStr, a.decimals);
    const q = await (await readOnlyRoutes(say)).quoteExactIn({ tokenIn: tin, tokenOut: tout, amountIn, slippageBps: Math.round(slip * 100), recipient: account ?? undefined });
    if (!live()) return; // a newer request has started, drop this result
    const outHuman = formatUnits(q.expectedAmountOut, b.decimals);
    out.value = fmt(outHuman);
    setInfo({ rate: `1 ${a.symbol} = ${fmt(Number(outHuman) / Number(amtStr))} ${b.symbol}`, min: `${fmt(formatUnits(q.minimumAmountOut, b.decimals))} ${b.symbol}`, slip: `${slip}%` });
    say("");
  } catch (e) { reset(`Quote failed: ${e?.shortMessage ?? e?.message ?? e}`, "er"); }
}
let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(runQuote, 600); };
for (const id of ["amt", "slip", "addrFrom", "addrTo"]) $(id).addEventListener("input", schedule);
$("flip").addEventListener("click", schedule);

/* ---------- swap (needs a wallet) ---------- */
$("swap").onclick = async () => {
  try {
    if (!wallet) return msg("Connect a wallet first.", "er");
    const { tin, tout, slippageBps } = readForm();
    const [{ decimals: dIn }, { decimals: dOut }] = await Promise.all([tokenMeta(tin), tokenMeta(tout)]);
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

/* ---------- start ---------- */
for (const s of SIDES) { buildPicker(s); ui(s).addr.addEventListener("input", () => readCustom(s)); }
syncChips();
loadLaunches();
runQuote();

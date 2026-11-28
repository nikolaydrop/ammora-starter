import {
  AmmoraDataApiClient, ammoraRouteDeployments, getAmmoraRouteDeployment,
  buildV3NativePoolExactInput, buildV3PoolExactInputForNative, TAMM_GIWA_SEPOLIA_WETH,
} from "@ammora-protocol/sdk";
import {
  createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, erc20Abi, fallback,
  formatEther, formatUnits, getAddress, http, isAddress, parseEther, parseUnits, zeroAddress,
} from "viem";

/* ===== TOKEN LIST: to add a coin, add ONE line here =====
   address: null means the native coin (ETH). A token that can be swapped against ETH also needs its
   pool, the native router that executes the swap, and quoteToken (the wrapped native token the pool is priced in). */
const TOKEN_LIST = [
  { symbol: "ETH",  name: "Ether (native)", address: null, decimals: 18, icon: "⟠" },
  { symbol: "tAMM", name: "tAmm Coin", address: "0x10b3cc2fc981277ada576891cf649d0aba768b06", decimals: 6, icon: "🪙",
    pool: "0x1EF92A6a9BB4bBed2b385Dd5E688F88e7965BCf8", router: "0x4FC91b90087288520A7bB4aA7Ab5441bb4E9C496", quoteToken: TAMM_GIWA_SEPOLIA_WETH },
  // { symbol: "ABC", name: "My coin", address: "0x...", decimals: 18, icon: "🐙", pool: "0x...", router: "0x...", quoteToken: "0x..." },
];
const norm = (a) => (a ? getAddress(a.toLowerCase()) : null);
const TOKENS = TOKEN_LIST.map((t) => ({ ...t, native: !t.address, address: norm(t.address), pool: norm(t.pool), router: norm(t.router), quoteToken: norm(t.quoteToken) }));

/* pool view used for the price: quoteExactIn(tokenIn, amountIn) returns the amount out */
const POOL_ABI = [{ type: "function", name: "quoteExactIn", stateMutability: "view",
  inputs: [{ name: "tokenIn", type: "address" }, { name: "amountIn", type: "uint256" }], outputs: [{ name: "amountOut", type: "uint256" }] }];

const CHAIN_ID = 91342;
const DATA_API = "https://ammora-giwa-sepolia-data.fly.dev";
const FALLBACK_RPC = "https://sepolia-rpc-flashblocks.giwa.io"; // second official GIWA Sepolia endpoint
const RPC_TIMEOUT_MS = 15000;   // every price request gives up after 15 s, then the Retry button appears
const D = getAmmoraRouteDeployment(ammoraRouteDeployments, CHAIN_ID);
const RPC_URLS = [D.rpcUrls[0], FALLBACK_RPC];
const chain = defineChain({ id: D.chainId, name: D.chainName, nativeCurrency: D.nativeCurrency,
  rpcUrls: { default: { http: RPC_URLS } }, blockExplorers: { default: { name: "Explorer", url: D.blockExplorerUrl } } });
// each endpoint gets 7 s, so the primary plus the fallback fit inside the 15 s limit
const pub = createPublicClient({ chain, transport: fallback(RPC_URLS.map((u) => http(u, { timeout: 7000, retryCount: 0 })), { retryCount: 0 }) });
const GAS_RESERVE = parseEther("0.0005"); // "Max" keeps this much ETH for gas

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const eth = window.ethereum;
let account = null, wallet = null, walletChain = null;

const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const explorer = (path) => `${D.blockExplorerUrl.replace(/\/$/, "")}/${path}`;
const errText = (e) => (e?.code === 4001 || /user rejected|denied/i.test(e?.message ?? "") ? "Request rejected in the wallet." : e?.shortMessage ?? e?.message ?? String(e));
const fmt = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumSignificantDigits: 7 }) : String(v); };
const fmtBal = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 6 }) : String(v); };
const withTimeout = (p, ms, text) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(text)), ms))]);

/* status line, optionally with a link (built with DOM nodes, never innerHTML) */
function msg(text, cls = "", link = null) {
  const m = $("msg"); m.className = `status ${cls}`; m.replaceChildren(document.createTextNode(text));
  if (link) { const a = el("a", null, link.text); a.href = link.href; a.target = "_blank"; a.rel = "noopener"; m.append(document.createTextNode(" "), a); }
}
let retryFn = null;
const hideRetry = () => { retryFn = null; $("retry").hidden = true; };
const showRetry = (fn) => { retryFn = fn; $("retry").hidden = false; };
$("retry").onclick = () => retryFn?.();

/* ---------- token metadata: listed tokens come from the config, custom tokens are read from the contract ---------- */
const meta = new Map(TOKENS.filter((t) => t.address).map((t) => [t.address.toLowerCase(), { decimals: t.decimals, symbol: t.symbol, name: t.name }]));
const tokenMeta = async (a) => {
  const k = a.toLowerCase();
  if (meta.has(k)) return meta.get(k);
  let decimals;
  try { decimals = await pub.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }); }
  catch (e) {
    if (/returned no data/i.test(e?.message ?? "")) throw new Error(`${short(a)} is not a token contract on GIWA Sepolia. Check the address.`);
    throw e;
  }
  const [symbol, name] = await Promise.all(["symbol", "name"].map((f) => pub.readContract({ address: a, abi: erc20Abi, functionName: f }).catch(() => null)));
  const m = { decimals, symbol: symbol ?? short(a), name: name ?? "Token" };
  meta.set(k, m);
  return m;
};

/* ---------- token picker (dropdown with icon, symbol and name) ---------- */
const SIDES = ["From", "To"];
const st = { From: { index: 0 }, To: { index: 1 } };  // index in TOKENS, or -1 for a custom token. Start with ETH to tAMM.
const customMeta = { From: null, To: null };
const ui = (s) => ({ root: $("pick" + s), box: $("custom" + s), addr: $("addr" + s), info: $("info" + s) });
function tokenOf(s) {
  const i = st[s].index;
  if (i >= 0) return TOKENS[i];
  const m = customMeta[s], a = ui(s).addr.value.trim();
  return m && isAddress(a) ? { custom: true, native: false, address: norm(a), symbol: m.symbol, name: m.name, decimals: m.decimals } : null;
}
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
    const pick = () => { st[s].index = i; renderPicker(s); closeMenus(); if (i < 0) ui(s).addr.focus(); refreshBalances(); schedule(); };
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
    refreshBalances(); schedule();
  } catch (e) {
    console.error("Custom token read failed:", e);
    const t = e?.message ?? "";
    if (addr.value.trim() === a) info.textContent = /not a token contract/.test(t) ? t : "Could not read this token. Check the address and your connection.";
  }
}
const useCustomAddress = (s, address) => { st[s].index = -1; ui(s).addr.value = address; renderPicker(s); readCustom(s); };

$("flip").onclick = () => {
  [st.From, st.To] = [st.To, st.From];
  [customMeta.From, customMeta.To] = [customMeta.To, customMeta.From];
  const a = ui("From"), b = ui("To");
  [a.addr.value, b.addr.value] = [b.addr.value, a.addr.value];
  [a.info.textContent, b.info.textContent] = [b.info.textContent, a.info.textContent];
  SIDES.forEach(renderPicker);
  refreshBalances(); schedule();
};

/* ---------- slippage: quick buttons plus a custom input ---------- */
const syncChips = () => { for (const b of document.querySelectorAll(".sbtn")) b.classList.toggle("on", Number(b.dataset.v) === Number($("slip").value)); };
for (const b of document.querySelectorAll(".sbtn")) b.onclick = () => { $("slip").value = b.dataset.v; syncChips(); schedule(); };
$("slip").addEventListener("input", syncChips);
function readSlippageBps() {
  const slip = Number($("slip").value);
  if (!(slip > 0 && slip <= 50)) throw new Error("Slippage must be between 0 and 50 percent.");
  return Math.round(slip * 100);
}
function readAmount() {
  const v = $("amt").value.trim().replace(",", ".");
  if (!v) return null;
  if (!/^(\d+\.?\d*|\.\d+)$/.test(v)) throw new Error("Enter a valid number, for example 0.1");
  return Number(v) > 0 ? v : null;
}

/* ---------- which pool does the current pair use? Only ETH pairs with a configured pool can be priced ---------- */
function pairOf() {
  const a = tokenOf("From"), b = tokenOf("To");
  if (!a || !b) return { error: "Pick or paste both tokens to see a price." };
  if (a.native === b.native && (a.native || a.address === b.address)) return { error: "Choose two different tokens." };
  const token = a.native ? b : b.native ? a : null;
  if (!token) return { error: "Only ETH pairs are available. Choose ETH on one side." };
  if (!token.pool || !token.router) return { error: `No Ammora pool is configured for ${token.symbol}. Add its pool and router to TOKEN_LIST at the top of main.js.` };
  return { buying: a.native, token, pool: token.pool, router: token.router, from: a, to: b };
}
const quoteRaw = (pair, amountIn) => withTimeout(
  pub.readContract({ address: pair.pool, abi: POOL_ABI, functionName: "quoteExactIn", args: [pair.buying ? pair.token.quoteToken : pair.token.address, amountIn] }),
  RPC_TIMEOUT_MS, "The RPC did not answer within 15 seconds.");

/* ---------- price estimate: no wallet needed, updates 300 ms after the last keystroke ---------- */
/* shrink the font of an amount field until the whole number fits next to the token button */
const fit = (inp) => {
  inp.style.fontSize = "";
  let fs = parseFloat(getComputedStyle(inp).fontSize);
  while (inp.scrollWidth > inp.clientWidth && fs > 13) { fs -= 1; inp.style.fontSize = fs + "px"; }
};
const setOut = (v) => { const o = $("amountTo"); o.value = v; fit(o); };
const setInfo = (d) => { $("info").hidden = !d; if (d) { $("iRate").textContent = d.rate; $("iMin").textContent = d.min; $("iSlip").textContent = d.slip; } };
let seq = 0;
async function runQuote(keepStatus = false) { // keepStatus: do not wipe the transaction status after a swap
  const my = ++seq, out = $("amountTo"), live = () => my === seq;
  const reset = (t = "", cls = "") => { if (live()) { setOut(""); setInfo(null); if (!keepStatus || t) msg(t, cls); } };
  hideRetry();
  let amtStr;
  try { amtStr = readAmount(); } catch (e) { return reset(e.message, "er"); }
  if (!amtStr) return reset();
  const pair = pairOf();
  if (pair.error) return reset(pair.error, /Choose|Only ETH|No Ammora/.test(pair.error) ? "er" : "");
  try {
    setOut("..."); setInfo(null); if (!keepStatus) msg("");
    const bps = readSlippageBps();
    const amountIn = parseUnits(amtStr, pair.from.decimals);
    const outRaw = await quoteRaw(pair, amountIn);
    if (!live()) return; // a newer keystroke has started another request
    const outHuman = formatUnits(outRaw, pair.to.decimals);
    setOut(fmt(outHuman));
    setInfo({ rate: `1 ${pair.from.symbol} ≈ ${fmt(Number(outHuman) / Number(amtStr))} ${pair.to.symbol}`,
      min: `${fmt(formatUnits((outRaw * BigInt(10000 - bps)) / 10000n, pair.to.decimals))} ${pair.to.symbol}`, slip: `${bps / 100}%` });
  } catch (e) {
    console.error("Quote failed:", e);
    if (!live()) return;
    reset(`Quote failed: ${errText(e)}`, "er"); showRetry(runQuote);
  }
}
let timer;
const schedule = () => { clearTimeout(timer); timer = setTimeout(runQuote, 300); };
for (const id of ["amt", "slip", "addrFrom", "addrTo"]) $(id).addEventListener("input", schedule);
$("amt").addEventListener("input", () => fit($("amt")));
window.addEventListener("resize", () => { fit($("amt")); fit($("amountTo")); });
for (const s of SIDES) ui(s).addr.addEventListener("input", () => readCustom(s));

/* ---------- wallet: connection, network, balances (all through the wallet provider) ---------- */
function setAccount(a) {
  account = a ? norm(a) : null; // checksummed form, whatever case the wallet returns
  wallet = account ? createWalletClient({ account, chain, transport: custom(eth) }) : null;
  updateWalletUi();
}
function updateWalletUi() {
  const wrong = !!account && walletChain !== CHAIN_ID;
  $("connect").textContent = account ? short(account) : "Connect wallet";
  $("switchNet").hidden = !wrong;
  $("swap").textContent = !account ? "Connect wallet to swap" : wrong ? "Switch to GIWA Sepolia" : "Swap";
}
async function syncChain() {
  try { walletChain = parseInt(await eth.request({ method: "eth_chainId" }), 16); }
  catch (e) { console.error("eth_chainId failed:", e); walletChain = null; }
  updateWalletUi();
}
async function switchChain() {
  const hex = "0x" + CHAIN_ID.toString(16);
  try {
    try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
    catch (e) {
      if (e?.code !== 4902 && !/unrecognized chain|not been added|add the chain/i.test(e?.message ?? "")) throw e;
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: D.chainName,
        nativeCurrency: D.nativeCurrency, rpcUrls: RPC_URLS, blockExplorerUrls: [D.blockExplorerUrl] }] });
    }
    await syncChain(); refreshBalances();
  } catch (e) { console.error("Network switch failed:", e); msg(`Could not switch network: ${errText(e)}`, "er"); }
}
async function connectWallet() {
  if (!eth) { msg("No wallet found. Install MetaMask or another browser wallet.", "er"); return; }
  try {
    const accs = await eth.request({ method: "eth_requestAccounts" });
    setAccount(accs[0]); await syncChain();
    refreshBalances(); // loads on its own, it does not wait for the price or anything else
    walletChain === CHAIN_ID ? msg("Wallet connected to GIWA Sepolia.", "ok") : msg("Wallet connected, but it is on another network. Switch to GIWA Sepolia.", "er");
  } catch (e) { console.error("Wallet connection failed:", e); msg(`Wallet error: ${errText(e)}`, "er"); }
}
$("connect").onclick = connectWallet;
$("switchNet").onclick = switchChain;
if (eth?.on) {
  eth.on("accountsChanged", (accs) => { setAccount(accs?.[0] ?? null); refreshBalances(); });
  eth.on("chainChanged", async () => { await syncChain(); refreshBalances(); });
}

const balances = { From: null, To: null };
async function balanceOf(t) {
  if (t.native) return BigInt(await eth.request({ method: "eth_getBalance", params: [account, "latest"] }));
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [account] });
  return BigInt(await eth.request({ method: "eth_call", params: [{ to: t.address, data }, "latest"] }));
}
function renderBalances() {
  for (const s of SIDES) {
    const t = tokenOf(s), b = balances[s];
    $("bal" + s).textContent = t && b != null ? `Balance: ${fmtBal(t.native ? formatEther(b) : formatUnits(b, t.decimals))} ${t.symbol}` : "";
  }
  $("maxBtn").hidden = !(balances.From > 0n);
}
let balSeq = 0;
async function refreshBalances() {
  const my = ++balSeq;
  $("balErr").hidden = true; balances.From = balances.To = null; renderBalances();
  if (!eth || !account || walletChain !== CHAIN_ID) return;
  const toks = SIDES.map(tokenOf);
  const res = await Promise.allSettled(toks.map((t) => (t ? balanceOf(t) : Promise.resolve(null))));
  if (my !== balSeq) return;
  const errs = [];
  res.forEach((r, i) => {
    if (r.status === "fulfilled") balances[SIDES[i]] = r.value;
    else { console.error(`Balance read failed (${toks[i]?.symbol}):`, r.reason); errs.push(`${toks[i]?.symbol ?? "token"}: ${errText(r.reason)}`); }
  });
  renderBalances();
  if (errs.length) { $("balErrText").textContent = `Could not read the balance. ${errs.join(" | ")}`; $("balErr").hidden = false; }
}
$("balRetry").onclick = refreshBalances;
$("maxBtn").onclick = () => {
  const t = tokenOf("From"), b = balances.From;
  if (!t || b == null) return;
  const v = t.native ? (b > GAS_RESERVE ? b - GAS_RESERVE : 0n) : b; // ETH: keep a little for gas
  $("amt").value = t.native ? formatEther(v) : formatUnits(v, t.decimals);
  fit($("amt")); schedule();
};

/* ---------- swap, built with the Ammora SDK ---------- */
async function sendAndWatch(label, send) {
  const hash = await send();
  const link = { href: explorer(`tx/${hash}`), text: "View on explorer" };
  msg(`${label} pending...`, "", link);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180000 });
  if (r.status !== "success") { msg(`${label} failed: the transaction reverted.`, "er", link); const e = new Error("reverted"); e.reported = true; throw e; }
  msg(`${label} confirmed.`, "ok", link);
  return r;
}
let busy = false;
async function doSwap() {
  if (!account) return connectWallet();
  if (walletChain !== CHAIN_ID) return switchChain();
  if (busy) return;
  busy = true; $("swap").disabled = true;
  try {
    const pair = pairOf(); if (pair.error) throw new Error(pair.error);
    const amtStr = readAmount(); if (!amtStr) throw new Error("Enter an amount first.");
    const bps = readSlippageBps();
    const amountIn = parseUnits(amtStr, pair.from.decimals);
    if (balances.From != null && amountIn > balances.From) throw new Error(`Not enough ${pair.from.symbol} in your wallet.`);
    msg("Getting a fresh price...");
    const quoted = await quoteRaw(pair, amountIn);
    const minOut = (quoted * BigInt(10000 - bps)) / 10000n; // the slippage setting protects the minimum received
    if (!confirm(`Swap ${amtStr} ${pair.from.symbol} for at least ${fmt(formatUnits(minOut, pair.to.decimals))} ${pair.to.symbol} on GIWA Sepolia TESTNET?\nRouter: ${short(pair.router)}`)) { msg(""); return; }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    let tx;
    if (pair.buying) { // ETH to token
      const { data, value } = buildV3NativePoolExactInput(pair.pool, amountIn, minOut, account, deadline, zeroAddress);
      tx = { to: pair.router, data, value };
    } else {           // token to ETH: the router needs an allowance first
      const allowance = await pub.readContract({ address: pair.token.address, abi: erc20Abi, functionName: "allowance", args: [account, pair.router] });
      if (allowance < amountIn) {
        msg(`Approve ${pair.token.symbol} in your wallet...`);
        await sendAndWatch("Approval", () => wallet.writeContract({ account, chain, address: pair.token.address, abi: erc20Abi, functionName: "approve", args: [pair.router, amountIn] }));
      }
      const { data } = buildV3PoolExactInputForNative(pair.pool, pair.token.address, amountIn, minOut, account, deadline, zeroAddress);
      tx = { to: pair.router, data, value: 0n };
    }
    try { await pub.estimateGas({ account, ...tx }); } // surfaces the real revert reason before anything is sent
    catch (e) { console.error("Swap simulation failed:", e); msg(`The swap would fail: ${errText(e)}`, "er"); return; }
    await sendAndWatch("Swap", () => wallet.sendTransaction({ account, chain, ...tx }));
    refreshBalances(); runQuote(true);
  } catch (e) {
    console.error("Swap failed:", e);
    if (!e.reported) msg(`Swap failed: ${errText(e)}`, "er");
  } finally { busy = false; $("swap").disabled = false; updateWalletUi(); }
}
$("swap").onclick = doSwap;

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
      d.onclick = () => { useCustomAddress("To", l.address); $("swapcard").scrollIntoView({ behavior: "smooth" }); };
      box.append(d);
    }
    hint.hidden = false;
  } catch (e) {
    console.warn("Launches could not be loaded:", e?.message ?? e);
    box.textContent = "Couldn't load launches"; hint.hidden = true;
  }
}

/* ---------- start ---------- */
for (const s of SIDES) buildPicker(s);
syncChips(); updateWalletUi(); fit($("amt")); loadLaunches(); runQuote();
if (eth) { // pick up a wallet that is already connected to this site, without a popup
  eth.request({ method: "eth_accounts" }).then(async (accs) => {
    if (accs?.[0]) { setAccount(accs[0]); await syncChain(); refreshBalances(); }
  }).catch((e) => console.error("eth_accounts failed:", e));
}

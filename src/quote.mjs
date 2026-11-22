// Read-only swap quote (exact input). Does NOT send any transaction.
// Usage: npm run quote -- <tokenIn> <tokenOut> <amountInRaw> [slippageBps]
// amountInRaw is in the token's smallest unit (18 decimals: 1 token = 1000000000000000000).
import { isAddress } from "viem";
import { createReadOnlyRoutes } from "./client.mjs";

const [tokenIn, tokenOut, amount, slippage = "100"] = process.argv.slice(2);

if (!isAddress(tokenIn ?? "") || !isAddress(tokenOut ?? "") || !/^\d+$/.test(amount ?? "")) {
  console.error("Usage: npm run quote -- <tokenIn 0x..> <tokenOut 0x..> <amountInRaw> [slippageBps]");
  process.exit(1);
}

try {
  const { routes } = await createReadOnlyRoutes();
  const quote = await routes.quoteExactIn({
    tokenIn,
    tokenOut,
    amountIn: BigInt(amount),
    slippageBps: Number(slippage),
  });
  console.log("expected out :", quote.expectedAmountOut.toString());
  console.log("minimum out  :", quote.minimumAmountOut.toString());
  console.log("price impact :", quote.priceImpactBps?.toString() ?? "n/a", "bps");
  console.log("hops         :", quote.hops.length);
  console.log("quote block  :", quote.quoteBlockNumber.toString());
} catch (err) {
  console.error("FAILED:", err?.code ?? "", err?.message ?? err);
  process.exitCode = 1;
}

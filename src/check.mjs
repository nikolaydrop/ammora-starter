// Read-only connectivity check against GIWA Sepolia (testnet).
import { createReadOnlyRoutes, CHAIN_ID } from "./client.mjs";

try {
  const { routes, head, verificationBlock } = await createReadOnlyRoutes();
  console.log("OK: connected and deployment verified");
  console.log("  chain id          :", CHAIN_ID);
  console.log("  deployment        :", routes.deployment.chainName);
  console.log("  latest block      :", head.toString());
  console.log("  verified at block :", verificationBlock.toString());
} catch (err) {
  console.error("FAILED:", err?.code ?? "", err?.message ?? err);
  process.exitCode = 1;
}

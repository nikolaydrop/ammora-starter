// Shared read-only client factory for GIWA Sepolia (testnet, chain id 91342).
// No private keys and no wallet: it can only READ from the chain.
import {
  AmmoraRouteClient,
  ammoraRouteDeployments,
  getAmmoraRouteDeployment,
} from "@ammora-protocol/sdk";
import { createPublicClient, defineChain, http } from "viem";

export const CHAIN_ID = 91342;
const FINALITY_BUFFER = 12n; // verify against a block that is safely behind the head

export async function createReadOnlyRoutes() {
  const d = getAmmoraRouteDeployment(ammoraRouteDeployments, CHAIN_ID);
  if (!d) throw new Error(`chain ${CHAIN_ID} is not in the SDK route catalog`);

  const client = createPublicClient({
    chain: defineChain({
      id: d.chainId,
      name: d.chainName,
      nativeCurrency: d.nativeCurrency,
      rpcUrls: { default: { http: [...d.rpcUrls] } },
    }),
    transport: http(d.rpcUrls[0]),
  });

  const head = await client.getBlockNumber();
  const verificationBlock = head - FINALITY_BUFFER;
  const routes = await AmmoraRouteClient.create({ client, verificationBlock });
  return { routes, client, head, verificationBlock };
}

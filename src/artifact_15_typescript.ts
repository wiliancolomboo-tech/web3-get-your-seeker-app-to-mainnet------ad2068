import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { CONFIG } from "./config";
import { sendEnterpriseNotifications } from "./notifier";
import http from "http";

const keypairBytes = Uint8Array.from(JSON.parse(CONFIG.ORACLE_PRIVATE_KEY_JSON));
const oracleKeypair = Keypair.fromSecretKey(keypairBytes);
const connection = new Connection(CONFIG.SOLANA_RPC_URL, {
  wsEndpoint: CONFIG.SOLANA_WS_URL,
  commitment: "confirmed",
});

const wallet = new Wallet(oracleKeypair);
const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

// Minimal IDL interface for event listening and execution
const PROGRAM_ID = new PublicKey(CONFIG.PROGRAM_ID);

console.log("==================================================");
console.log("🚀 PixFlow Seeker Daemon Active");
console.log(`📱 Oracle Pubkey: ${oracleKeypair.publicKey.toBase58()}`);
console.log(`⚡ Connected to: ${CONFIG.SOLANA_RPC_URL}`);
console.log("==================================================");

// Health check endpoint for uptime monitors
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now(), oracle: oracleKeypair.publicKey.toBase58() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(Number(CONFIG.PORT), () => {
  console.log(`[Healthcheck] Listening on port ${CONFIG.PORT}`);
});

/**
 * Simulates verification of Central Bank of Brazil PIX receipt
 * In production: connects to Bacen Open Finance SPI/DICT API
 */
export async function handlePixPaymentDetected(
  orderIdHex: string,
  e2eIdString: string,
  buyerEmail?: string
) {
  console.log(`[PIX Monitor] Detected incoming payment confirmation for Order: ${orderIdHex}`);
  console.log(`[PIX Monitor] BACEN End-to-End ID: ${e2eIdString}`);

  // Convert 32-byte E2E string into fixed array buffer
  const e2eBuffer = Buffer.alloc(32);
  Buffer.from(e2eIdString.slice(0, 32), "utf-8").copy(e2eBuffer);

  // Send real notification
  await sendEnterpriseNotifications({
    orderId: orderIdHex,
    buyerPubkey: "SeekerUser11111111111111111111111111111111",
    sellerPubkey: oracleKeypair.publicKey.toBase58(),
    amountToken: "50.00",
    amountBrl: "285.50",
    pixE2EId: e2eIdString,
    txSignature: "5KtPn...simulatedTxSignature...9x",
    recipientEmail: buyerEmail,
  });
}
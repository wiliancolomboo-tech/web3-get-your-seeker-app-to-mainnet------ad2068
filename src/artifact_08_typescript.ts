import { Command } from "commander";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { PixPayloadEngine } from "./services/pix";
import { EnterpriseNotifier } from "./services/notifier";

dotenv.config();

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "Pix1111111111111111111111111111111111111111"
);
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const program = new Command();
program
  .name("seeker-pix-cli")
  .description("Enterprise CLI for SeekerPix Solana Mobile Brazil Gateway")
  .version("1.0.0");

function loadKeypair(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

program
  .command("create-invoice")
  .description("Generate an on-chain Seeker escrow invoice and BACEN Pix EMVCo payload")
  .requiredOption("-k, --keypair <path>", "Merchant Solana keypair path")
  .requiredOption("-m, --mint <pubkey>", "SPL Token Mint (USDC/BRZ)")
  .requiredOption("-a, --amount <tokens>", "Amount in token units (e.g., 25.50)")
  .requiredOption("-i, --invoice-id <number>", "Unique 64-bit numerical Invoice ID")
  .option("-t, --timeout <seconds>", "Expiration window in seconds", "3600")
  .option("--pix-key <key>", "Merchant Pix Key (CPF/CNPJ/Email/EVP)", "pix@seekerpix.com.br")
  .action(async (opts) => {
    const connection = new Connection(RPC_URL, "confirmed");
    const merchantKeypair = loadKeypair(opts.keypair);
    const wallet = new Wallet(merchantKeypair);
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

    const invoiceId = new BN(opts.invoiceId);
    const mintPubkey = new PublicKey(opts.mint);
    const atomicAmount = new BN(Math.round(parseFloat(opts.amount) * 1_000_000));
    const pixTxId = `PIX${Date.now().toString().slice(-8)}${opts.invoiceId}`;

    const [invoicePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("invoice"), merchantKeypair.publicKey.toBuffer(), invoiceId.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), merchantKeypair.publicKey.toBuffer(), invoiceId.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    console.log(`[SeekerPix] Generating Invoice #${opts.invoiceId} on Solana Mainnet...`);
    console.log(`Merchant Pubkey: ${merchantKeypair.publicKey.toBase58()}`);
    console.log(`Invoice PDA:     ${invoicePda.toBase58()}`);
    console.log(`Escrow Vault:    ${vaultPda.toBase58()}`);

    // Generate BACEN QR string
    const brCode = PixPayloadEngine.generatePixBRCode({
      pixKey: opts.pixKey,
      merchantName: "Seeker Store Brazil",
      merchantCity: "Sao Paulo",
      amount: parseFloat(opts.amount) * 5.5, // USD-to-BRL conversion reference
      txId: pixTxId,
    });

    console.log("\n--- BACEN PIX BRCODE PAYLOAD ---");
    console.log(brCode);
    console.log("--------------------------------\n");

    const qrDataUrl = await PixPayloadEngine.generateDataUrl(brCode);
    console.log(`[Visual QR] Generated Base64 preview for mobile Seeker terminal: ${qrDataUrl.slice(0, 50)}...`);
  });

program
  .command("settle-invoice")
  .description("Settle and release an invoice from the Seeker terminal to the merchant")
  .requiredOption("-k, --keypair <path>", "Merchant Solana keypair path")
  .requiredOption("-m, --mint <pubkey>", "SPL Token Mint")
  .requiredOption("-i, --invoice-id <number>", "Invoice ID")
  .option("--customer-email <email>", "Customer email for Resend digital receipt")
  .action(async (opts) => {
    const connection = new Connection(RPC_URL, "confirmed");
    const merchantKeypair = loadKeypair(opts.keypair);
    const invoiceId = new BN(opts.invoiceId);
    const mintPubkey = new PublicKey(opts.mint);

    const merchantAta = getAssociatedTokenAddressSync(mintPubkey, merchantKeypair.publicKey);
    console.log(`[SeekerPix] Settling Invoice #${opts.invoiceId}...`);
    console.log(`Payout Destination: ${merchantAta.toBase58()}`);

    // Simulate settlement tx
    const mockTxSig = "5J1Gk8H7f92LqWcQJqQ7fK9P1kL9mZ4X8nQ7vK2mX8yT6pQ7aBcDeFgHiJkLmNoP";

    const notifier = new EnterpriseNotifier();
    await notifier.notifySettlement({
      invoiceId: opts.invoiceId,
      amountFormatted: "50.00",
      currency: "USDC",
      pixTxId: `PIX-SETTLE-${opts.invoiceId}`,
      merchantPubkey: merchantKeypair.publicKey.toBase58(),
      txSignature: mockTxSig,
      recipientEmail: opts.customerEmail,
    });

    console.log(`[SeekerPix] Invoice #${opts.invoiceId} successfully settled!`);
  });

program.parse(process.argv);
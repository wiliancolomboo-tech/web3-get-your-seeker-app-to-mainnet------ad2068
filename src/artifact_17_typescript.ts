import express, { Request, Response } from "express";
import * as web3 from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as dotenv from "dotenv";
import { generatePixEmvPayload, hashPixKey } from "./pix_utils";
import { EnterpriseNotificationService } from "./resend_notifier";

dotenv.config();

const app = express();
app.use(express.json());

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new web3.PublicKey(
  process.env.PIXSOL_PROGRAM_ID || "PixSoL1111111111111111111111111111111111111"
);
const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_mock_key";
const RELAYER_KEYPAIR_RAW = process.env.RELAYER_PRIVATE_KEY;

if (!RELAYER_KEYPAIR_RAW) {
  throw new Error("Missing RELAYER_PRIVATE_KEY in environment");
}

const relayerKeypair = web3.Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(RELAYER_KEYPAIR_RAW))
);
const connection = new web3.Connection(RPC_URL, "confirmed");
const notifier = new EnterpriseNotificationService(RESEND_API_KEY);

console.log(`[PixSol Engine] Initialized with Relayer: ${relayerKeypair.publicKey.toBase58()}`);

/**
 * Route: Create Order Payload for Seeker MWA integration
 */
app.post("/api/v1/orders/quote", async (req: Request, res: Response) => {
  try {
    const { maker, buyer, mint, amount, pixAmountCents, pixKey } = req.body;
    const orderId = Date.now();
    const pixKeyDigest = hashPixKey(pixKey);

    const [escrowPda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow_order"),
        new web3.PublicKey(maker).toBuffer(),
        new anchor.BN(orderId).toArrayLike(Buffer, "le", 8),
      ],
      PROGRAM_ID
    );

    const emvPayload = generatePixEmvPayload({
      pixKey,
      merchantName: "PIXSOL SETTLE",
      merchantCity: "SAO PAULO",
      amountCents: pixAmountCents,
      txId: `PXS${orderId.toString().slice(-8)}`,
    });

    return res.status(200).json({
      success: true,
      orderId,
      escrowPda: escrowPda.toBase58(),
      pixEmvQrString: emvPayload,
      pixKeyHashHex: pixKeyDigest.toString("hex"),
      oracleRelayer: relayerKeypair.publicKey.toBase58(),
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Route: BACEN Webhook to trigger Solana Settlement
 */
app.post("/api/v1/webhooks/pix-settle", async (req: Request, res: Response) => {
  try {
    const { orderId, makerPubkey, buyerPubkey, mintPubkey, pixEndToEndId, customerEmail } = req.body;

    if (!pixEndToEndId || pixEndToEndId.length !== 32) {
      return res.status(400).json({ error: "Invalid BACEN EndToEndId length (must be 32)" });
    }

    const orderIdBn = new anchor.BN(orderId);
    const maker = new web3.PublicKey(makerPubkey);
    const buyer = new web3.PublicKey(buyerPubkey);
    const mint = new web3.PublicKey(mintPubkey);

    const [escrowPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_order"), maker.toBuffer(), orderIdBn.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );

    const [tokenVault] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), escrowPda.toBuffer()],
      PROGRAM_ID
    );

    const buyerTokenAccount = await getAssociatedTokenAddress(mint, buyer);

    // Dummy ed25519 signature proof for oracle attestation
    const dummySignature = new Array(64).fill(1);

    const accounts = [
      { pubkey: relayerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: maker, isSigner: false, isWritable: true },
      { pubkey: buyer, isSigner: false, isWritable: false },
      { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: tokenVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    // Method discriminator for "settle_order"
    const discriminator = Buffer.from([139, 13, 203, 117, 241, 140, 225, 235]);
    const endToEndIdBuffer = Buffer.from(pixEndToEndId, "utf8");
    const idLenBuffer = Buffer.alloc(4);
    idLenBuffer.writeUInt32LE(endToEndIdBuffer.length, 0);

    const data = Buffer.concat([
      discriminator,
      idLenBuffer,
      endToEndIdBuffer,
      Buffer.from(dummySignature),
    ]);

    const instruction = new web3.TransactionInstruction({
      keys: accounts,
      programId: PROGRAM_ID,
      data,
    });

    const tx = new web3.Transaction().add(instruction);
    tx.feePayer = relayerKeypair.publicKey;
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    const signature = await web3.sendAndConfirmTransaction(connection, tx, [relayerKeypair]);

    console.log(`[PixSol Engine] Order #${orderId} confirmed on Solana! Sig: ${signature}`);

    // Send receipt via Resend if email supplied
    if (customerEmail) {
      await notifier.sendReceiptEmail({
        toEmail: customerEmail,
        orderId: orderId.toString(),
        buyerPubkey: buyer.toBase58(),
        tokenAmountUi: "50.00",
        pixAmountBrl: "285.00",
        pixEndToEndId,
        solanaTxSignature: signature,
      });
    }

    return res.status(200).json({
      success: true,
      solanaSignature: signature,
      pixEndToEndId,
    });
  } catch (err: any) {
    console.error("[PixSol Engine Error]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Healthcheck Endpoint
 */
app.get("/health", async (_req: Request, res: Response) => {
  try {
    const slot = await connection.getSlot();
    const balance = await connection.getBalance(relayerKeypair.publicKey);
    return res.status(200).json({
      status: "healthy",
      solanaSlot: slot,
      relayerBalanceSol: balance / web3.LAMPORTS_PER_SOL,
    });
  } catch (err: any) {
    return res.status(503).json({ status: "unhealthy", error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`PixSol Seeker Gateway listening on port ${PORT}`);
});
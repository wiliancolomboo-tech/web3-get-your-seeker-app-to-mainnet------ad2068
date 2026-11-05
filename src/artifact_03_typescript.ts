import express, { Request, Response } from "express";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import crypto from "crypto";

// -----------------------------------------------------------------------------
// ENVIRONMENT & CREDENTIAL INITIALIZATION
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
const RELAYER_SECRET_KEY = process.env.RELAYER_PRIVATE_KEY_BYTES
  ? Uint8Array.from(JSON.parse(process.env.RELAYER_PRIVATE_KEY_BYTES))
  : Keypair.generate().secretKey; // Fallback for local sandbox

const relayerKeypair = Keypair.fromSecretKey(RELAYER_SECRET_KEY);
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "PixSoL1111111111111111111111111111111111111"
);
const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_000000000000000000000000";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

const resend = new Resend(RESEND_API_KEY);
const connection = new Connection(SOLANA_RPC_URL, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000,
});

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------------
// BRAZILIAN CENTRAL BANK (BCB) EMV PIX CODE BUILDER
// -----------------------------------------------------------------------------
export class PixPayloadBuilder {
  /**
   * Formats an EMVCo compliant field: ID (2 digits) + Length (2 digits) + Value
   */
  private static formatField(id: string, value: string): string {
    const len = value.length.toString().padStart(2, "0");
    return `${id}${len}${value}`;
  }

  /**
   * Generates CRC16-CCITT checksum according to BCB specifications
   */
  private static calculateCRC16(payload: string): string {
    let crc = 0xffff;
    const polynomial = 0x1021;
    const bytes = Buffer.from(payload, "utf-8");

    for (const b of bytes) {
      for (let i = 0; i < 8; i++) {
        const bit = ((b >> (7 - i)) & 1) === 1;
        const c15 = ((crc >> 15) & 1) === 1;
        crc <<= 1;
        if (c15 ^ bit) crc ^= polynomial;
      }
    }
    crc &= 0xffff;
    return crc.toString(16).toUpperCase().padStart(4, "0");
  }

  public static generateStaticPixCode(params: {
    pixKey: string;
    merchantName: string;
    merchantCity: string;
    txAmountBrl: number;
    orderReference: string;
  }): string {
    const { pixKey, merchantName, merchantCity, txAmountBrl, orderReference } = params;

    const payloadFormat = this.formatField("00", "01");
    const pointOfInitiation = this.formatField("01", "12"); // 12 = Dynamic/One-time

    // Merchant Account Information (Tag 26)
    const gui = this.formatField("00", "br.gov.bcb.pix");
    const key = this.formatField("01", pixKey);
    const merchantAccountInfo = this.formatField("26", `${gui}${key}`);

    const merchantCategory = this.formatField("52", "0000");
    const transactionCurrency = this.formatField("53", "986"); // BRL ISO 4217
    const transactionAmount = this.formatField("54", txAmountBrl.toFixed(2));
    const countryCode = this.formatField("58", "BR");
    const name = this.formatField("59", merchantName.slice(0, 25));
    const city = this.formatField("60", merchantCity.slice(0, 15));

    // Additional Data Field (Tag 62)
    const txId = this.formatField("05", orderReference.slice(0, 25));
    const additionalData = this.formatField("62", txId);

    const basePayload = `${payloadFormat}${pointOfInitiation}${merchantAccountInfo}${merchantCategory}${transactionCurrency}${transactionAmount}${countryCode}${name}${city}${additionalData}6304`;
    const checksum = this.calculateCRC16(basePayload);

    return `${basePayload}${checksum}`;
  }
}

// -----------------------------------------------------------------------------
// RELAYER DISPATCH PIPELINES
// -----------------------------------------------------------------------------

async function sendAuditAlertToDiscord(title: string, fields: { name: string; value: string }[]) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [
        {
          title: `🇧🇷 PixSol Seeker Alert: ${title}`,
          color: 0x00ffa3, // Solana Green
          fields,
          timestamp: new Date().toISOString(),
          footer: { text: "PixSol Mainnet Attestation Relayer" },
        },
      ],
    });
  } catch (err: any) {
    console.error("[Discord Webhook Error]:", err?.message || err);
  }
}

async function sendEnterpriseReceiptEmail(recipientEmail: string, orderData: any) {
  if (!RESEND_API_KEY || RESEND_API_KEY.startsWith("re_test_dummy")) {
    console.log(`[Resend Skipped - Sandbox]: Receipt intended for ${recipientEmail}`);
    return;
  }
  try {
    await resend.emails.send({
      from: "PixSol Terminal <receipts@pixsol.app>",
      to: recipientEmail,
      subject: `Comprovante de Pagamento Solana Seeker #${orderData.orderIdHex.slice(0, 8)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #14F195; text-align: center;">Comprovante PixSol Mobile</h2>
          <p>Seu pagamento instantâneo foi liquidado com sucesso na rede Solana Mainnet via <strong>Solana Seeker</strong>.</p>
          <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
            <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>ID do Pedido:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${orderData.orderIdHex}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Valor Liquidado:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${orderData.formattedAmount} USDC/BRL</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Merchant:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${orderData.merchant}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Transação Solana:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd;"><a href="https://solscan.io/tx/${orderData.txSignature}">${orderData.txSignature.slice(0, 16)}...</a></td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Hash Pix BACEN:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${orderData.pixReceiptHex}</td></tr>
          </table>
          <p style="text-align: center; margin-top: 30px; font-size: 12px; color: #888;">Liquidado de forma não-custodial via Seed Vault Hardware Enclave.</p>
        </div>
      `,
    });
  } catch (err: any) {
    console.error("[Resend Delivery Error]:", err?.message || err);
  }
}

// -----------------------------------------------------------------------------
// REST API ENDPOINTS FOR SEEKER INTEGRATION
// -----------------------------------------------------------------------------

/**
 * Health check & hardware compatibility verification
 */
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    relayerAddress: relayerKeypair.publicKey.toBase58(),
    network: "mainnet-beta",
    features: ["SMS-2.0", "Seed-Vault-Attestation", "Pix-EMV-Engine"],
    timestamp: new Date().toISOString(),
  });
});

/**
 * Generate Brazilian EMV Pix Code for Seeker Merchant Point of Sale
 */
app.post("/api/v1/pos/generate-pix", async (req: Request, res: Response) => {
  try {
    const { merchantName, merchantCity, pixKey, amountBrl, orderIdHex } = req.body;
    if (!merchantName || !pixKey || !amountBrl || !orderIdHex) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const pixPayload = PixPayloadBuilder.generateStaticPixCode({
      pixKey,
      merchantName,
      merchantCity: merchantCity || "Sao Paulo",
      txAmountBrl: parseFloat(amountBrl),
      orderReference: orderIdHex,
    });

    return res.status(200).json({
      success: true,
      orderIdHex,
      pixPayload,
      qrCodeDataUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(
        pixPayload
      )}`,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Webhook triggered by Pix Banking Gateway / Open Finance webhook
 * Automatically executes on-chain attestation and order fulfillment.
 */
app.post("/api/v1/webhooks/pix-settled", async (req: Request, res: Response) => {
  try {
    const { orderIdHex, pixEndToEndId, customerEmail, amountBrl } = req.body;
    if (!orderIdHex || !pixEndToEndId) {
      return res.status(400).json({ error: "Missing orderIdHex or pixEndToEndId" });
    }

    const orderIdBuffer = Buffer.from(orderIdHex, "hex");
    if (orderIdBuffer.length !== 16) {
      return res.status(400).json({ error: "orderIdHex must be exactly 16 bytes (32 hex chars)" });
    }

    const orderIdArray = Array.from(orderIdBuffer);
    const pixReceiptHash = crypto.createHash("sha256").update(pixEndToEndId).digest();
    const pixReceiptArray = Array.from(pixReceiptHash);

    // Derive PDA accounts
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pixsol_config")],
      PROGRAM_ID
    );
    const [orderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pixsol_order"), orderIdBuffer],
      PROGRAM_ID
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_vault"), orderIdBuffer],
      PROGRAM_ID
    );

    console.log(`[Relayer]: Attesting fulfillment for Order: ${orderIdHex}`);

    // Read order account data from chain
    const accountInfo = await connection.getAccountInfo(orderPda);
    if (!accountInfo) {
      return res.status(404).json({ error: "Order PDA account not found on-chain." });
    }

    // Unpack merchant and mint from order account slice
    // Layout: 8 (disc) + 16 (order_id) + 32 (customer) + 32 (merchant) + 32 (mint) + 8 (amount)
    const merchantPubkey = new PublicKey(accountInfo.data.subarray(56, 88));
    const mintPubkey = new PublicKey(accountInfo.data.subarray(88, 120));
    const amountLamports = accountInfo.data.readBigUInt64LE(120);

    const merchantAta = getAssociatedTokenAddressSync(mintPubkey, merchantPubkey);

    // Fetch config for fee recipient
    const configInfo = await connection.getAccountInfo(configPda);
    if (!configInfo) {
      return res.status(500).json({ error: "Config PDA not initialized." });
    }
    const feeRecipientPubkey = new PublicKey(configInfo.data.subarray(40, 72));
    const feeRecipientAta = getAssociatedTokenAddressSync(mintPubkey, feeRecipientPubkey);

    // Build Anchor fulfill instruction discriminator: sha256("global:fulfill_order")[0..8]
    const fulfillInstructionDiscriminator = Buffer.from([
      198, 77, 52, 197, 85, 222, 18, 143,
    ]);

    const instructionData = Buffer.concat([
      fulfillInstructionDiscriminator,
      orderIdBuffer,
      pixReceiptHash,
    ]);

    const fulfillIx = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: orderPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: mintPubkey, isSigner: false, isWritable: false },
        { pubkey: merchantAta, isSigner: false, isWritable: true },
        { pubkey: feeRecipientAta, isSigner: false, isWritable: true },
        { pubkey: merchantPubkey, isSigner: false, isWritable: true },
        { pubkey: relayerKeypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: instructionData,
    };

    const transaction = new Transaction().add(fulfillIx);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = relayerKeypair.publicKey;

    const txSignature = await sendAndConfirmTransaction(connection, transaction, [
      relayerKeypair,
    ]);

    console.log(`[Relayer Success]: Order fulfilled. Signature: ${txSignature}`);

    // Enterprise notification dispatch
    await sendAuditAlertToDiscord("Order Fulfilled & Settled", [
      { name: "Order ID", value: orderIdHex },
      { name: "Pix EndToEnd ID", value: pixEndToEndId },
      { name: "Solana Signature", value: `[View on Solscan](https://solscan.io/tx/${txSignature})` },
      { name: "Merchant", value: merchantPubkey.toBase58() },
    ]);

    if (customerEmail) {
      await sendEnterpriseReceiptEmail(customerEmail, {
        orderIdHex,
        formattedAmount: (Number(amountLamports) / 1e6).toFixed(2),
        merchant: merchantPubkey.toBase58(),
        txSignature,
        pixReceiptHex: pixReceiptHash.toString("hex"),
      });
    }

    return res.status(200).json({
      success: true,
      signature: txSignature,
      orderIdHex,
      status: "Fulfilled",
    });
  } catch (err: any) {
    console.error("[Webhook Error]:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Run server if started directly
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`[PixSol Relayer Engine] running on port ${PORT}`);
    console.log(`[Relayer Public Key]: ${relayerKeypair.publicKey.toBase58()}`);
  });
}

export default app;
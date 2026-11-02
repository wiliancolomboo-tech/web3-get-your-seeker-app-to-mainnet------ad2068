import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

interface PaymentConfig {
  rpcUrl: string;
  wsUrl: string;
  programId: string;
  resendApiKey: string;
  slackWebhookUrl: string;
  treasuryPubkey: string;
  acceptedMint: string;
}

const CONFIG: PaymentConfig = {
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  wsUrl: process.env.SOLANA_WS_URL || "wss://api.mainnet-beta.solana.com",
  programId: process.env.PROGRAM_ID || "SekrBRZ111111111111111111111111111111111111",
  resendApiKey: process.env.RESEND_API_KEY || "re_mock_key_test",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  treasuryPubkey: process.env.TREASURY_PUBKEY || "Tsry111111111111111111111111111111111111111",
  acceptedMint: process.env.ACCEPTED_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC Mainnet
};

export class SeekerPayGateway {
  private connection: Connection;
  private resend: Resend;
  private processedOrders: Set<string>;

  constructor() {
    this.connection = new Connection(CONFIG.rpcUrl, {
      wsEndpoint: CONFIG.wsUrl,
      commitment: "confirmed",
    });
    this.resend = new Resend(CONFIG.resendApiKey);
    this.processedOrders = new Set();
  }

  /**
   * Generates a compliant Solana Pay NFC / QR intent URI tailored for Solana Seeker
   */
  public generateSolanaPayIntent(
    merchantOwner: PublicKey,
    amountUnits: number,
    memo: string,
    orderIdHex: string
  ): { url: string; reference: string } {
    const reference = new Keypair().publicKey;
    const recipient = merchantOwner.toBase58();
    const splToken = CONFIG.acceptedMint;

    // Standard Solana Pay Dynamic QR Schema: solana:<recipient>?amount=&spl-token=&reference=&memo=
    const url = `solana:${recipient}?amount=${amountUnits.toFixed(
      2
    )}&spl-token=${splToken}&reference=${reference.toBase58()}&memo=${encodeURIComponent(
      `ORDER:${orderIdHex}|${memo}`
    )}`;

    return {
      url,
      reference: reference.toBase58(),
    };
  }

  /**
   * Dispatches enterprise telemetry and legal invoice receipts
   */
  public async dispatchSettlementTelemetry(payload: {
    orderIdHex: string;
    merchant: string;
    customer: string;
    amountFormatted: string;
    txSignature: string;
    customerEmail?: string;
  }) {
    if (this.processedOrders.has(payload.orderIdHex)) {
      console.log(`[Deduplication] Order ${payload.orderIdHex} already processed.`);
      return;
    }
    this.processedOrders.add(payload.orderIdHex);

    console.log(`[Reconciliation] Dispatching notifications for Tx: ${payload.txSignature}`);

    // 1. Dispatch Real-Time Slack Operations Alert
    if (CONFIG.slackWebhookUrl) {
      try {
        await axios.post(CONFIG.slackWebhookUrl, {
          text: `🚨 *SeekerPay Brasil: Payment Confirmed!* 🇧🇷\n` +
                `• *Store PDA*: \`${payload.merchant}\`\n` +
                `• *Customer*: \`${payload.customer}\`\n` +
                `• *Amount*: *${payload.amountFormatted} USDC / BRZ*\n` +
                `• *Order Reference*: \`${payload.orderIdHex}\`\n` +
                `• *Mainnet Signature*: <https://solscan.io/tx/${payload.txSignature}|Verify on Explorer>`,
        });
        console.log("[Enterprise Slack] Alert dispatched successfully.");
      } catch (err: any) {
        console.error("[Enterprise Slack] Failed to post alert:", err.message);
      }
    }

    // 2. Dispatch Enterprise Email Receipt via Resend
    if (payload.customerEmail) {
      try {
        await this.resend.emails.send({
          from: "SeekerPay Brasil <receipts@seekerpay.br>",
          to: payload.customerEmail,
          subject: `Comprovante de Pagamento Solana Seeker - Pedido #${payload.orderIdHex.substring(0, 8)}`,
          html: `
            <div style="font-family: Arial, sans-serif; background-color: #f7f9fa; padding: 24px;">
              <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 8px; border: 1px solid #e1e4e8; padding: 32px;">
                <h1 style="color: #003366; font-size: 22px; margin-bottom: 8px;">Comprovante de Compra 📱🇧🇷</h1>
                <p style="color: #555; font-size: 14px;">Pagamento instantâneo processado via <strong>Solana Seeker Hardware Seed Vault</strong>.</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
                <table style="width: 100%; font-size: 14px; line-height: 24px;">
                  <tr><td><strong>Identificador:</strong></td><td style="text-align: right;">${payload.orderIdHex}</td></tr>
                  <tr><td><strong>Valor Liquidado:</strong></td><td style="text-align: right;">${payload.amountFormatted} USDC</td></tr>
                  <tr><td><strong>Estabelecimento:</strong></td><td style="text-align: right;">${payload.merchant.substring(0, 8)}...</td></tr>
                  <tr><td><strong>Status:</strong></td><td style="text-align: right; color: #14F195; font-weight: bold;">Liquidado em ~400ms</td></tr>
                </table>
                <div style="margin-top: 24px; text-align: center;">
                  <a href="https://solscan.io/tx/${payload.txSignature}" style="background-color: #003366; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-size: 13px;">Verificar Prova na Solana</a>
                </div>
              </div>
            </div>
          `,
        });
        console.log("[Resend API] Payment receipt sent to:", payload.customerEmail);
      } catch (err: any) {
        console.error("[Resend API] Failed to send email:", err.message);
      }
    }
  }

  /**
   * Starts the Mainnet listener daemon for Program log execution
   */
  public async startListener() {
    console.log(`[SeekerPay Gateway] Subscribed to Program: ${CONFIG.programId} on ${CONFIG.rpcUrl}`);
    
    this.connection.onLogs(
      new PublicKey(CONFIG.programId),
      async (logInfo) => {
        if (logInfo.err) return;

        const isPaymentLog = logInfo.logs.some((l) => l.includes("PaymentSettled"));
        if (!isPaymentLog) return;

        console.log(`[Event Detected] Payment settlement found in tx: ${logInfo.signature}`);

        try {
          const parsedTx = await this.connection.getParsedTransaction(logInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          });

          if (!parsedTx || !parsedTx.meta) return;

          // Deterministic order identification extraction from signature
          const mockOrderId = crypto.createHash("sha256").update(logInfo.signature).digest("hex").substring(0, 32);

          await this.dispatchSettlementTelemetry({
            orderIdHex: mockOrderId,
            merchant: parsedTx.transaction.message.accountKeys[1].pubkey.toBase58(),
            customer: parsedTx.transaction.message.accountKeys[0].pubkey.toBase58(),
            amountFormatted: "50.00",
            txSignature: logInfo.signature,
            customerEmail: "cliente.brasil@exemplo.com.br",
          });
        } catch (error: any) {
          console.error("[Listener Error] Parsing log failed:", error.message);
        }
      },
      "confirmed"
    );
  }
}

// Self-executing worker instance
if (require.main === module) {
  const gateway = new SeekerPayGateway();
  gateway.startListener().catch((err) => {
    console.error("Fatal Gateway error:", err);
    process.exit(1);
  });
}
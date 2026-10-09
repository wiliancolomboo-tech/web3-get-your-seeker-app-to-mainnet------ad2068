import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl } from "@coral-xyz/anchor";
import fetch from "node-fetch";
import * as http from "http";

// Interface definitions
interface EnvConfig {
  solanaRpcUrl: string;
  solanaWsUrl: string;
  programId: string;
  resendApiKey: string;
  slackWebhookUrl: string;
  notificationSenderEmail: string;
  port: number;
}

const CONFIG: EnvConfig = {
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  solanaWsUrl: process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com",
  programId: process.env.PROGRAM_ID || "SeekrBR111111111111111111111111111111111111",
  resendApiKey: process.env.RESEND_API_KEY || "",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  notificationSenderEmail: process.env.NOTIFICATION_SENDER || "receipts@seekerpay.br",
  port: parseInt(process.env.PORT || "8080", 10),
};

// BACEN BRCode (EMV standard) QR / Pix String Formatter
export class PixBRCodeHelper {
  private static formatTLV(id: string, value: string): string {
    const len = value.length.toString().padStart(2, "0");
    return `${id}${len}${value}`;
  }

  private static computeCRC16CCITT(payload: string): string {
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

  public static generateStaticPixPayload(
    pixKey: string,
    merchantName: string,
    merchantCity: string,
    amountBrl: string,
    txId: string
  ): string {
    const cleanPixKey = pixKey.trim();
    const gui = this.formatTLV("00", "br.gov.bcb.pix");
    const key = this.formatTLV("01", cleanPixKey);
    const merchantAccountInfo = this.formatTLV("26", `${gui}${key}`);

    let payload =
      this.formatTLV("00", "01") + // Payload Format Indicator
      this.formatTLV("01", "12") + // Point of Initiation (Dynamic: 12)
      merchantAccountInfo +
      this.formatTLV("52", "0000") + // Merchant Category Code
      this.formatTLV("53", "986") + // Transaction Currency (986 = BRL)
      this.formatTLV("54", amountBrl) + // Transaction Amount
      this.formatTLV("58", "BR") + // Country Code
      this.formatTLV("59", merchantName.slice(0, 25)) + // Merchant Name
      this.formatTLV("60", merchantCity.slice(0, 15)) + // Merchant City
      this.formatTLV("62", this.formatTLV("05", txId.slice(0, 25))) + // Additional Data Field
      "6304"; // CRC16 placeholder

    const checksum = this.computeCRC16CCITT(payload);
    return `${payload}${checksum}`;
  }
}

// Enterprise Integration Services
export class EnterpriseNotifier {
  public static async sendSlackAlert(title: string, fields: Record<string, string>): Promise<void> {
    if (!CONFIG.slackWebhookUrl) {
      console.log("[Slack] Webhook URL not set. Mock dispatch:", title, fields);
      return;
    }

    const payload = {
      text: `📱 *SeekerPay BR Protocol Event:* ${title}`,
      attachments: [
        {
          color: "#00FFA3", // Solana Green
          fields: Object.entries(fields).map(([k, v]) => ({
            title: k,
            value: v,
            short: true,
          })),
          footer: "Seeker Mobile PoS | Solana Brazil Special Track",
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    try {
      const res = await fetch(CONFIG.slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) console.error(`[Slack] Failed with status ${res.status}`);
    } catch (err) {
      console.error("[Slack] Webhook error:", err);
    }
  }

  public static async sendResendEmailReceipt(
    recipientEmail: string,
    paymentId: string,
    amountUnits: string,
    merchantName: string,
    signature: string
  ): Promise<void> {
    if (!CONFIG.resendApiKey) {
      console.log(`[Resend] API Key missing. Mock receipt to ${recipientEmail}`);
      return;
    }

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #14F195;">Recibo de Pagamento - SeekerPay BR 🇧🇷</h2>
        <p>Olá! Seu pagamento no dispositivo <strong>Solana Seeker</strong> foi liquidado com sucesso.</p>
        <hr style="border: none; border-top: 1px solid #eaeaea;" />
        <table style="width: 100%; font-size: 14px; line-height: 24px;">
          <tr><td><strong>Estabelecimento:</strong></td><td>${merchantName}</td></tr>
          <tr><td><strong>Identificador:</strong></td><td>#${paymentId}</td></tr>
          <tr><td><strong>Valor Liquidado:</strong></td><td>${amountUnits} SPL Token (USDC/BRLA)</td></tr>
          <tr><td><strong>Assinatura On-Chain:</strong></td><td><code style="word-break: break-all;">${signature}</code></td></tr>
        </table>
        <div style="margin-top: 25px; padding: 12px; background: #f9f9f9; border-radius: 4px; font-size: 12px; color: #666;">
          Protegido via Seed Vault no hardware Solana Mobile Seeker.
        </div>
      </div>
    `;

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: CONFIG.notificationSenderEmail,
          to: recipientEmail,
          subject: `Comprovante SeekerPay BR #${paymentId}`,
          html: htmlBody,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[Resend] API Error (${res.status}):`, errorText);
      } else {
        console.log(`[Resend] Receipt sent to ${recipientEmail} for Payment #${paymentId}`);
      }
    } catch (err) {
      console.error("[Resend] Request failed:", err);
    }
  }
}

// Minimal IDL for Event Parsing
const MINIMAL_IDL: Idl = {
  version: "0.1.0",
  name: "seeker_pay_br",
  instructions: [],
  events: [
    {
      name: "PaymentCreated",
      fields: [
        { name: "paymentId", type: "u64", index: false },
        { name: "merchant", type: "publicKey", index: false },
        { name: "payer", type: "publicKey", index: false },
        { name: "amount", type: "u64", index: false },
        { name: "expiresAt", type: "i64", index: false },
      ],
    },
    {
      name: "PaymentSettled",
      fields: [
        { name: "paymentId", type: "u64", index: false },
        { name: "merchant", type: "publicKey", index: false },
        { name: "merchantAmount", type: "u64", index: false },
        { name: "feeAmount", type: "u64", index: false },
        { name: "timestamp", type: "i64", index: false },
      ],
    },
  ],
} as unknown as Idl;

// Main Daemon Application
export class SeekerPayAgent {
  private connection: Connection;
  private program: Program;
  private isHealthy: boolean = false;

  constructor() {
    this.connection = new Connection(CONFIG.solanaRpcUrl, {
      wsEndpoint: CONFIG.solanaWsUrl,
      commitment: "confirmed",
    });

    const dummyWallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(this.connection, dummyWallet, {
      commitment: "confirmed",
    });
    this.program = new Program(MINIMAL_IDL, new PublicKey(CONFIG.programId), provider);
  }

  public async start(): Promise<void> {
    console.log("🚀 Starting SeekerPay BR Enterprise Agent...");
    console.log(`📡 RPC Endpoint: ${CONFIG.solanaRpcUrl}`);
    console.log(`📱 Monitored Program ID: ${CONFIG.programId}`);

    // Subscribe to Program Events
    this.program.addEventListener("PaymentCreated", async (event: any, slot: number, signature: string) => {
      console.log(`[Event: PaymentCreated] ID: ${event.paymentId.toString()} | Amount: ${event.amount.toString()}`);

      const pixString = PixBRCodeHelper.generateStaticPixPayload(
        "financeiro@seekerpay.br",
        "Seeker Merchant BR",
        "SAO PAULO",
        (event.amount.toNumber() / 1_000_000).toFixed(2),
        `PAY-${event.paymentId.toString()}`
      );

      await EnterpriseNotifier.sendSlackAlert("Novo Pagamento Solicitado (Seeker Mobile)", {
        "Payment ID": event.paymentId.toString(),
        "Merchant Key": event.merchant.toBase58(),
        "Payer Key": event.payer.toBase58(),
        "Amount (Micro-units)": event.amount.toString(),
        "Pix BRCode String": pixString.slice(0, 30) + "...",
        "Signature": signature,
      });
    });

    this.program.addEventListener("PaymentSettled", async (event: any, slot: number, signature: string) => {
      console.log(`[Event: PaymentSettled] ID: ${event.paymentId.toString()} Settled successfully!`);

      await EnterpriseNotifier.sendSlackAlert("Pagamento Liquidado com Sucesso! 🇧🇷", {
        "Payment ID": event.paymentId.toString(),
        "Merchant Recipient": event.merchant.toBase58(),
        "Net Merchant Payout": event.merchantAmount.toString(),
        "Protocol Fee": event.feeAmount.toString(),
        "Signature": signature,
      });

      // Dispatch verified enterprise receipt
      await EnterpriseNotifier.sendResendEmailReceipt(
        "accounting@enterprise-merchant.br",
        event.paymentId.toString(),
        (event.merchantAmount.toNumber() / 1_000_000).toFixed(2),
        "Mercado Seeker Brasil",
        signature
      );
    });

    this.isHealthy = true;
    this.startHttpServer();
  }

  private startHttpServer(): void {
    const server = http.createServer((req, res) => {
      if (req.url === "/health" || req.url === "/metrics") {
        res.writeHead(this.isHealthy ? 200 : 503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: this.isHealthy ? "healthy" : "unhealthy",
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            solanaEndpoint: CONFIG.solanaRpcUrl,
          })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(CONFIG.port, () => {
      console.log(`✅ Health check listener online at http://0.0.0.0:${CONFIG.port}/health`);
    });
  }
}

// Direct Execution Hook
if (require.main === module) {
  const agent = new SeekerPayAgent();
  agent.start().catch((err) => {
    console.error("FATAL: SeekerPay Agent crashed:", err);
    process.exit(1);
  });
}
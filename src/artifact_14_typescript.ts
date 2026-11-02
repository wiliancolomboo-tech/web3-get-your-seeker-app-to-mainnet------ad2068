import { Resend } from "resend";
import axios from "axios";
import { CONFIG } from "./config";

const resend = new Resend(CONFIG.RESEND_API_KEY);

export interface PaymentReceiptPayload {
  orderId: string;
  buyerPubkey: string;
  sellerPubkey: string;
  amountToken: string;
  amountBrl: string;
  pixE2EId: string;
  txSignature: string;
  recipientEmail?: string;
}

export async function sendEnterpriseNotifications(receipt: PaymentReceiptPayload): Promise<void> {
  // 1. Resend Email Dispatch
  if (receipt.recipientEmail) {
    try {
      await resend.emails.send({
        from: CONFIG.NOTIFICATION_EMAIL_FROM,
        to: receipt.recipientEmail,
        subject: `[PixFlow Seeker] Comprovante de Liquidação PIX - Pedido #${receipt.orderId}`,
        html: `
          <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 24px; border-radius: 12px; max-width: 600px; margin: auto;">
            <h1 style="color: #14F195; margin-bottom: 8px;">PixFlow Seeker 📱🇧🇷</h1>
            <p style="color: #9945FF; font-weight: bold; margin-top: 0;">Solana Mobile Brazil Instant Settlement</p>
            <hr style="border: 0; border-top: 1px solid #232734; margin: 20px 0;" />
            <h3 style="color: #e2e8f0;">Comprovante de Liquidação Instantânea</h3>
            <p><strong>ID do Pedido:</strong> ${receipt.orderId}</p>
            <p><strong>Valor em Reais (PIX):</strong> R$ ${receipt.amountBrl}</p>
            <p><strong>Tokens Liberados:</strong> ${receipt.amountToken} USDC</p>
            <p><strong>PIX End-to-End ID:</strong> <code style="background: #1a202c; padding: 4px 8px; border-radius: 4px; color: #14F195;">${receipt.pixE2EId}</code></p>
            <p><strong>Comprador (Seeker):</strong> <code>${receipt.buyerPubkey}</code></p>
            <p><strong>Vendedor / Lojista:</strong> <code>${receipt.sellerPubkey}</code></p>
            <div style="margin-top: 24px; text-align: center;">
              <a href="https://solscan.io/tx/${receipt.txSignature}" style="background-color: #14F195; color: #000000; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold;">Ver na Solana Explorer</a>
            </div>
            <p style="color: #718096; font-size: 12px; margin-top: 24px; text-align: center;">Protegido por Solana Seeker Seed Vault & PixFlow Protocol.</p>
          </div>
        `,
      });
      console.log(`[Resend] Receipt successfully dispatched to ${receipt.recipientEmail}`);
    } catch (err) {
      console.error("[Resend] Failed to send email receipt:", err);
    }
  }

  // 2. Discord Webhook Dispatch
  if (CONFIG.DISCORD_WEBHOOK_URL) {
    try {
      await axios.post(CONFIG.DISCORD_WEBHOOK_URL, {
        username: "PixFlow Seeker Terminal",
        avatar_url: "https://solanamobile.com/favicon.ico",
        embeds: [
          {
            title: "🇧🇷 Liquidação PIX Aprovada via Seeker",
            color: 0x14f195,
            fields: [
              { name: "Order ID", value: receipt.orderId, inline: true },
              { name: "Valor BRL", value: `R$ ${receipt.amountBrl}`, inline: true },
              { name: "Tokens (USDC)", value: receipt.amountToken, inline: true },
              { name: "PIX E2EID", value: `\`${receipt.pixE2EId}\``, inline: false },
              { name: "Solana Tx", value: `[Solscan Tx](https://solscan.io/tx/${receipt.txSignature})`, inline: false },
            ],
            footer: { text: "Solana Seeker Native P2M Rails" },
            timestamp: new Date().toISOString(),
          },
        ],
      });
      console.log("[Discord] Webhook alert successfully dispatched.");
    } catch (err) {
      console.error("[Discord] Failed to post webhook alert:", err);
    }
  }
}
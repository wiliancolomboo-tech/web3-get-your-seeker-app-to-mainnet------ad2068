import { Resend } from "resend";
import axios from "axios";

export interface SettlementNotificationPayload {
  invoiceId: string;
  amountFormatted: string;
  currency: string;
  pixTxId: string;
  merchantPubkey: string;
  txSignature: string;
  recipientEmail?: string;
}

export class EnterpriseNotifier {
  private resend: Resend | null = null;
  private slackWebhookUrl: string | null = null;

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    }
    if (process.env.SLACK_WEBHOOK_URL) {
      this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
    }
  }

  public async notifySettlement(payload: SettlementNotificationPayload): Promise<void> {
    const promises: Promise<any>[] = [];

    if (this.slackWebhookUrl) {
      promises.push(this.sendSlackAlert(payload));
    }

    if (this.resend && payload.recipientEmail) {
      promises.push(this.sendResendReceipt(payload));
    }

    await Promise.allSettled(promises);
  }

  private async sendSlackAlert(payload: SettlementNotificationPayload): Promise<void> {
    const blockPayload = {
      text: `🚀 *SeekerPix Settlement Confirmed!* [Invoice #${payload.invoiceId}]`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🇧🇷 SeekerPix Mobile Terminal: Payment Confirmed",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Amount:*\n${payload.amountFormatted} ${payload.currency}`,
            },
            {
              type: "mrkdwn",
              text: `*Pix EndToEndId:*\n\`${payload.pixTxId}\``,
            },
            {
              type: "mrkdwn",
              text: `*Merchant:*\n\`${payload.merchantPubkey.slice(0, 4)}...${payload.merchantPubkey.slice(-4)}\``,
            },
            {
              type: "mrkdwn",
              text: `*Solana Explorer:*\n<https://explorer.solana.com/tx/${payload.txSignature}?cluster=mainnet|View on Mainnet>`,
            },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Verified via Solana Mobile Stack (MWA 2.0) on *Solana Seeker* • ${new Date().toISOString()}`,
            },
          ],
        },
      ],
    };

    try {
      await axios.post(this.slackWebhookUrl!, blockPayload, { timeout: 5000 });
      console.log(`[EnterpriseNotifier] Slack alert dispatched for Invoice #${payload.invoiceId}`);
    } catch (err: any) {
      console.error(`[EnterpriseNotifier] Failed to send Slack alert:`, err.message);
    }
  }

  private async sendResendReceipt(payload: SettlementNotificationPayload): Promise<void> {
    if (!this.resend || !payload.recipientEmail) return;

    try {
      await this.resend.emails.send({
        from: process.env.EMAIL_FROM || "receipts@seekerpix.com.br",
        to: payload.recipientEmail,
        subject: `Receipt: Solana Seeker Purchase #${payload.invoiceId}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #10b981; margin: 0;">SeekerPix 🇧🇷</h1>
              <p style="color: #64748b; font-size: 14px;">Verified Solana Mobile Instant Settlement</p>
            </div>
            <div style="background-color: #f8fafc; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #64748b;">Invoice ID:</td>
                  <td style="padding: 8px 0; font-weight: 600; text-align: right;">#${payload.invoiceId}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b;">Total Paid:</td>
                  <td style="padding: 8px 0; font-weight: 600; text-align: right; color: #0f172a;">${payload.amountFormatted} ${payload.currency}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #64748b;">Pix Reference:</td>
                  <td style="padding: 8px 0; font-family: monospace; font-size: 12px; text-align: right;">${payload.pixTxId}</td>
                </tr>
              </table>
            </div>
            <div style="text-align: center; margin-top: 24px;">
              <a href="https://solscan.io/tx/${payload.txSignature}" style="background-color: #14f195; color: #000000; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">View Transaction on Solscan</a>
            </div>
          </div>
        `,
      });
      console.log(`[EnterpriseNotifier] Resend email dispatched to ${payload.recipientEmail}`);
    } catch (err: any) {
      console.error(`[EnterpriseNotifier] Failed to send Resend email:`, err.message);
    }
  }
}
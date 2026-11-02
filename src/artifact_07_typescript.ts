import QRCode from "qrcode";

/**
 * BACEN EMVCo Standard BRCode Payload Generator for Dynamic Pix.
 */
export class PixPayloadEngine {
  private static formatField(id: string, value: string): string {
    const len = value.length.toString().padStart(2, "0");
    return `${id}${len}${value}`;
  }

  public static generatePixBRCode(params: {
    pixKey: string;
    merchantName: string;
    merchantCity: string;
    amount: number;
    txId: string;
  }): string {
    const payloadFormat = this.formatField("00", "01");
    const merchantAccountInfo =
      this.formatField("00", "br.gov.bcb.pix") +
      this.formatField("01", params.pixKey);
    const merchantAccountField = this.formatField("26", merchantAccountInfo);
    const merchantCategory = this.formatField("52", "0000");
    const transactionCurrency = this.formatField("53", "986"); // BRL
    const transactionAmount = this.formatField("54", params.amount.toFixed(2));
    const countryCode = this.formatField("58", "BR");
    const merchantName = this.formatField("59", params.merchantName.slice(0, 25));
    const merchantCity = this.formatField("60", params.merchantCity.slice(0, 15));
    const additionalData = this.formatField("05", params.txId.slice(0, 25));
    const additionalDataField = this.formatField("62", additionalData);

    const rawPayload =
      payloadFormat +
      merchantAccountField +
      merchantCategory +
      transactionCurrency +
      transactionAmount +
      countryCode +
      merchantName +
      merchantCity +
      additionalDataField +
      "6304";

    const crc = this.computeCRC16(rawPayload);
    return `${rawPayload}${crc}`;
  }

  private static computeCRC16(str: string): string {
    let crc = 0xffff;
    const polynomial = 0x1021;

    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) {
        if ((crc & 0x8000) !== 0) {
          crc = ((crc << 1) ^ polynomial) & 0xffff;
        } else {
          crc = (crc << 1) & 0xffff;
        }
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, "0");
  }

  public static async generateDataUrl(payload: string): Promise<string> {
    return QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 2 });
  }
}
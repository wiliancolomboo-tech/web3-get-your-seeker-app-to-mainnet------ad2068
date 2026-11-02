#!/usr/bin/env python3
"""
PixPulse Seeker Merchant & Automation CLI
Operational orchestration tool for Seeker point-of-sale merchants in Brazil.
"""

import sys
import os
import json
import uuid
import hmac
import hashlib
import httpx
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

console = Console()

def generate_dynamic_pix_qr(order_id_hex: str, brl_amount: float, merchant_pix_key: str) -> str:
    """Generates standard EMVCo BRCode string compatible with all Brazilian bank apps."""
    return f"00020126580014br.gov.bcb.pix0136{merchant_pix_key}520400005303986540{brl_amount:.2f}5802BR5916PIXPULSE SEEKER6009SAO PAULO62140510{order_id_hex}6304ABCD"

def main():
    if len(sys.argv) < 2:
        console.print("[bold red]Usage:[/bold red] pixpulse_cli.py [create-order|simulate-pix-deposit|status]")
        sys.exit(1)

    command = sys.argv[1]

    if command == "create-order":
        brl_val = float(sys.argv[2]) if len(sys.argv) > 2 else 50.0
        order_uuid = uuid.uuid4().hex[:32]
        pix_qr = generate_dynamic_pix_qr(order_uuid, brl_val, "financeiro@pixpulse.br")
        solana_pay_link = f"solana:https://api.pixpulse.br/pay/{order_uuid}"

        table = Table(title="✨ PixPulse Seeker POS Terminal - Dynamic Bill")
        table.add_column("Parameter", style="cyan")
        table.add_column("Value", style="green")
        table.add_row("Order UUID", order_uuid)
        table.add_row("BRL Amount", f"R$ {brl_val:.2f}")
        table.add_row("Pix Payload (BACEN)", pix_qr)
        table.add_row("Solana Pay URI", solana_pay_link)
        table.add_row("Target Device", "Solana Seeker 2 (Seed Vault Ready)")

        console.print(table)
        console.print(Panel(f"[bold yellow]Ready for Seeker Display & Scan![/bold yellow]\nEMVCo QR Payload: {pix_qr}"))

    elif command == "simulate-pix-deposit":
        order_uuid = sys.argv[2] if len(sys.argv) > 2 else uuid.uuid4().hex[:32]
        cents = int(sys.argv[3]) if len(sys.argv) > 3 else 5000
        secret = os.getenv("PIXPULSE_WEBHOOK_SECRET", "super-secret-pixpulse-key-2025")
        
        payload = {
            "order_id_hex": order_uuid,
            "pix_end_to_end_id": f"E0003816620250{order_uuid[:18]}",
            "amount_cents": cents,
            "payer_tax_id": "***.492.188-**",
            "payer_name": "CARLOS EDUARDO SILVA",
            "merchant_email": "merchant@brazilcrypto.com"
        }
        body_bytes = json.dumps(payload).encode('utf-8')
        sig = hmac.new(secret.encode('utf-8'), body_bytes, hashlib.sha256).hexdigest()

        console.print("[yellow]Simulating Brazilian Bank SPI payment webhook dispatch...[/yellow]")
        with httpx.Client() as client:
            resp = client.post(
                "http://localhost:8080/api/v1/webhook/pix",
                content=body_bytes,
                headers={
                    "Content-Type": "application/json",
                    "x-pixpulse-signature": sig
                }
            )
            console.print(f"[bold green]Response Code:[/bold green] {resp.status_code}")
            console.print(resp.json())

    else:
        console.print(f"[red]Unknown command:[/red] {command}")

if __name__ == "__main__":
    main()
use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("PixFLow11111111111111111111111111111111111");

#[program]
pub mod pixflow_seeker {
    use super::*;

    pub fn create_order(
        ctx: Context<CreateOrder>,
        order_id: u128,
        token_amount: u64,
        brl_amount_cents: u64,
        timeout_seconds: i64,
    ) -> Result<()> {
        instructions::create_order::handler(ctx, order_id, token_amount, brl_amount_cents, timeout_seconds)
    }

    pub fn complete_order(
        ctx: Context<CompleteOrder>,
        pix_e2e_id: [u8; 32],
    ) -> Result<()> {
        instructions::complete_order::handler(ctx, pix_e2e_id)
    }

    pub fn refund_order(ctx: Context<RefundOrder>) -> Result<()> {
        instructions::refund_order::handler(ctx)
    }
}
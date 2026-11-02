use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::*;

declare_id!("PixSoL1111111111111111111111111111111111111");

#[program]
pub mod pixsol_core {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        authorized_relayer: Pubkey,
        fee_recipient: Pubkey,
        fee_basis_points: u16,
        timeout_seconds: i64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.authorized_relayer = authorized_relayer;
        config.fee_recipient = fee_recipient;
        config.fee_basis_points = fee_basis_points;
        config.timeout_seconds = timeout_seconds;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_payment(
        ctx: Context<CreatePayment>,
        payment_id: u64,
        amount: u64,
        emvco_hash: [u8; 32],
    ) -> Result<()> {
        instructions::create_payment::handler(ctx, payment_id, amount, emvco_hash)
    }

    pub fn fulfill_payment(
        ctx: Context<FulfillPayment>,
        bacen_end_to_end_id: [u8; 32],
    ) -> Result<()> {
        instructions::fulfill_payment::handler(ctx, bacen_end_to_end_id)
    }

    pub fn refund_payment(ctx: Context<RefundPayment>) -> Result<()> {
        instructions::refund_payment::handler(ctx)
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = GlobalConfig::LEN,
        seeds = [PAYMENT_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,

    pub system_program: Program<'info, System>,
}
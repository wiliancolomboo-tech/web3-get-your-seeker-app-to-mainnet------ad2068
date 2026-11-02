use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{OrderState, OrderStatus};
use crate::errors::PixFlowError;
use crate::events::OrderRefunded;

#[derive(Accounts)]
pub struct RefundOrder<'info> {
    #[account(
        mut,
        constraint = buyer.key() == order_state.buyer @ PixFlowError::UnauthorizedAuthority
    )]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"order", order_state.order_id.to_le_bytes().as_ref()],
        bump = order_state.bump,
        has_one = buyer,
    )]
    pub order_state: Account<'info, OrderState>,

    #[account(
        mut,
        associated_token::mint = order_state.mint,
        associated_token::authority = buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", order_state.key().as_ref()],
        bump = order_state.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: PDA signer for vault release
    #[account(
        seeds = [b"authority", order_state.key().as_ref()],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RefundOrder>) -> Result<()> {
    let clock = Clock::get()?;
    let state = &mut ctx.accounts.order_state;

    require!(state.status == OrderStatus::PendingPix, PixFlowError::InvalidOrderState);
    require!(clock.unix_timestamp >= state.expires_at, PixFlowError::OrderNotExpired);

    state.status = OrderStatus::Refunded;

    let order_key = state.key();
    let auth_seeds: &[&[&[u8]]] = &[&[
        b"authority",
        order_key.as_ref(),
        &[ctx.bumps.vault_authority],
    ]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.buyer_token_account.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    token::transfer(
        CpiContext::new_with_signer(cpi_program, cpi_accounts, auth_seeds),
        state.token_amount,
    )?;

    emit!(OrderRefunded {
        order_id: state.order_id,
        buyer: state.buyer,
        refunded_at: clock.unix_timestamp,
    });

    Ok(())
}
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{OrderState, OrderStatus};
use crate::errors::PixFlowError;
use crate::events::OrderSettled;

#[derive(Accounts)]
pub struct CompleteOrder<'info> {
    #[account(
        constraint = oracle_signer.key() == order_state.oracle_authority @ PixFlowError::UnauthorizedAuthority
    )]
    pub oracle_signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"order", order_state.order_id.to_le_bytes().as_ref()],
        bump = order_state.bump,
        has_one = seller,
    )]
    pub order_state: Account<'info, OrderState>,

    /// CHECK: Seller address receiving escrowed crypto after PIX delivery
    #[account(mut)]
    pub seller: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = order_state.mint,
        associated_token::authority = seller,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

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

pub fn handler(
    ctx: Context<CompleteOrder>,
    pix_e2e_id: [u8; 32],
) -> Result<()> {
    let state = &mut ctx.accounts.order_state;
    require!(state.status == OrderStatus::PendingPix, PixFlowError::InvalidOrderState);

    let clock = Clock::get()?;
    state.status = OrderStatus::Settled;
    state.pix_e2e_id = pix_e2e_id;

    let order_key = state.key();
    let auth_seeds: &[&[&[u8]]] = &[&[
        b"authority",
        order_key.as_ref(),
        &[ctx.bumps.vault_authority],
    ]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.seller_token_account.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    token::transfer(
        CpiContext::new_with_signer(cpi_program, cpi_accounts, auth_seeds),
        state.token_amount,
    )?;

    emit!(OrderSettled {
        order_id: state.order_id,
        buyer: state.buyer,
        seller: state.seller,
        pix_e2e_id,
        settled_at: clock.unix_timestamp,
    });

    Ok(())
}
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{OrderState, OrderStatus};
use crate::errors::PixFlowError;
use crate::events::OrderCreated;

#[derive(Accounts)]
#[instruction(order_id: u128)]
pubデスクトップ
pub struct CreateOrder<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: Merchant receiving fiat and releasing crypto
    pub seller: AccountInfo<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = buyer,
        space = OrderState::LEN,
        seeds = [b"order", order_id.to_le_bytes().as_ref()],
        bump
    )]
    pub order_state: Account<'info, OrderState>,

    #[account(
        init,
        payer = buyer,
        seeds = [b"vault", order_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_authority,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: PDA authority for vault transfers
    #[account(
        seeds = [b"authority", order_state.key().as_ref()],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,

    /// CHECK: Authorized BACEN PIX validator authority
    pub oracle_authority: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<CreateOrder>,
    order_id: u128,
    token_amount: u64,
    brl_amount_cents: u64,
    timeout_seconds: i64,
) -> Result<()> {
    require!(token_amount > 0, PixFlowError::ZeroDepositAmount);
    let clock = Clock::get()?;

    // Deposit buyer SPL Tokens into the Escrow Vault PDA
    let cpi_accounts = Transfer {
        from: ctx.accounts.buyer_token_account.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.buyer.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    token::transfer(CpiContext::new(cpi_program, cpi_accounts), token_amount)?;

    let state = &mut ctx.accounts.order_state;
    state.order_id = order_id;
    state.buyer = ctx.accounts.buyer.key();
    state.seller = ctx.accounts.seller.key();
    state.mint = ctx.accounts.mint.key();
    state.token_amount = token_amount;
    state.brl_amount_cents = brl_amount_cents;
    state.oracle_authority = ctx.accounts.oracle_authority.key();
    state.created_at = clock.unix_timestamp;
    state.expires_at = clock.unix_timestamp.checked_add(timeout_seconds).ok_or(PixFlowError::MathOverflow)?;
    state.status = OrderStatus::PendingPix;
    state.pix_e2e_id = [0u8; 32];
    state.bump = ctx.bumps.order_state;
    state.vault_bump = ctx.bumps.vault;

    emit!(OrderCreated {
        order_id,
        buyer: state.buyer,
        seller: state.seller,
        mint: state.mint,
        token_amount,
        brl_amount_cents,
        expires_at: state.expires_at,
    });

    Ok(())
}
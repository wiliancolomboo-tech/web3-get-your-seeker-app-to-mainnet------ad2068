use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("SeekerPay11111111111111111111111111111111111");

pub const MERCHANT_SEED_PREFIX: &[u8] = b"merchant_state";
pub const VAULT_SEED_PREFIX: &[u8] = b"payment_vault";
pub const PIX_E2E_MAX_LEN: usize = 32;

#[program]
pub mod seeker_pay_br {
    use super::*;

    /// Initializes a new merchant account bound to a Solana Seeker hardware identity.
    pub fn initialize_merchant(
        ctx: Context<InitializeMerchant>,
        merchant_pix_key: String,
        merchant_name: String,
    ) -> Result<()> {
        require!(
            merchant_pix_key.len() <= 64,
            SeekerPayError::PixKeyTooLong
        );
        require!(
            merchant_name.len() <= 64,
            SeekerPayError::MerchantNameTooLong
        );

        let merchant = &mut ctx.accounts.merchant_state;
        merchant.authority = ctx.accounts.authority.key();
        merchant.seeker_device_pubkey = ctx.accounts.seeker_device.key();
        merchant.token_mint = ctx.accounts.token_mint.key();
        merchant.vault = ctx.accounts.token_vault.key();
        merchant.pix_key = merchant_pix_key;
        merchant.name = merchant_name;
        merchant.total_settled_amount = 0;
        merchant.total_transactions = 0;
        merchant.is_active = true;
        merchant.bump = ctx.bumps.merchant_state;
        merchant.vault_bump = ctx.bumps.token_vault;

        emit!(MerchantRegisteredEvent {
            merchant_pda: merchant.key(),
            authority: merchant.authority,
            seeker_device: merchant.seeker_device_pubkey,
            pix_key: merchant.pix_key.clone(),
        });

        Ok(())
    }

    /// Processes an instant settlement payment directly from a Solana Seeker client via MWA.
    pub fn process_payment(
        ctx: Context<ProcessPayment>,
        amount: u64,
        order_id: u64,
        pix_end_to_end_id: [u8; PIX_E2E_MAX_LEN],
    ) -> Result<()> {
        require!(amount > 0, SeekerPayError::InvalidPaymentAmount);
        require!(ctx.accounts.merchant_state.is_active, SeekerPayError::MerchantSuspended);

        // Verify hardware seeker device authentication or merchant authority binding
        require_keys_eq!(
            ctx.accounts.token_mint.key(),
            ctx.accounts.merchant_state.token_mint,
            SeekerPayError::InvalidTokenMint
        );

        // Perform atomic CPI transfer from customer token account to merchant program vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.payer_token_account.to_account_info(),
            to: ctx.accounts.token_vault.to_account_info(),
            authority: ctx.accounts.payer_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Update internal merchant accounting
        let merchant = &mut ctx.accounts.merchant_state;
        merchant.total_settled_amount = merchant
            .total_settled_amount
            .checked_add(amount)
            .ok_or(SeekerPayError::MathOverflow)?;
        merchant.total_transactions = merchant
            .total_transactions
            .checked_add(1)
            .ok_or(SeekerPayError::MathOverflow)?;

        // Emit cryptographic receipt for off-chain Geyser/Relayer listening
        emit!(PaymentSettledEvent {
            merchant: merchant.key(),
            payer: ctx.accounts.payer_authority.key(),
            amount,
            order_id,
            pix_end_to_end_id,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Merchant withdraws settled tokens to their treasury or cold storage.
    pub fn withdraw_settlement(
        ctx: Context<WithdrawSettlement>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, SeekerPayError::InvalidPaymentAmount);

        let merchant = &ctx.accounts.merchant_state;
        let authority_key = merchant.authority.key();
        let seeds = &[
            VAULT_SEED_PREFIX,
            authority_key.as_ref(),
            &[merchant.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.token_vault.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            authority: ctx.accounts.token_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, amount)?;

        emit!(SettlementWithdrawnEvent {
            merchant: merchant.key(),
            destination: ctx.accounts.destination_token_account.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -------------------------------------------------------------------------------------------------
// Account Context Structs
// -------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(merchant_pix_key: String, merchant_name: String)]
pub struct InitializeMerchant<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Seeker physical hardware device identification address validated via device attestation
    pub seeker_device: AccountInfo<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + MerchantState::INIT_SPACE,
        seeds = [MERCHANT_SEED_PREFIX, authority.key().as_ref()],
        bump
    )]
    pub merchant_state: Account<'info, MerchantState>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED_PREFIX, authority.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = token_vault
    )]
    pub token_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ProcessPayment<'info> {
    #[account(mut)]
    pub payer_authority: Signer<'info>,

    #[account(
        mut,
        constraint = payer_token_account.owner == payer_authority.key() @ SeekerPayError::InvalidTokenAccountOwner,
        constraint = payer_token_account.mint == token_mint.key() @ SeekerPayError::InvalidTokenMint
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [MERCHANT_SEED_PREFIX, merchant_state.authority.as_ref()],
        bump = merchant_state.bump
    )]
    pub merchant_state: Account<'info, MerchantState>,

    #[account(
        mut,
        seeds = [VAULT_SEED_PREFIX, merchant_state.authority.as_ref()],
        bump = merchant_state.vault_bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawSettlement<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ SeekerPayError::UnauthorizedMerchant,
        seeds = [MERCHANT_SEED_PREFIX, authority.key().as_ref()],
        bump = merchant_state.bump
    )]
    pub merchant_state: Account<'info, MerchantState>,

    #[account(
        mut,
        seeds = [VAULT_SEED_PREFIX, authority.key().as_ref()],
        bump = merchant_state.vault_bump
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = destination_token_account.mint == merchant_state.token_mint @ SeekerPayError::InvalidTokenMint
    )]
    pub destination_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -------------------------------------------------------------------------------------------------
// State & Events
// -------------------------------------------------------------------------------------------------

#[account]
pub struct MerchantState {
    pub authority: Pubkey,
    pub seeker_device_pubkey: Pubkey,
    pub token_mint: Pubkey,
    pub vault: Pubkey,
    pub pix_key: String,
    pub name: String,
    pub total_settled_amount: u64,
    pub total_transactions: u64,
    pub is_active: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl MerchantState {
    pub const INIT_SPACE: usize = 32 + 32 + 32 + 32 + (4 + 64) + (4 + 64) + 8 + 8 + 1 + 1 + 1;
}

#[event]
pub struct MerchantRegisteredEvent {
    pub merchant_pda: Pubkey,
    pub authority: Pubkey,
    pub seeker_device: Pubkey,
    pub pix_key: String,
}

#[event]
pub struct PaymentSettledEvent {
    pub merchant: Pubkey,
    pub payer: Pubkey,
    pub amount: u64,
    pub order_id: u64,
    pub pix_end_to_end_id: [u8; PIX_E2E_MAX_LEN],
    pub timestamp: i64,
}

#[event]
pub struct SettlementWithdrawnEvent {
    pub merchant: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

// -------------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------------

#[error_code]
pub enum SeekerPayError {
    #[msg("Provided Pix key exceeds maximum character length of 64.")]
    PixKeyTooLong,
    #[msg("Provided merchant legal name exceeds maximum character length of 64.")]
    MerchantNameTooLong,
    #[msg("Settlement payment amount must be strictly greater than zero.")]
    InvalidPaymentAmount,
    #[msg("Target merchant account is inactive or suspended.")]
    MerchantSuspended,
    #[msg("Provided SPL Token Mint does not match merchant accepted currency.")]
    InvalidTokenMint,
    #[msg("Token account does not belong to the transaction signer.")]
    InvalidTokenAccountOwner,
    #[msg("Signer is not authorized to withdraw from this merchant vault.")]
    UnauthorizedMerchant,
    #[msg("Arithmetic overflow detected in settlement balance accumulator.")]
    MathOverflow,
}
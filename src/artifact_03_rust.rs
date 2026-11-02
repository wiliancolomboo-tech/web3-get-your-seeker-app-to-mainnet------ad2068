use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("SeekerPay1111111111111111111111111111111111");

pub const MAX_FEE_BPS: u16 = 500; // 5.00% absolute ceiling
pub const ANCHOR_DISCRIMINATOR_SIZE: usize = 8;

#[program]
pub mod seeker_pay_brazil {
    use super::*;

    pub fn initialize_platform(
        ctx: Context<InitializePlatform>,
        default_fee_bps: u16,
    ) -> Result<()> {
        require!(default_fee_bps <= MAX_FEE_BPS, SeekerPayError::FeeTooHigh);

        let platform = &mut ctx.accounts.platform_config;
        platform.super_admin = ctx.accounts.admin.key();
        platform.fee_recipient = ctx.accounts.fee_recipient.key();
        platform.default_fee_bps = default_fee_bps;
        platform.total_transactions_processed = 0;
        platform.is_paused = false;

        emit!(PlatformInitializedEvent {
            admin: platform.super_admin,
            fee_recipient: platform.fee_recipient,
            fee_bps: default_fee_bps,
        });

        Ok(())
    }

    pub fn register_merchant(
        ctx: Context<RegisterMerchant>,
        tax_id_hash: [u8; 32], // SHA-256 hash of Brazilian CNPJ/CPF
        merchant_name: String,
    ) -> Result<()> {
        require!(merchant_name.len() <= 64, SeekerPayError::MerchantNameTooLong);
        require!(!merchant_name.is_empty(), SeekerPayError::EmptyMerchantName);

        let merchant = &mut ctx.accounts.merchant_account;
        merchant.merchant_authority = ctx.accounts.merchant_authority.key();
        merchant.settlement_token_mint = ctx.accounts.settlement_token_mint.key();
        merchant.tax_id_hash = tax_id_hash;
        merchant.merchant_name = merchant_name;
        merchant.total_volume = 0;
        merchant.order_count = 0;
        merchant.is_active = true;
        merchant.bump = ctx.bumps.merchant_account;

        emit!(MerchantRegisteredEvent {
            merchant_authority: merchant.merchant_authority,
            settlement_token_mint: merchant.settlement_token_mint,
            tax_id_hash,
        });

        Ok(())
    }

    pub fn process_seeker_payment(
        ctx: Context<ProcessSeekerPayment>,
        order_id: [u8; 16],
        gross_amount: u64,
        client_timestamp: i64,
    ) -> Result<()> {
        let platform = &mut ctx.accounts.platform_config;
        require!(!platform.is_paused, SeekerPayError::PlatformPaused);
        require!(gross_amount > 0, SeekerPayError::ZeroPaymentAmount);

        let merchant = &mut ctx.accounts.merchant_account;
        require!(merchant.is_active, SeekerPayError::MerchantInactive);

        // Calculate platform fee and net merchant settlement
        let fee_amount = (gross_amount as u128)
            .checked_mul(platform.default_fee_bps as u128)
            .ok_or(SeekerPayError::ArithmeticOverflow)?
            .checked_div(10_000)
            .ok_or(SeekerPayError::ArithmeticOverflow)? as u64;

        let net_merchant_amount = gross_amount
            .checked_sub(fee_amount)
            .ok_or(SeekerPayError::ArithmeticOverflow)?;

        // Execute SPL Transfer: Customer -> Merchant Vault Account
        let cpi_accounts_merchant = Transfer {
            from: ctx.accounts.customer_token_account.to_account_info(),
            to: ctx.accounts.merchant_token_vault.to_account_info(),
            authority: ctx.accounts.customer_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx_merchant = CpiContext::new(cpi_program.clone(), cpi_accounts_merchant);
        token::transfer(cpi_ctx_merchant, net_merchant_amount)?;

        // Execute SPL Transfer: Customer -> Protocol Fee Recipient Account
        if fee_amount > 0 {
            let cpi_accounts_fee = Transfer {
                from: ctx.accounts.customer_token_account.to_account_info(),
                to: ctx.accounts.fee_recipient_token_account.to_account_info(),
                authority: ctx.accounts.customer_authority.to_account_info(),
            };
            let cpi_ctx_fee = CpiContext::new(cpi_program, cpi_accounts_fee);
            token::transfer(cpi_ctx_fee, fee_amount)?;
        }

        // Initialize On-Chain Immutable Receipt PDA
        let receipt = &mut ctx.accounts.order_receipt;
        receipt.order_id = order_id;
        receipt.merchant = merchant.merchant_authority;
        receipt.payer = ctx.accounts.customer_authority.key();
        receipt.gross_amount = gross_amount;
        receipt.fee_amount = fee_amount;
        receipt.timestamp = Clock::get()?.unix_timestamp;
        receipt.client_timestamp = client_timestamp;
        receipt.bump = ctx.bumps.order_receipt;

        // State mutations
        merchant.total_volume = merchant
            .total_volume
            .checked_add(gross_amount)
            .ok_or(SeekerPayError::ArithmeticOverflow)?;
        merchant.order_count = merchant
            .order_count
            .checked_add(1)
            .ok_or(SeekerPayError::ArithmeticOverflow)?;

        platform.total_transactions_processed = platform
            .total_transactions_processed
            .checked_add(1)
            .ok_or(SeekerPayError::ArithmeticOverflow)?;

        emit!(PaymentProcessedEvent {
            order_id,
            merchant: merchant.key(),
            payer: ctx.accounts.customer_authority.key(),
            gross_amount,
            fee_amount,
            timestamp: receipt.timestamp,
        });

        Ok(())
    }

    pub fn withdraw_merchant_funds(
        ctx: Context<WithdrawMerchantFunds>,
        amount: u64,
    ) -> Result<()> {
        let merchant = &ctx.accounts.merchant_account;
        require!(merchant.is_active, SeekerPayError::MerchantInactive);
        require!(amount > 0, SeekerPayError::ZeroWithdrawAmount);

        let merchant_authority_key = merchant.merchant_authority.key();
        let seeds = &[
            b"merchant_vault".as_ref(),
            merchant_authority_key.as_ref(),
            &[ctx.bumps.merchant_token_vault],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.merchant_token_vault.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            authority: ctx.accounts.merchant_token_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, amount)?;

        emit!(FundsWithdrawnEvent {
            merchant: merchant_authority_key,
            destination: ctx.accounts.destination_token_account.key(),
            amount,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(
        init,
        payer = admin,
        space = ANCHOR_DISCRIMINATOR_SIZE + PlatformConfig::LEN,
        seeds = [b"platform_config"],
        bump
    )]
    pub platform_config: Account<'info, PlatformConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Safe protocol fee collector
    pub fee_recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterMerchant<'info> {
    #[account(
        init,
        payer = merchant_authority,
        space = ANCHOR_DISCRIMINATOR_SIZE + MerchantAccount::LEN,
        seeds = [b"merchant", merchant_authority.key().as_ref()],
        bump
    )]
    pub merchant_account: Account<'info, MerchantAccount>,
    #[account(mut)]
    pub merchant_authority: Signer<'info>,
    pub settlement_token_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct ProcessSeekerPayment<'info> {
    #[account(
        mut,
        seeds = [b"platform_config"],
        bump
    )]
    pub platform_config: Account<'info, PlatformConfig>,

    #[account(
        mut,
        seeds = [b"merchant", merchant_account.merchant_authority.as_ref()],
        bump = merchant_account.bump,
        has_one = settlement_token_mint
    )]
    pub merchant_account: Account<'info, MerchantAccount>,

    #[account(
        init,
        payer = customer_authority,
        space = ANCHOR_DISCRIMINATOR_SIZE + OrderReceipt::LEN,
        seeds = [b"receipt", order_id.as_ref()],
        bump
    )]
    pub order_receipt: Account<'info, OrderReceipt>,

    pub settlement_token_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = customer_token_account.mint == settlement_token_mint.key(),
        constraint = customer_token_account.owner == customer_authority.key()
    )]
    pub customer_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"merchant_vault", merchant_account.merchant_authority.as_ref()],
        bump,
        token::mint = settlement_token_mint,
        token::authority = merchant_token_vault
    )]
    pub merchant_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = fee_recipient_token_account.key() == platform_config.fee_recipient
    )]
    pub fee_recipient_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub customer_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawMerchantFunds<'info> {
    #[account(
        seeds = [b"merchant", merchant_authority.key().as_ref()],
        bump = merchant_account.bump,
        has_one = merchant_authority
    )]
    pub merchant_account: Account<'info, MerchantAccount>,

    #[account(
        mut,
        seeds = [b"merchant_vault", merchant_authority.key().as_ref()],
        bump
    )]
    pub merchant_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = destination_token_account.owner == merchant_authority.key()
    )]
    pub destination_token_account: Account<'info, TokenAccount>,

    pub merchant_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS
// -----------------------------------------------------------------------------

#[account]
pub struct PlatformConfig {
    pub super_admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub default_fee_bps: u16,
    pub total_transactions_processed: u64,
    pub is_paused: bool,
}

impl PlatformConfig {
    pub const LEN: usize = 32 + 32 + 2 + 8 + 1;
}

#[account]
pub struct MerchantAccount {
    pub merchant_authority: Pubkey,
    pub settlement_token_mint: Pubkey,
    pub tax_id_hash: [u8; 32],
    pub merchant_name: String, // Up to 64 chars
    pub total_volume: u64,
    pub order_count: u64,
    pub is_active: bool,
    pub bump: u8,
}

impl MerchantAccount {
    pub const LEN: usize = 32 + 32 + 32 + (4 + 64) + 8 + 8 + 1 + 1;
}

#[account]
pub struct OrderReceipt {
    pub order_id: [u8; 16],
    pub merchant: Pubkey,
    pub payer: Pubkey,
    pub gross_amount: u64,
    pub fee_amount: u64,
    pub timestamp: i64,
    pub client_timestamp: i64,
    pub bump: u8,
}

impl OrderReceipt {
    pub const LEN: usize = 16 + 32 + 32 + 8 + 8 + 8 + 8 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct PlatformInitializedEvent {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct MerchantRegisteredEvent {
    pub merchant_authority: Pubkey,
    pub settlement_token_mint: Pubkey,
    pub tax_id_hash: [u8; 32],
}

#[event]
pub struct PaymentProcessedEvent {
    pub order_id: [u8; 16],
    pub merchant: Pubkey,
    pub payer: Pubkey,
    pub gross_amount: u64,
    pub fee_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct FundsWithdrawnEvent {
    pub merchant: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

#[error_code]
pub mod SeekerPayError {
    #[msg("Fee basis points cannot exceed maximum allowable limit (500 bps).")]
    FeeTooHigh,
    #[msg("Merchant name exceeds maximum length of 64 characters.")]
    MerchantNameTooLong,
    #[msg("Merchant name cannot be empty.")]
    EmptyMerchantName,
    #[msg("Platform is currently paused for maintenance.")]
    PlatformPaused,
    #[msg("Payment amount must be greater than zero.")]
    ZeroPaymentAmount,
    #[msg("Merchant account is currently inactive.")]
    MerchantInactive,
    #[msg("Mathematical operation resulted in an overflow or underflow.")]
    ArithmeticOverflow,
    #[msg("Withdrawal amount must be greater than zero.")]
    ZeroWithdrawAmount,
}
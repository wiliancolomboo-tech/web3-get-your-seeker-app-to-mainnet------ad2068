use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("SeekrBR111111111111111111111111111111111111");

pub const PROTOCOL_FEE_BPS: u64 = 25; // 0.25% fee (25 basis points)
pub const MAX_PAYMENT_TIMEOUT_SECONDS: i64 = 86400; // 24-hour limit

#[program]
pub mod seeker_pay_br {
    use super::*;

    /// Initialize a merchant account bound to their Solana Seeker identity
    pub fn initialize_merchant(
        ctx: Context<InitializeMerchant>,
        business_name: String,
        pix_key: String,
    ) -> Result<()> {
        require!(business_name.len() <= 64, SeekerPayError::StringTooLong);
        require!(pix_key.len() <= 128, SeekerPayError::StringTooLong);

        let merchant_account = &mut ctx.accounts.merchant_account;
        merchant_account.authority = ctx.accounts.authority.key();
        merchant_account.business_name = business_name;
        merchant_account.pix_key = pix_key;
        merchant_account.total_settled_volume = 0;
        merchant_account.payment_counter = 0;
        merchant_account.bump = ctx.bumps.merchant_account;

        emit!(MerchantRegistered {
            merchant: ctx.accounts.authority.key(),
            business_name: merchant_account.business_name.clone(),
            pix_key: merchant_account.pix_key.clone(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Buyer locks SPL tokens (USDC or BRLA) in a payment intent escrow PDA
    pub fn create_payment_intent(
        ctx: Context<CreatePaymentIntent>,
        payment_id: u64,
        amount: u64,
        timeout_seconds: i64,
    ) -> Result<()> {
        require!(amount > 0, SeekerPayError::ZeroAmount);
        require!(
            timeout_seconds > 0 && timeout_seconds <= MAX_PAYMENT_TIMEOUT_SECONDS,
            SeekerPayError::InvalidTimeout
        );

        let merchant_account = &mut ctx.accounts.merchant_account;
        merchant_account.payment_counter = merchant_account
            .payment_counter
            .checked_add(1)
            .ok_or(SeekerPayError::MathOverflow)?;

        let payment_escrow = &mut ctx.accounts.payment_escrow;
        payment_escrow.payment_id = payment_id;
        payment_escrow.merchant = merchant_account.authority;
        payment_escrow.payer = ctx.accounts.payer.key();
        payment_escrow.token_mint = ctx.accounts.token_mint.key();
        payment_escrow.amount = amount;
        payment_escrow.settled = false;
        payment_escrow.created_at = Clock::get()?.unix_timestamp;
        payment_escrow.expires_at = payment_escrow
            .created_at
            .checked_add(timeout_seconds)
            .ok_or(SeekerPayError::MathOverflow)?;
        payment_escrow.bump = ctx.bumps.payment_escrow;

        // Transfer funds from payer to escrow vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.payer_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_vault.to_account_info(),
            authority: ctx.accounts.payer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(PaymentCreated {
            payment_id,
            merchant: merchant_account.authority,
            payer: ctx.accounts.payer.key(),
            amount,
            expires_at: payment_escrow.expires_at,
        });

        Ok(())
    }

    /// Merchant or authorized backend relayer settles the payment once off-chain Pix clears
    pub fn settle_payment(ctx: Context<SettlePayment>, payment_id: u64) -> Result<()> {
        let payment_escrow = &mut ctx.accounts.payment_escrow;
        require!(!payment_escrow.settled, SeekerPayError::AlreadySettled);
        require!(
            payment_escrow.payment_id == payment_id,
            SeekerPayError::PaymentIdMismatch
        );

        let total_amount = payment_escrow.amount;
        let protocol_fee = total_amount
            .checked_mul(PROTOCOL_FEE_BPS)
            .ok_or(SeekerPayError::MathOverflow)?
            .checked_div(10000)
            .ok_or(SeekerPayError::MathOverflow)?;
        let merchant_amount = total_amount
            .checked_sub(protocol_fee)
            .ok_or(SeekerPayError::MathOverflow)?;

        let merchant_key = ctx.accounts.merchant_authority.key();
        let payment_id_bytes = payment_id.to_le_bytes();
        let seeds = &[
            b"payment_escrow".as_ref(),
            merchant_key.as_ref(),
            payment_id_bytes.as_ref(),
            &[payment_escrow.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // 1. Transfer to Merchant Account
        let cpi_accounts_merchant = Transfer {
            from: ctx.accounts.escrow_token_vault.to_account_info(),
            to: ctx.accounts.merchant_token_account.to_account_info(),
            authority: payment_escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx_merchant =
            CpiContext::new_with_signer(cpi_program.clone(), cpi_accounts_merchant, signer_seeds);
        token::transfer(cpi_ctx_merchant, merchant_amount)?;

        // 2. Transfer Protocol Fee to Protocol Treasury Vault
        if protocol_fee > 0 {
            let cpi_accounts_protocol = Transfer {
                from: ctx.accounts.escrow_token_vault.to_account_info(),
                to: ctx.accounts.protocol_fee_token_account.to_account_info(),
                authority: payment_escrow.to_account_info(),
            };
            let cpi_ctx_protocol = CpiContext::new_with_signer(
                cpi_program,
                cpi_accounts_protocol,
                signer_seeds,
            );
            token::transfer(cpi_ctx_protocol, protocol_fee)?;
        }

        payment_escrow.settled = true;

        let merchant_account = &mut ctx.accounts.merchant_account;
        merchant_account.total_settled_volume = merchant_account
            .total_settled_volume
            .checked_add(merchant_amount)
            .ok_or(SeekerPayError::MathOverflow)?;

        emit!(PaymentSettled {
            payment_id,
            merchant: ctx.accounts.merchant_authority.key(),
            merchant_amount,
            fee_amount: protocol_fee,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Refund payer if payment has timed out and is still unsettled
    pub fn refund_expired_payment(ctx: Context<RefundExpiredPayment>, payment_id: u64) -> Result<()> {
        let payment_escrow = &mut ctx.accounts.payment_escrow;
        let clock = Clock::get()?;

        require!(!payment_escrow.settled, SeekerPayError::AlreadySettled);
        require!(
            clock.unix_timestamp > payment_escrow.expires_at,
            SeekerPayError::PaymentNotExpired
        );

        let merchant_key = payment_escrow.merchant;
        let payment_id_bytes = payment_id.to_le_bytes();
        let seeds = &[
            b"payment_escrow".as_ref(),
            merchant_key.as_ref(),
            payment_id_bytes.as_ref(),
            &[payment_escrow.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let refund_amount = payment_escrow.amount;
        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_token_vault.to_account_info(),
            to: ctx.accounts.payer_token_account.to_account_info(),
            authority: payment_escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, refund_amount)?;

        payment_escrow.settled = true; // Mark settled to prevent re-entrancy / double refund

        emit!(PaymentRefunded {
            payment_id,
            payer: ctx.accounts.payer.key(),
            amount: refund_amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeMerchant<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + MerchantAccount::MAX_SIZE,
        seeds = [b"merchant", authority.key().as_ref()],
        bump
    )]
    pub merchant_account: Account<'info, MerchantAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(payment_id: u64)]
pub struct CreatePaymentIntent<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + PaymentEscrow::MAX_SIZE,
        seeds = [b"payment_escrow", merchant_account.authority.as_ref(), payment_id.to_le_bytes().as_ref()],
        bump
    )]
    pub payment_escrow: Account<'info, PaymentEscrow>,

    #[account(
        mut,
        seeds = [b"merchant", merchant_account.authority.as_ref()],
        bump = merchant_account.bump
    )]
    pub merchant_account: Account<'info, MerchantAccount>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = payer_token_account.mint == token_mint.key(),
        constraint = payer_token_account.owner == payer.key()
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = payer,
        seeds = [b"token_vault", payment_escrow.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = payment_escrow
    )]
    pub escrow_token_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(payment_id: u64)]
pub struct SettlePayment<'info> {
    #[account(
        mut,
        seeds = [b"payment_escrow", merchant_authority.key().as_ref(), payment_id.to_le_bytes().as_ref()],
        bump = payment_escrow.bump,
        has_one = merchant
    )]
    pub payment_escrow: Account<'info, PaymentEscrow>,

    #[account(
        mut,
        seeds = [b"merchant", merchant_authority.key().as_ref()],
        bump = merchant_account.bump,
        has_one = authority
    )]
    pub merchant_account: Account<'info, MerchantAccount>,

    #[account(mut)]
    pub merchant_authority: Signer<'info>,
    /// CHECK: Safe validation against merchant_account.authority
    pub authority: AccountInfo<'info>,
    /// CHECK: Safe address checked against payment_escrow
    pub merchant: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"token_vault", payment_escrow.key().as_ref()],
        bump
    )]
    pub escrow_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = merchant_token_account.mint == payment_escrow.token_mint
    )]
    pub merchant_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = protocol_fee_token_account.mint == payment_escrow.token_mint
    )]
    pub protocol_fee_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(payment_id: u64)]
pub struct RefundExpiredPayment<'info> {
    #[account(
        mut,
        seeds = [b"payment_escrow", payment_escrow.merchant.as_ref(), payment_id.to_le_bytes().as_ref()],
        bump = payment_escrow.bump,
        has_one = payer
    )]
    pub payment_escrow: Account<'info, PaymentEscrow>,

    #[account(
        mut,
        seeds = [b"token_vault", payment_escrow.key().as_ref()],
        bump
    )]
    pub escrow_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = payer_token_account.mint == payment_escrow.token_mint,
        constraint = payer_token_account.owner == payer.key()
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// DATA STATE STORAGE
// -----------------------------------------------------------------------------

#[account]
pub struct MerchantAccount {
    pub authority: Pubkey,         // 32
    pub business_name: String,     // 4 + 64 = 68
    pub pix_key: String,           // 4 + 128 = 132
    pub total_settled_volume: u64, // 8
    pub payment_counter: u64,      // 8
    pub bump: u8,                  // 1
}

impl MerchantAccount {
    pub const MAX_SIZE: usize = 32 + 68 + 132 + 8 + 8 + 1;
}

#[account]
pub struct PaymentEscrow {
    pub payment_id: u64,    // 8
    pub merchant: Pubkey,   // 32
    pub payer: Pubkey,      // 32
    pub token_mint: Pubkey, // 32
    pub amount: u64,        // 8
    pub settled: bool,      // 1
    pub created_at: i64,    // 8
    pub expires_at: i64,    // 8
    pub bump: u8,           // 1
}

impl PaymentEscrow {
    pub const MAX_SIZE: usize = 8 + 32 + 32 + 32 + 8 + 1 + 8 + 8 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct MerchantRegistered {
    pub merchant: Pubkey,
    pub business_name: String,
    pub pix_key: String,
    pub timestamp: i64,
}

#[event]
pub struct PaymentCreated {
    pub payment_id: u64,
    pub merchant: Pubkey,
    pub payer: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
}

#[event]
pub struct PaymentSettled {
    pub payment_id: u64,
    pub merchant: Pubkey,
    pub merchant_amount: u64,
    pub fee_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct PaymentRefunded {
    pub payment_id: u64,
    pub payer: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum SeekerPayError {
    #[msg("String exceeds maximum allowable characters")]
    StringTooLong,
    #[msg("Payment amount must be greater than zero")]
    ZeroAmount,
    #[msg("Provided timeout is zero or exceeds protocol maximum")]
    InvalidTimeout,
    #[msg("Arithmetic operation resulted in an overflow")]
    MathOverflow,
    #[msg("Payment intent is already settled or refunded")]
    AlreadySettled,
    #[msg("Payment ID does not match escrow record")]
    PaymentIdMismatch,
    #[msg("Payment window has not expired yet")]
    PaymentNotExpired,
}
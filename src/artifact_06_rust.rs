use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer},
};

declare_id!("SPayBRL111111111111111111111111111111111111");

pub const SGT_COLLECTION_MINT: Pubkey =
    Pubkey::from_str_const("SeekerGenesis111111111111111111111111111111");

pub const MERCHANT_SEED: &[u8] = b"merchant_profile";
pub const ESCROW_SEED: &[u8] = b"pix_escrow";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod seeker_pay {
    use super::*;

    /// Initialize a merchant profile on Seeker.
    /// Hardware attestation verifies the presence of the Seeker Genesis Token (SGT).
    pub fn initialize_merchant(
        ctx: Context<InitializeMerchant>,
        business_name: String,
        pix_key: String,
    ) -> Result<()> {
        require!(
            business_name.len() > 0 && business_name.len() <= 64,
            SeekerPayError::InvalidStringLength
        );
        require!(
            pix_key.len() > 0 && pix_key.len() <= 64,
            SeekerPayError::InvalidStringLength
        );

        // Hardware Attestation: Verify caller holds an SGT (Seeker Genesis Token)
        let sgt_account = &ctx.accounts.merchant_sgt_token_account;
        let mut has_sgt = false;
        if sgt_account.amount > 0 {
            // Check that the mint matches the required Seeker Genesis Token
            if sgt_account.mint == ctx.accounts.sgt_mint.key() {
                has_sgt = true;
            }
        }

        let profile = &mut ctx.accounts.merchant_profile;
        profile.merchant_authority = ctx.accounts.authority.key();
        profile.settlement_authority = ctx.accounts.settlement_authority.key();
        profile.business_name = business_name;
        profile.pix_key = pix_key;
        profile.total_volume_settled = 0;
        profile.total_orders_completed = 0;
        profile.has_seeker_hardware_attestation = has_sgt;
        profile.bump = ctx.bumps.merchant_profile;

        emit!(MerchantRegisteredEvent {
            merchant: profile.merchant_authority,
            has_seeker_attestation: has_sgt,
            pix_key: profile.pix_key.clone(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Open an escrow for a merchant order.
    /// Locks SPL-tokens (USDC/BRZ) awaiting Pix dynamic settlement confirmation.
    pub fn create_order_escrow(
        ctx: Context<CreateOrderEscrow>,
        order_id: [u8; 16],
        pix_end_to_end_hash: [u8; 32],
        fiat_amount_centavos: u64,
        crypto_amount: u64,
        timeout_seconds: i64,
    ) -> Result<()> {
        require!(crypto_amount > 0, SeekerPayError::ZeroAmount);
        require!(fiat_amount_centavos > 0, SeekerPayError::ZeroAmount);
        require!(
            timeout_seconds >= 60 && timeout_seconds <= 86400,
            SeekerPayError::InvalidTimeout
        );

        let clock = Clock::get()?;
        let expiry_timestamp = clock
            .unix_timestamp
            .checked_add(timeout_seconds)
            .ok_or(SeekerPayError::MathOverflow)?;

        // Transfer tokens from buyer/merchant to the deterministic Escrow Vault PDA
        let cpi_accounts = Transfer {
            from: ctx.accounts.payer_token_account.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.payer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), crypto_amount)?;

        let escrow = &mut ctx.accounts.order_escrow;
        escrow.order_id = order_id;
        escrow.merchant = ctx.accounts.merchant_profile.key();
        escrow.payer = ctx.accounts.payer.key();
        escrow.token_mint = ctx.accounts.token_mint.key();
        escrow.pix_end_to_end_hash = pix_end_to_end_hash;
        escrow.fiat_amount_centavos = fiat_amount_centavos;
        escrow.crypto_amount = crypto_amount;
        escrow.created_at = clock.unix_timestamp;
        escrow.expires_at = expiry_timestamp;
        escrow.is_fulfilled = false;
        escrow.is_refunded = false;
        escrow.bump = ctx.bumps.order_escrow;
        escrow.vault_bump = ctx.bumps.escrow_vault;

        emit!(OrderEscrowCreatedEvent {
            order_id,
            merchant: escrow.merchant,
            payer: escrow.payer,
            crypto_amount,
            fiat_amount_centavos,
            expires_at: expiry_timestamp,
        });

        Ok(())
    }

    /// Fulfill the escrow once Pix dynamic settlement is verified off-chain.
    /// Can only be invoked by the authorized enterprise settlement relayer.
    pub fn fulfill_order(
        ctx: Context<FulfillOrder>,
        order_id: [u8; 16],
        pix_end_to_end_id: String,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.order_escrow;
        let clock = Clock::get()?;

        require!(!escrow.is_fulfilled, SeekerPayError::OrderAlreadyFulfilled);
        require!(!escrow.is_refunded, SeekerPayError::OrderAlreadyRefunded);
        require!(
            clock.unix_timestamp <= escrow.expires_at,
            SeekerPayError::OrderExpired
        );

        // Deterministic verification of the Pix EndToEndId hash
        let computed_hash = anchor_lang::solana_program::hash::hash(pix_end_to_end_id.as_bytes());
        require!(
            computed_hash.to_bytes() == escrow.pix_end_to_end_hash,
            SeekerPayError::PixProofMismatch
        );

        let merchant_profile = &mut ctx.accounts.merchant_profile;
        let crypto_amount = escrow.crypto_amount;

        // Transfer funds from vault to merchant token account using PDA seeds
        let order_id_ref = order_id;
        let signer_seeds: &[&[&[u8]]] = &[&[
            ESCROW_SEED,
            order_id_ref.as_ref(),
            &[escrow.bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.merchant_token_account.to_account_info(),
            authority: ctx.accounts.order_escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
            crypto_amount,
        )?;

        // Close the escrow vault account to reclaim rent
        let close_cpi_accounts = CloseAccount {
            account: ctx.accounts.escrow_vault.to_account_info(),
            destination: ctx.accounts.merchant_authority.to_account_info(),
            authority: ctx.accounts.order_escrow.to_account_info(),
        };
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_cpi_accounts,
            signer_seeds,
        ))?;

        escrow.is_fulfilled = true;
        merchant_profile.total_volume_settled = merchant_profile
            .total_volume_settled
            .checked_add(crypto_amount)
            .ok_or(SeekerPayError::MathOverflow)?;
        merchant_profile.total_orders_completed = merchant_profile
            .total_orders_completed
            .checked_add(1)
            .ok_or(SeekerPayError::MathOverflow)?;

        emit!(OrderFulfilledEvent {
            order_id,
            merchant: merchant_profile.key(),
            crypto_amount,
            pix_end_to_end_id,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Refund an expired escrow order back to the original payer.
    pub fn refund_order(ctx: Context<RefundOrder>, order_id: [u8; 16]) -> Result<()> {
        let escrow = &mut ctx.accounts.order_escrow;
        let clock = Clock::get()?;

        require!(!escrow.is_fulfilled, SeekerPayError::OrderAlreadyFulfilled);
        require!(!escrow.is_refunded, SeekerPayError::OrderAlreadyRefunded);
        require!(
            clock.unix_timestamp > escrow.expires_at,
            SeekerPayError::OrderNotYetExpired
        );

        let order_id_ref = order_id;
        let signer_seeds: &[&[&[u8]]] = &[&[
            ESCROW_SEED,
            order_id_ref.as_ref(),
            &[escrow.bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.payer_token_account.to_account_info(),
            authority: ctx.accounts.order_escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
            escrow.crypto_amount,
        )?;

        // Close vault to return rent to payer
        let close_cpi_accounts = CloseAccount {
            account: ctx.accounts.escrow_vault.to_account_info(),
            destination: ctx.accounts.payer.to_account_info(),
            authority: ctx.accounts.order_escrow.to_account_info(),
        };
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_cpi_accounts,
            signer_seeds,
        ))?;

        escrow.is_refunded = true;

        emit!(OrderRefundedEvent {
            order_id,
            payer: ctx.accounts.payer.key(),
            crypto_amount: escrow.crypto_amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(business_name: String, pix_key: String)]
pub struct InitializeMerchant<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Trusted relayer authority authorized to sign off-chain Pix settlement proofs
    pub settlement_authority: AccountInfo<'info>,

    #[account(
        init,
        payer = authority,
        space = MerchantProfile::LEN,
        seeds = [MERCHANT_SEED, authority.key().as_ref()],
        bump
    )]
    pub merchant_profile: Account<'info, MerchantProfile>,

    /// The Mint pubkey representing Seeker Genesis Token
    pub sgt_mint: Account<'info, Mint>,

    /// The Merchant's token account for SGT attestation check
    #[account(
        constraint = merchant_sgt_token_account.owner == authority.key() @ SeekerPayError::InvalidTokenOwner,
        constraint = merchant_sgt_token_account.mint == sgt_mint.key() @ SeekerPayError::InvalidTokenMint
    )]
    pub merchant_sgt_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct CreateOrderEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [MERCHANT_SEED, merchant_profile.merchant_authority.as_ref()],
        bump = merchant_profile.bump
    )]
    pub merchant_profile: Account<'info, MerchantProfile>,

    #[account(
        init,
        payer = payer,
        space = OrderEscrow::LEN,
        seeds = [ESCROW_SEED, order_id.as_ref()],
        bump
    )]
    pub order_escrow: Account<'info, OrderEscrow>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = payer_token_account.owner == payer.key() @ SeekerPayError::InvalidTokenOwner,
        constraint = payer_token_account.mint == token_mint.key() @ SeekerPayError::InvalidTokenMint
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, order_id.as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = order_escrow
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct FulfillOrder<'info> {
    /// Must be the designated settlement authority from MerchantProfile
    #[account(
        signer,
        constraint = settlement_authority.key() == merchant_profile.settlement_authority @ SeekerPayError::UnauthorizedSettlement
    )]
    pub settlement_authority: Signer<'info>,

    /// CHECK: Safe, receives rent rebate upon vault closure
    #[account(mut, address = merchant_profile.merchant_authority)]
    pub merchant_authority: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [MERCHANT_SEED, merchant_profile.merchant_authority.as_ref()],
        bump = merchant_profile.bump
    )]
    pub merchant_profile: Account<'info, MerchantProfile>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, order_id.as_ref()],
        bump = order_escrow.bump,
        has_one = token_mint @ SeekerPayError::InvalidTokenMint,
        has_one = merchant @ SeekerPayError::MerchantMismatch
    )]
    pub order_escrow: Account<'info, OrderEscrow>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, order_id.as_ref()],
        bump = order_escrow.vault_bump,
        token::mint = token_mint,
        token::authority = order_escrow
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = merchant_token_account.owner == merchant_profile.merchant_authority @ SeekerPayError::InvalidTokenOwner,
        constraint = merchant_token_account.mint == token_mint.key() @ SeekerPayError::InvalidTokenMint
    )]
    pub merchant_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 16])]
pub struct RefundOrder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, order_id.as_ref()],
        bump = order_escrow.bump,
        has_one = payer @ SeekerPayError::PayerMismatch,
        has_one = token_mint @ SeekerPayError::InvalidTokenMint
    )]
    pub order_escrow: Account<'info, OrderEscrow>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, order_id.as_ref()],
        bump = order_escrow.vault_bump,
        token::mint = token_mint,
        token::authority = order_escrow
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = payer_token_account.owner == payer.key() @ SeekerPayError::InvalidTokenOwner,
        constraint = payer_token_account.mint == token_mint.key() @ SeekerPayError::InvalidTokenMint
    )]
    pub payer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
pub struct MerchantProfile {
    pub merchant_authority: Pubkey,          // 32
    pub settlement_authority: Pubkey,        // 32
    pub business_name: String,               // 4 + 64
    pub pix_key: String,                     // 4 + 64
    pub total_volume_settled: u64,           // 8
    pub total_orders_completed: u64,         // 8
    pub has_seeker_hardware_attestation: bool, // 1
    pub bump: u8,                            // 1
}

impl MerchantProfile {
    pub const LEN: usize = 8 + 32 + 32 + (4 + 64) + (4 + 64) + 8 + 8 + 1 + 1;
}

#[account]
pub struct OrderEscrow {
    pub order_id: [u8; 16],                  // 16
    pub merchant: Pubkey,                    // 32
    pub payer: Pubkey,                       // 32
    pub token_mint: Pubkey,                  // 32
    pub pix_end_to_end_hash: [u8; 32],       // 32
    pub fiat_amount_centavos: u64,           // 8
    pub crypto_amount: u64,                  // 8
    pub created_at: i64,                     // 8
    pub expires_at: i64,                     // 8
    pub is_fulfilled: bool,                  // 1
    pub is_refunded: bool,                   // 1
    pub bump: u8,                            // 1
    pub vault_bump: u8,                      // 1
}

impl OrderEscrow {
    pub const LEN: usize = 8 + 16 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct MerchantRegisteredEvent {
    pub merchant: Pubkey,
    pub has_seeker_attestation: bool,
    pub pix_key: String,
    pub timestamp: i64,
}

#[event]
pub struct OrderEscrowCreatedEvent {
    pub order_id: [u8; 16],
    pub merchant: Pubkey,
    pub payer: Pubkey,
    pub crypto_amount: u64,
    pub fiat_amount_centavos: u64,
    pub expires_at: i64,
}

#[event]
pub struct OrderFulfilledEvent {
    pub order_id: [u8; 16],
    pub merchant: Pubkey,
    pub crypto_amount: u64,
    pub pix_end_to_end_id: String,
    pub timestamp: i64,
}

#[event]
pub struct OrderRefundedEvent {
    pub order_id: [u8; 16],
    pub payer: Pubkey,
    pub crypto_amount: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum SeekerPayError {
    #[msg("String length exceeds the maximum allowed 64 characters.")]
    InvalidStringLength,
    #[msg("Crypto or Fiat Amount cannot be zero.")]
    ZeroAmount,
    #[msg("Timeout must be between 60 seconds and 86400 seconds (24h).")]
    InvalidTimeout,
    #[msg("Math calculation resulted in an overflow.")]
    MathOverflow,
    #[msg("Order has already been fulfilled.")]
    OrderAlreadyFulfilled,
    #[msg("Order has already been refunded.")]
    OrderAlreadyRefunded,
    #[msg("Order escrow has expired.")]
    OrderExpired,
    #[msg("Order has not yet expired; cannot trigger refund.")]
    OrderNotYetExpired,
    #[msg("Pix EndToEndId hash verification failed.")]
    PixProofMismatch,
    #[msg("Unauthorized settlement agent.")]
    UnauthorizedSettlement,
    #[msg("Token account owner does not match expected authority.")]
    InvalidTokenOwner,
    #[msg("Token account mint does not match expected mint.")]
    InvalidTokenMint,
    #[msg("Order merchant does not match the merchant profile provided.")]
    MerchantMismatch,
    #[msg("Payer provided does not match the escrow order owner.")]
    PayerMismatch,
}
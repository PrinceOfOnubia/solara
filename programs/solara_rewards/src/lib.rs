use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, TransferChecked};

declare_id!("Fg6PaFpoGXkYsidMpWxTWqgYH52vYL6JCNTR6CqxwEkX");

const CONFIG_SEED: &[u8] = b"config";
const VALIDATOR_SEED: &[u8] = b"validator";
const TIER_COUNT: usize = 3;

#[program]
pub mod solara_rewards {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, tier_rates: [u64; TIER_COUNT]) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(ctx.accounts.reward_vault.mint, ctx.accounts.mint.key(), SolaraError::InvalidRewardVault);
        require_keys_eq!(ctx.accounts.reward_vault.owner, config.key(), SolaraError::InvalidRewardVault);
        for rate in tier_rates {
            require!(rate > 0, SolaraError::InvalidTierRate);
        }

        config.admin = ctx.accounts.admin.key();
        config.mint = ctx.accounts.mint.key();
        config.reward_vault = ctx.accounts.reward_vault.key();
        config.paused = false;
        config.tier_rates = tier_rates;
        config.active_validators = 0;
        config.active_reward_rate_units_per_minute = 0;
        config.total_earned = 0;
        config.total_claims = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn start_validating(ctx: Context<StartValidating>, gpu_tier: u8) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.paused, SolaraError::Paused);
        let rate = tier_rate(config, gpu_tier)?;
        let clock = Clock::get()?;
        let validator = &mut ctx.accounts.validator;

        if validator.active {
            require_eq!(validator.gpu_tier, gpu_tier, SolaraError::ClaimBeforeChangingTier);
            return Ok(());
        }

        validator.user = ctx.accounts.user.key();
        validator.gpu_tier = gpu_tier;
        validator.active = true;
        validator.started_at = clock.unix_timestamp;
        validator.last_claim_at = clock.unix_timestamp;
        validator.reward_rate_units_per_minute = rate;
        validator.bump = ctx.bumps.validator;

        config.active_validators = config.active_validators.checked_add(1).ok_or(SolaraError::MathOverflow)?;
        config.active_reward_rate_units_per_minute = config
            .active_reward_rate_units_per_minute
            .checked_add(rate)
            .ok_or(SolaraError::MathOverflow)?;
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.paused, SolaraError::Paused);
        require_keys_eq!(config.mint, ctx.accounts.mint.key(), SolaraError::InvalidMint);
        require_keys_eq!(config.reward_vault, ctx.accounts.reward_vault.key(), SolaraError::InvalidRewardVault);
        require_keys_eq!(ctx.accounts.reward_vault.mint, ctx.accounts.mint.key(), SolaraError::InvalidRewardVault);
        require_keys_eq!(ctx.accounts.reward_vault.owner, config.key(), SolaraError::InvalidRewardVault);

        let clock = Clock::get()?;
        let validator = &mut ctx.accounts.validator;
        require!(validator.active, SolaraError::InactiveValidator);
        let reward = pending_reward(validator, clock.unix_timestamp)?;
        require!(reward > 0, SolaraError::NothingToClaim);
        require!(ctx.accounts.reward_vault.amount >= reward, SolaraError::InsufficientVaultBalance);

        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &[config.bump]];
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.reward_vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: config.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, &[signer_seeds]),
            reward,
            ctx.accounts.mint.decimals,
        )?;

        validator.last_claim_at = clock.unix_timestamp;
        validator.total_claimed = validator.total_claimed.checked_add(reward).ok_or(SolaraError::MathOverflow)?;
        config.total_earned = config.total_earned.checked_add(reward).ok_or(SolaraError::MathOverflow)?;
        config.total_claims = config.total_claims.checked_add(1).ok_or(SolaraError::MathOverflow)?;
        Ok(())
    }

    pub fn pause(ctx: Context<AdminControl>) -> Result<()> {
        ctx.accounts.config.assert_admin(&ctx.accounts.admin)?;
        ctx.accounts.config.paused = true;
        Ok(())
    }

    pub fn resume(ctx: Context<AdminControl>) -> Result<()> {
        ctx.accounts.config.assert_admin(&ctx.accounts.admin)?;
        ctx.accounts.config.paused = false;
        Ok(())
    }

    pub fn update_tier_rate(ctx: Context<AdminControl>, gpu_tier: u8, units_per_minute: u64) -> Result<()> {
        ctx.accounts.config.assert_admin(&ctx.accounts.admin)?;
        require!(units_per_minute > 0, SolaraError::InvalidTierRate);
        let idx = usize::from(gpu_tier);
        require!(idx < TIER_COUNT, SolaraError::InvalidTier);
        ctx.accounts.config.tier_rates[idx] = units_per_minute;
        Ok(())
    }

    pub fn admin_withdraw(ctx: Context<AdminWithdraw>, amount: u64) -> Result<()> {
        validate_admin_withdraw(
            &ctx.accounts.config,
            ctx.accounts.config.key(),
            ctx.accounts.admin.key(),
            ctx.accounts.reward_vault.key(),
            ctx.accounts.reward_vault.owner,
            ctx.accounts.reward_vault.mint,
            ctx.accounts.admin_destination_token_account.mint,
            ctx.accounts.reward_vault.amount,
            amount,
        )?;

        let signer_seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.reward_vault.to_account_info(),
            to: ctx.accounts.admin_destination_token_account.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, &[signer_seeds]),
            amount,
        )?;
        Ok(())
    }
}

fn validate_admin_withdraw(
    config: &Config,
    config_key: Pubkey,
    admin: Pubkey,
    reward_vault: Pubkey,
    reward_vault_owner: Pubkey,
    reward_vault_mint: Pubkey,
    destination_mint: Pubkey,
    vault_amount: u64,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, SolaraError::InvalidWithdrawAmount);
    require_keys_eq!(config.admin, admin, SolaraError::Unauthorized);
    require_keys_eq!(config.reward_vault, reward_vault, SolaraError::InvalidRewardVault);
    require_keys_eq!(reward_vault_owner, config_key, SolaraError::InvalidRewardVault);
    require_keys_eq!(reward_vault_mint, destination_mint, SolaraError::InvalidWithdrawDestination);
    require!(vault_amount >= amount, SolaraError::InsufficientVaultBalance);
    Ok(())
}

fn tier_rate(config: &Config, gpu_tier: u8) -> Result<u64> {
    let idx = usize::from(gpu_tier);
    require!(idx < TIER_COUNT, SolaraError::InvalidTier);
    let rate = config.tier_rates[idx];
    require!(rate > 0, SolaraError::InvalidTierRate);
    Ok(rate)
}

fn pending_reward(validator: &UserValidator, now: i64) -> Result<u64> {
    let elapsed = now.checked_sub(validator.last_claim_at).ok_or(SolaraError::MathOverflow)?;
    require!(elapsed >= 0, SolaraError::InvalidClock);
    let elapsed_u64 = u64::try_from(elapsed).map_err(|_| SolaraError::MathOverflow)?;
    validator
        .reward_rate_units_per_minute
        .checked_mul(elapsed_u64)
        .ok_or(SolaraError::MathOverflow)?
        .checked_div(60)
        .ok_or(SolaraError::MathOverflow)
        .map_err(Into::into)
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(init, payer = admin, space = Config::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: Account<'info, Mint>,
    pub reward_vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartValidating<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = user,
        space = UserValidator::SPACE,
        seeds = [VALIDATOR_SEED, user.key().as_ref()],
        bump
    )]
    pub validator: Account<'info, UserValidator>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [VALIDATOR_SEED, user.key().as_ref()], bump = validator.bump, has_one = user)]
    pub validator: Account<'info, UserValidator>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub reward_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminControl<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminWithdraw<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub reward_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub admin_destination_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub reward_vault: Pubkey,
    pub paused: bool,
    pub tier_rates: [u64; TIER_COUNT],
    pub active_validators: u64,
    pub active_reward_rate_units_per_minute: u64,
    pub total_earned: u64,
    pub total_claims: u64,
    pub bump: u8,
}

impl Config {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1 + (8 * TIER_COUNT) + 8 + 8 + 8 + 8 + 1;

    pub fn assert_admin(&self, admin: &Signer) -> Result<()> {
        require_keys_eq!(self.admin, admin.key(), SolaraError::Unauthorized);
        Ok(())
    }
}

#[account]
pub struct UserValidator {
    pub user: Pubkey,
    pub gpu_tier: u8,
    pub active: bool,
    pub started_at: i64,
    pub last_claim_at: i64,
    pub reward_rate_units_per_minute: u64,
    pub total_claimed: u64,
    pub bump: u8,
}

impl UserValidator {
    pub const SPACE: usize = 8 + 32 + 1 + 1 + 8 + 8 + 8 + 8 + 1;
}

#[error_code]
pub enum SolaraError {
    #[msg("Only the configured admin can perform this action.")]
    Unauthorized,
    #[msg("Rewards are paused.")]
    Paused,
    #[msg("Invalid GPU tier.")]
    InvalidTier,
    #[msg("Invalid tier reward rate.")]
    InvalidTierRate,
    #[msg("Checked math overflow.")]
    MathOverflow,
    #[msg("Validator is inactive.")]
    InactiveValidator,
    #[msg("No rewards are available to claim yet.")]
    NothingToClaim,
    #[msg("Reward vault balance is insufficient.")]
    InsufficientVaultBalance,
    #[msg("Invalid reward vault.")]
    InvalidRewardVault,
    #[msg("Invalid mint.")]
    InvalidMint,
    #[msg("Clock moved backwards.")]
    InvalidClock,
    #[msg("Claim pending rewards before changing GPU tier.")]
    ClaimBeforeChangingTier,
    #[msg("Withdraw amount must be greater than zero.")]
    InvalidWithdrawAmount,
    #[msg("Withdraw destination token account has the wrong mint.")]
    InvalidWithdrawDestination,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    fn config(admin: Pubkey, reward_vault: Pubkey) -> Config {
        Config {
            admin,
            mint: pk(9),
            reward_vault,
            paused: true,
            tier_rates: [5_000_000_000, 7_000_000_000, 10_000_000_000],
            active_validators: 0,
            active_reward_rate_units_per_minute: 0,
            total_earned: 0,
            total_claims: 0,
            bump: 255,
        }
    }

    #[test]
    fn admin_can_withdraw_even_when_paused() {
        let admin = pk(1);
        let vault = pk(2);
        let config_key = pk(4);
        let cfg = config(admin, vault);
        assert!(validate_admin_withdraw(&cfg, config_key, admin, vault, config_key, pk(9), pk(9), 100, 50).is_ok());
    }

    #[test]
    fn non_admin_cannot_withdraw() {
        let admin = pk(1);
        let vault = pk(2);
        let config_key = pk(4);
        let cfg = config(admin, vault);
        assert!(validate_admin_withdraw(&cfg, config_key, pk(3), vault, config_key, pk(9), pk(9), 100, 50).is_err());
    }

    #[test]
    fn wrong_destination_mint_fails() {
        let admin = pk(1);
        let vault = pk(2);
        let config_key = pk(4);
        let cfg = config(admin, vault);
        assert!(validate_admin_withdraw(&cfg, config_key, admin, vault, config_key, pk(9), pk(8), 100, 50).is_err());
    }

    #[test]
    fn insufficient_vault_balance_fails() {
        let admin = pk(1);
        let vault = pk(2);
        let config_key = pk(4);
        let cfg = config(admin, vault);
        assert!(validate_admin_withdraw(&cfg, config_key, admin, vault, config_key, pk(9), pk(9), 49, 50).is_err());
    }
}

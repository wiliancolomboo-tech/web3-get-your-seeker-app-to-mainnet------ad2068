# 1. Build optimized on-chain binary using Solana Docker Toolchain
anchor build --verifiable

# 2. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.mainnet-beta.solana.com
solana airdrop 2 || true # If deploying on Devnet
anchor deploy --program-name seeker_pay_br --provider.cluster mainnet

# 3. Initialize Anchor program IDL
anchor idl init --filepath target/idl/seeker_pay_br.json PayBR11111111111111111111111111111111111111
# Ensure Rust, Solana CLI v1.18+, and Anchor CLI v0.30+ are installed
solana config set --url https://api.mainnet-beta.solana.com
solana-keygen new --outfile deployer-keypair.json --no-bip39-passphrase

# Build the binary
anchor build

# Get generated Program ID
solana address -k target/deploy/seeker_pay_br-keypair.json

# Deploy to Solana
solana program deploy \
  --program-id target/deploy/seeker_pay_br-keypair.json \
  target/deploy/seeker_pay_br.so \
  --keypair deployer-keypair.json
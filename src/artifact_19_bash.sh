# 1. Install Solana CLI & Anchor 0.30.1
sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"
cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked

# 2. Configure Solana to Mainnet-Beta
solana config set --url https://api.mainnet-beta.solana.com
solana-keygen new -o deployer-keypair.json

# 3. Fund deployer wallet (~2.5 SOL needed for Program storage)
solana balance deployer-keypair.json

# 4. Build program with verifiable build
anchor build --verifiable

# 5. Deploy program to Solana Mainnet
solana program deploy \
  --program-id target/deploy/pixflow_seeker-keypair.json \
  target/deploy/pixflow_seeker.so \
  --keypair deployer-keypair.json \
  --commitment finalized

# 6. Launch turnkey enterprise monitoring service
docker compose up -d --build
docker compose logs -f
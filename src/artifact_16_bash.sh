# Configure Mainnet-Beta RPC
solana config set --url https://api.mainnet-beta.solana.com

# Verify deployer keypair balance (min 3.5 SOL recommended for rent & deployment)
solana balance

# Build the program deterministically
anchor build --verifiable

# Retrieve Program ID
solana address -k target/deploy/seekerpay_br-keypair.json
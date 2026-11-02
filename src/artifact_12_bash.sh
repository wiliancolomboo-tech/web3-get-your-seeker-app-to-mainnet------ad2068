# 1. Ensure Solana CLI is configured to Mainnet-Beta or Devnet
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/.config/solana/mainnet-deployer.json

# 2. Build the optimized BPF bytecode
anchor build

# 3. Synchronize programmatic ID with declared ID
anchor keys sync

# 4. Deploy the program with a permanent buffer
anchor deploy --program-name seeker_pay --provider.cluster mainnet
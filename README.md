# TokenDrop

A smart contract for asset owners to send tokens for distribution to arbitrary recipients, with optional gating restrictions on receivers.

## Overview

TokenDrop is an Algorand smart contract that enables token owners to create "drops" - distributions of tokens that can be claimed by users. The contract supports various gating mechanisms to restrict who can claim tokens, such as requiring ownership of specific assets or NFDs (Non-Fungible Domains).

Key features:
- Create token drops with configurable amounts per claim
- Set expiration times for drops
- Apply various gating restrictions on who can claim tokens
- Efficiently manage minimum balance requirements
- Support for cancellation and cleanup of expired drops

## Prerequisites

- Node.js (version specified in `.nvmrc`)
- PNPM package manager
- Algorand development environment (for testing)

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/txnlab/tokendrop.git
   cd tokendrop
   ```

2. Install dependencies:
   ```
   pnpm install
   ```

## Building the Contracts

To compile the TEALScript contracts and generate TypeScript clients:

```
pnpm run build
```

This will:
1. Compile the TEALScript contracts to TEAL code
2. Generate TypeScript client code for interacting with the contracts

If you want to compile without connecting to an Algorand node:

```
pnpm run noalgobuild
```

## Testing

To run the tests (including building the contract), first ensure a localnet instance is running:

```
algokit localnet start
```

```
pnpm run test
```


This will build the contracts and run the test suite using Vitest.

If you've already built the contracts and just want to run the tests:

```
pnpm run retest
```

## Usage

### Creating a Token Drop

```typescript
import { TokenDropClient } from './contracts/clients/TokenDropClient';
import { createTokenDropConfig, GATING_TYPE_NONE } from './helpers';

// Initialize the client
const client = new TokenDropClient({
  sender: creatorAccount,
  resolveBy: 'id',
  id: appId,
});

// Create a token drop configuration
const dropConfig = createTokenDropConfig({
  token: assetId,
  amountPerClaim: 1000n, // Amount per claim
  airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60), // 7 days from now
  entryGatingType: GATING_TYPE_NONE, // No gating restrictions
});

// Create the drop
const dropId = await createDrop(client, creatorAccount.addr, dropConfig, 10000n); // 10 claims of 1000 tokens each
```

### Claiming Tokens

```typescript
// Claim tokens from a drop
await claimDrop(client, claimerAccount.addr, dropId);
```

### Canceling a Drop

```typescript
// Cancel a drop (only the creator can do this)
await client.send.cancelDrop({
  sender: creatorAccount,
  args: { tokenDropId: dropId },
});
```

## Gating Types

The contract supports various gating mechanisms to restrict who can claim tokens:

- `GATING_TYPE_NONE`: No restrictions
- `GATING_TYPE_ASSETS_CREATED_BY`: Require ownership of assets created by a specific address
- `GATING_TYPE_ASSET_ID`: Require ownership of specific assets
- `GATING_TYPE_CREATED_BY_NFD_ADDRESSES`: Require ownership of assets created by addresses linked to an NFD
- `GATING_TYPE_SEGMENT_OF_NFD`: Require ownership of a segment of a specific NFD
- `GATING_TYPE_NFD_W_VERIFIED_TWITTER`: Require ownership of an NFD with verified Twitter
- `GATING_TYPE_NFD_W_VERIFIED_BLUESKY`: Require ownership of an NFD with verified Bluesky
- `GATING_TYPE_NFD_HOLDING_AGE`: Require ownership of an NFD for a minimum period

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

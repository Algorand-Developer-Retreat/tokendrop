/*
 * Copyright (c) 2025. TxnLab Inc.
 * All Rights reserved.
 */

export const GATING_TYPE_NONE = 0
export const GATING_TYPE_ASSETS_CREATED_BY = 1
export const GATING_TYPE_ASSET_ID = 2
export const GATING_TYPE_CREATED_BY_NFD_ADDRESSES = 3
export const GATING_TYPE_SEGMENT_OF_NFD = 4
export const GATING_TYPE_NFD_W_VERIFIED_TWITTER = 5
export const GATING_TYPE_NFD_W_VERIFIED_BLUESKY = 6
export const GATING_TYPE_NFD_HOLDING_AGE = 7
// This constant needs to always be set to the highest value of the constants
export const GATING_TYPE_CONST_MAX = 7

export type TokenDropId = uint64

/**
 * Represents the configuration for a token drop event with optional gating mechanisms.
 * This configuration contains the details for distributing tokens to eligible participants
 * along with optional constraints for eligibility.
 *
 * @property {AssetID} Token - The unique identifier of the token being airdropped.
 * @property {uint64} AmountPerClaim - The number of tokens each participant can claim.
 * @property {uint64} AirdropEndTime - The timestamp when the airdrop ends.
 * @property {uint8} entryGatingType - Specifies the gating mechanism type for eligibility.
 *   1. GATING_TYPE_ASSETS_CREATED_BY: Eligibility based on assets created by a specific address.
 *   2. GATING_TYPE_ASSET_ID: Eligibility based on possession of a specific asset ID.
 *   3. GATING_TYPE_CREATED_BY_NFD_ADDRESSES: Eligibility based on assets in an NFD-linked address.
 *   4. GATING_TYPE_SEGMENT_OF_NFD: Eligibility based on a segment of a specific NFD.
 * @property {Address} entryGatingAddress - Address used for gating type GATING_TYPE_ASSETS_CREATED_BY.
 * @property {StaticArray<uint64, 4>} entryGatingAssets - Array of asset IDs for eligibility checks.
 *   - Checked for GATING_TYPE_ASSET_ID.
 *   - Only the first asset is used for GATING_TYPE_CREATED_BY_NFD_ADDRESSES or GATING_TYPE_SEGMENT_OF_NFD.
 * @property {uint64} gatingAssetMinBalance - Minimum balance (in base units) of a specified gating asset required for eligibility.
 *   - If set to 0, participants need to hold at least 1 unit of the gating asset,
 *     typically used for token-based gating.
 */
export type TokenDropConfig = {
    Token: AssetID
    AmountPerClaim: uint64
    AirdropEndTime: uint64

    // ====
    // Gating requirements
    // entryGatingType / entryGatingValue specifies an optional gating mechanism - whose criteria
    // the staker must meet.
    // It will be the responsibility of the staker (txn composer really) to pick the right thing to check (as argument
    // to adding stake) that meets the criteria if this is set.
    // Allowed types:
    // 1) GATING_TYPE_ASSETS_CREATED_BY: assets created by address X (val is address of creator)
    // 2) GATING_TYPE_ASSET_ID: specific asset id (val is asset id)
    // 3) GATING_TYPE_CREATED_BY_NFD_ADDRESSES: asset in nfd linked addresses (value is nfd appid)
    // 4) GATING_TYPE_SEGMENT_OF_NFD: segment of a particular NFD (value is root appid)
    entryGatingType: uint8
    entryGatingAddress: Address // for GATING_TYPE_ASSETS_CREATED_BY
    entryGatingAssets: StaticArray<uint64, 4> // all checked for GATING_TYPE_ASSET_ID, only first used for GATING_TYPE_CREATED_BY_NFD_ADDRESSES, and GATING_TYPE_SEGMENT_OF_NFD

    // [CHANGEABLE] gatingAssetMinBalance specifies a minimum token base units amount needed of an asset owned by the specified
    // creator (if defined).  If 0, then they need to hold at lest 1 unit, but its assumed this is for tokens, ie: hold
    // 10000[.000000] of token
    // If GATING_TYPE_NFD_HOLDING_AGE is set, then this is the number of days the claimer must have owned and held
    // the nfd.  Transfers clear this!
    gatingAssetMinBalance: uint64
}

/**
 * Represents the information about a Token Drop, stored in box storage by token id.
 * A Token Drop is an airdrop where a given airdrop creator wants to distribute some amount of tokens to an arbitrary number of users
 * possibly with requirements for each staker like having to own specific assets, having an NFD segment, etc.
 */
export type TokenDropInfo = {
    DropId: TokenDropId
    DropCreator: Address // Can't claim individually, but can claim remaining funds if expired
    AmountRemaining: uint64
    MaxClaims: uint64 // Calc'd number based on amount put into drop / AmountPerClaim
    NumClaims: uint64 // number of claims distributed

    Config: TokenDropConfig
}

export type AddressClaimKey = {
    // we want token drop id first so we can do box fetches by prefix - getting all claims per drop
    TokenDropId: uint64
    Address: Address
}

export type ClaimedInfo = {
    TxnId: bytes32
}

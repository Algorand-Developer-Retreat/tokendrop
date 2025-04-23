/*
 * Copyright (c) 2025. TxnLab Inc.
 * All Rights reserved.
 */

import { Contract } from '@algorandfoundation/tealscript'
import {
    AddressClaimKey,
    ClaimedInfo,
    GATING_TYPE_ASSET_ID,
    GATING_TYPE_ASSETS_CREATED_BY,
    GATING_TYPE_CONST_MAX,
    GATING_TYPE_CREATED_BY_NFD_ADDRESSES,
    GATING_TYPE_NONE,
    GATING_TYPE_SEGMENT_OF_NFD,
    GATING_TYPE_NFD_W_VERIFIED_TWITTER,
    GATING_TYPE_NFD_W_VERIFIED_BLUESKY,
    GATING_TYPE_NFD_HOLDING_AGE,
    TokenDropConfig,
    TokenDropId,
    TokenDropInfo,
} from './types.algo'

/**
 * TokenDrop is a class that represents a token drop mechanism built on a smart contract.
 * It manages the lifecycle of token drops, including their creation, claiming, and validation
 * against certain gating rules and limitations.
 *
 * This class supports multiple drops, dynamic states, and enforces specific rules such as
 * token opt-in requirements, balance validations, and claim restrictions.
 */
export class TokenDrop extends Contract {
    programVersion = 11

    // placeholder for global state so we have some breathing room for future global state we might want
    placeholder = GlobalStateMap<bytes, bytes>({ maxKeys: 4, allowPotentialCollisions: true, prefix: 'neverused' })

    /**
     * We need the registry app id of NFD so we can perform NFD related gating checks
     */
    nfdRegistryAppId = GlobalStateKey<AppID>({ key: 'nfdRegistryId' })

    // Address where half of the drop creation fees are sent, with other half going to the fee sink
    maintainerAddress = GlobalStateKey<Address>({ key: 'maintainerAddress' })

    // The fee in microAlgo required to create a new drop.  Half goes to the maintainer, the other half goes to the fee
    // sink.  Defaults to 10 ALGO but is changeable by the contract deployer (owner)
    creationFeeAmount = GlobalStateKey<uint64>({ key: 'creationFeeAmount' })

    // The fee in microAlgo paid by each token claim - all goes to maintainer.
    perClaimFeeAmount = GlobalStateKey<uint64>({ key: 'perClaimFeeAmount' })

    // The total number of lifetime claims
    totalClaims = GlobalStateKey<uint64>({ key: 'totalClaims' })

    /**
     * Represents a global state key used to manage the identifier for the next token drop.
     *
     * The `lastDropId` variable is intended to act as a unique identifier generator
     * for token drops within the application.
     */
    lastDropId = GlobalStateKey<TokenDropId>({ key: 'lastDropId' })

    /**
     * A map that stores information about all unexpired token drops
     */
    allDrops = BoxMap<TokenDropId, TokenDropInfo>({ prefix: 'd' })

    /**
     * Stores the active token drop for a specific asset
     * It can still have a drop that's expired - can be replaced with 'new' drop.
     */
    dropForToken = BoxMap<AssetID, TokenDropId>({ prefix: 'tok' })

    /**
     * A map structure to store claimed information so we can know if an address has already claimed a particular
     * drop.  Drop creator pays ALL MBR costs for this for all possible claimers, upfront.
     * What wasn't used (MaxClaims-NumClaims) at end is refunded when drop is cleaned up but prior to that
     * drop creator can get refunds per claimaint by asking for their mbr back individually by calling
     * claimClaimerBoxCost
     *
     * The key is {token drop id, address} so a prefix fetch can be done on boxes, getting all
     * addresses that claimed a drop.
     */
    claimedMap = BoxMap<AddressClaimKey, ClaimedInfo>({ prefix: 'c' })

    createApplication(nfdRegistryId: AppID, maintainerAddress: Address): void {
        this.nfdRegistryAppId.value = nfdRegistryId
        this.maintainerAddress.value = maintainerAddress
        this.totalClaims.value = 0
        this.lastDropId.value = 0
        this.creationFeeAmount.value = 10_000_000 // 10 ALGO fee
        this.perClaimFeeAmount.value = 100_000 // .1 (should equal .05 to maintainer, minus mbr, rest goes to fee sink)
    }

    // Make the application updatable initially.  Hopefully locked down later
    updateApplication(): void {
        assert(this.txn.sender === this.app.creator, 'Only the creator can update the application')
    }

    /**
     * Updates the maintainer address of the application.
     *
     * This method allows the creator of the application to set a new maintainer address for receiving half the creation
     * fees
     */
    changeMaintainer(newMaintainer: Address): void {
        assert(this.txn.sender === this.app.creator, 'Only the creator can call')
        this.maintainerAddress.value = newMaintainer
    }

    /**
     * Updates the creation fee amount required at drop creation (split between maintainer and fee sink)
     * This method can only be called by the creator of the application and the fee must be at least 2 ALGO
     * 1 ALGO to maintainer address, 1 to fee sink.
     * The per-claim fee has to be at least double the per-claim MBR.
     * At claim, 50% is sent to the maintainer address, the mbr is subtracted out, and remainder goes to fee sink
     */
    changeFees(creationFee: uint64, perClaimFee: uint64): void {
        assert(this.txn.sender === this.app.creator, 'Only the creator can call')
        assert(creationFee > 2_000_000, 'fee must be at least 2 algo')
        assert(creationFee % 2 === 0, 'fee must be even amount')
        assert(perClaimFee >= this.getPerClaimerMbrCost() * 2, 'per-claim fee must >= double mbr cost')
        this.creationFeeAmount.value = creationFee
        this.perClaimFeeAmount.value = perClaimFee
    }

    /**
     * Opts in the application to an asset if not already opted in.
     * Verifies the provided payment transaction for sufficient funding to cover
     * the minimum balance required for asset opt-in and relevant transaction fees (.102 algo)
     * Initiates an asset transfer transaction to complete the opt-in process.
     *
     * @param {PayTxn} mbrPayment - The payment transaction covering the minimum balance and fees.
     * @param {AssetID} assetId - The unique identifier of the asset to opt into.
     */
    optinAsset(mbrPayment: PayTxn, assetId: AssetID): void {
        verifyPayTxn(mbrPayment, {
            receiver: this.app.address,
            amount: globals.assetOptInMinBalance,
        })

        if (this.app.address.isOptedInToAsset(assetId)) {
            sendPayment({
                receiver: this.txn.sender,
                amount: globals.assetOptInMinBalance,
                note: 'optin refund',
            })
            return
        }
        // Opt ourselves in
        sendAssetTransfer({
            xferAsset: assetId,
            assetReceiver: this.app.address,
            assetAmount: 0,
        })
    }

    /**
     * Calculates the fees required and MBR costs required for box storage for creating a drop with a specified maximum
     * number of claimers.  This fee must be sent as a payment to the contract prior to the call to createDrop.
     * The actual fee (creationFeeAmount) is split between a maintainer account and the fee sink.  The fee is to help
     * prevent 'spam' drops or drops created solely to block drops for specific assets.
     *
     * @return {uint64} The total MBR required to cover the necessary up-front box storage costs.
     */
    @abi.readonly
    getDropCreateCost(): uint64 {
        let feeNeeded: uint64 = this.creationFeeAmount.value
        // now add the MBR costs...

        // need allDrops costs: BoxMap<TokenDropId, TokenDropInfo>({ prefix: 'd' })
        feeNeeded += this.costForBoxStorage(1 /* 'd' */ + len<TokenDropId>() + len<TokenDropInfo>())
        // then dropForToken costs: BoxMap<AssetID, TokenDropId>({ prefix: 'tok' })
        feeNeeded += this.costForBoxStorage(3 /* 'tok' */ + len<AssetID>() + len<TokenDropId>())
        return feeNeeded
    }

    /**
     * Returns the MBR box cost for a single claimer (claimable by anyone later)
     */
    @abi.readonly
    getPerClaimerMbrCost(): uint64 {
        // return claimedMap costs: BoxMap<AddressClaimKey, ClaimedInfo>({ prefix: 'c' })
        return this.costForBoxStorage(1 /* 'c' */ + len<AddressClaimKey>() + len<ClaimedInfo>())
    }

    /**
     * Returns the per-claim fee paid (not reclaimable)
     */
    @abi.readonly
    getPerClaimerFee(): uint64 {
        return this.perClaimFeeAmount.value
    }

    /**
     * Retrieves the TokenDropInfo struct for a specific (still active) token drop based on the provided token drop ID.
     *
     * @param {TokenDropId} tokenDropId - The unique identifier for the token drop.
     * @return {TokenDropInfo} An object containing details about the specified token drop.
     */
    @abi.readonly
    getDropInfo(tokenDropId: TokenDropId): TokenDropInfo {
        return this.allDrops(tokenDropId).value
    }

    /**
     * Creates a new token drop and registers it in the system.
     *
     * This method validates and processes a token drop, ensuring all required conditions
     * are met. It registers the token drop with an assigned unique DropId, updates the
     * relevant state variables, and ensures that the drop complies with gating rules
     * and limits.
     *
     * @param {PayTxn} feeAndMbrPayment - proceeding payment txn into contract account to cover extra mbr needed for box
     * storage as well as FUTURE box storage for all possible claims.  ie: 10K tokens, 1K each - 10 possible claims,
     * so the cost per claim - the drop creator has to pay that upfront as well.
     * @param {AssetTransferTxn} assetTxn - The asset transfer transaction that transfers tokens for this drop.
     * @param {TokenDropInfo} tokenDropConfig - The metadata related to the token drop, including drop creator, token details,
     *                                        amount per claim, airdrop end time, and related gating info.
     * @return {uint64} Returns the token drop id assigned for this drop.
     */
    createDrop(feeAndMbrPayment: PayTxn, assetTxn: AssetTransferTxn, tokenDropConfig: TokenDropConfig): uint64 {
        verifyAssetTransferTxn(assetTxn, { assetReceiver: this.app.address })
        assert(assetTxn.assetAmount > 0, 'must have a positive amount')
        // transfer into us won't work if we're not already opted in so... we're good.
        assert(assetTxn.xferAsset === tokenDropConfig.Token, 'asset sent must be same as asset specified for drops')
        assert(this.app.address.isOptedInToAsset(assetTxn.xferAsset), 'must opt-in contract first')

        assert(tokenDropConfig.Token === assetTxn.xferAsset, 'token must match asset being transferred')
        assert(
            tokenDropConfig.AmountPerClaim <= assetTxn.assetAmount,
            'amount per claim must be at least amount transferred',
        )
        assert(
            assetTxn.assetAmount % tokenDropConfig.AmountPerClaim === 0,
            'amount must be divisible by amount per claim',
        )
        assert(
            tokenDropConfig.AirdropEndTime > globals.latestTimestamp + 86400,
            'airdrop end time must be at least 1 day into the future',
        )
        // allow 1 hr of fluff - but ensure that airdrop doesn't last longer than 1 week from now
        assert(
            tokenDropConfig.AirdropEndTime <= globals.latestTimestamp + 3600 + 86400 * 7,
            "airdrop can't last more than 1 week",
        )

        if (this.dropForToken(tokenDropConfig.Token).exists) {
            const dropInfo = this.allDrops(this.dropForToken(tokenDropConfig.Token).value).value
            assert(this.isDropExpiredOrEmpty(dropInfo), 'existing drop must be expired or have no remaining tokens')
            // purge/refund the prior drop that is now expired and needs cleaned.
            this.cleanupDrop(this.dropForToken(tokenDropConfig.Token).value)
        }
        this.checkGatingInfo(tokenDropConfig)

        // Actually allocate the new drop and set into the various tracking members
        this.lastDropId.value += 1
        const tokenDropId = this.lastDropId.value

        // set the drop data with new id and amount user sent us
        const dropInfo: TokenDropInfo = {
            DropId: tokenDropId,
            DropCreator: assetTxn.sender,
            AmountRemaining: assetTxn.assetAmount,
            MaxClaims: assetTxn.assetAmount / tokenDropConfig.AmountPerClaim,
            NumClaims: 0,
            Config: tokenDropConfig,
        }

        // add to tracking boxes...
        this.addNewDrop(tokenDropId, dropInfo)

        verifyPayTxn(feeAndMbrPayment, { receiver: this.app.address })
        const mbrCosts = this.getDropCreateCost()
        assert(feeAndMbrPayment.amount >= mbrCosts, 'must pay at least MBR costs')
        if (feeAndMbrPayment.amount > mbrCosts) {
            sendPayment({
                receiver: feeAndMbrPayment.sender,
                amount: feeAndMbrPayment.amount - mbrCosts,
                note: 'excess mbr refund',
            })
        }

        // Pay out half the fee to the maintainer, and the other half to the fee sink
        sendPayment({
            receiver: this.maintainerAddress.value,
            amount: this.creationFeeAmount.value / 2,
            note: 'TokenDrop fee',
        })
        sendPayment({
            receiver: blocks[this.txn.firstValid - 1].feeSink,
            amount: this.creationFeeAmount.value / 2,
            note: 'TokenDrop fee',
        })

        return tokenDropId
    }

    cancelDrop(tokenDropId: TokenDropId): void {
        const dropInfo = this.allDrops(tokenDropId).value
        assert(this.txn.sender === dropInfo.DropCreator, 'only drop creator can cancel a drop')
        this.cleanupDrop(tokenDropId)
    }

    /**
     * Processes a claim request for a specific token drop, ensuring compliance with all validation rules and conditions.
     *
     * @param {PayTxn} feeAndMbrPayment - The payment transaction object provided by the claimant to cover necessary fees.
     * @param {TokenDropId} tokenDropId - The unique identifier of the token drop being claimed.
     * @param {uint64} valueToVerify - An optional value used for claim gating verification.
     */
    claimDrop(feeAndMbrPayment: PayTxn, tokenDropId: TokenDropId, valueToVerify: uint64): void {
        const dropInfo = this.allDrops(tokenDropId).value
        assert(this.txn.sender !== dropInfo.DropCreator, 'drop creator cannot claim')
        // airdrop should still be in active list as well !
        assert(!this.isDropExpiredOrEmpty(dropInfo), 'airdrop has ended or out of tokens')
        assert(this.txn.sender.isOptedInToAsset(dropInfo.Config.Token), 'claimant must already be opted-in to token!')
        // have we already claimed?
        const claimKey = { TokenDropId: tokenDropId, Address: this.txn.sender } as AddressClaimKey
        assert(!this.claimedMap(claimKey).exists, 'already claimed')

        // If the drop creator specified various gating criteria, verify essentials
        this.doesClaimAccountMeetGating(tokenDropId, valueToVerify)

        // make sure the user pays the MBR for the new box as well as the per-claim fee
        // the per-claim fee has to already account for the mbr (at init time) but just to be sure
        const perClaimerFee = this.getPerClaimerFee()
        const mbrCost = this.getPerClaimerMbrCost()
        assert(perClaimerFee >= mbrCost * 2, 'per-claim fee too low')
        verifyPayTxn(feeAndMbrPayment, {
            receiver: this.app.address,
            sender: this.txn.sender,
            amount: perClaimerFee,
        })
        const maintainerPortion = (perClaimerFee * 500) / 1000 // scale number to then get 50% of the fee
        sendPayment({
            receiver: this.maintainerAddress.value,
            amount: maintainerPortion,
            note: 'TokenDrop fee',
        })
        // leave behind the mbr portion - rest goes to fee sink
        const feeSinkPortion = perClaimerFee - maintainerPortion - mbrCost
        sendPayment({
            receiver: blocks[this.txn.firstValid - 1].feeSink,
            amount: feeSinkPortion,
            note: 'TokenDrop fee',
        })

        // ----
        // Mark this account as having claimed this token
        this.claimedMap(claimKey).value = { TxnId: this.txn.txID as bytes32 }
        // we only increment the total claims when a USER claims (not on refunds!)
        this.totalClaims.value += 1
        // Send the user their tokens
        this.sendTokensFromDrop(dropInfo, this.txn.sender, dropInfo.Config.AmountPerClaim)
    }

    // If anyone wants, they can call this function for EVERY single address that claimed a drop
    // and reclaim the small amount of MBR that claimer had to pre-pay upfront.  So they'd call for every claimer, then
    // call cleanupDrop.  If a new drop is created before this is called (or cleanupDrop is called first) then
    // the mbr is lost.
    claimClaimerBoxCost(tokenDropId: TokenDropId, claimerAddress: Address, receiver: Address): void {
        const dropInfo = this.allDrops(tokenDropId).value
        assert(this.isDropExpiredOrEmpty(dropInfo), 'drop MUST be expired or empty!')

        const preMbr = this.app.address.minBalance
        const claimKey = { TokenDropId: tokenDropId, Address: claimerAddress } as AddressClaimKey
        this.claimedMap(claimKey).delete()
        const mbrRefund = preMbr - this.app.address.minBalance
        sendPayment({ receiver: receiver, amount: mbrRefund })
    }

    /**
     * Cleans up an expired token drop by performing necessary actions such as refunding remaining tokens
     * to the drop creator and removing the drop from the active drops.
     * Called if a new drop is created for the same asset id, and by anyone (presumably creator) if a drop is expired/empty.
     * Also called if the creator cancels the drop early.
     *
     * @param {TokenDropId} tokenDropId - The identifier of the token drop to be cleaned up.
     * @return {void} This method does not return a value.
     */
    cleanupDrop(tokenDropId: TokenDropId): void {
        // clone is essential here since we remove the box and further references may load from the box directly
        const dropInfo = clone(this.allDrops(tokenDropId).value)
        if (this.txn.sender !== dropInfo.DropCreator) {
            // if drop creator is not our caller, then the drop must be expired or empty
            // otherwise, the creator is is cancelling the drop for some other reason
            assert(this.isDropExpiredOrEmpty(dropInfo), 'drop MUST be expired or empty')
        }

        const preMbr = this.app.address.minBalance
        this.refundDropCreatorRemainingTokens(tokenDropId)
        this.removeFromDrops(tokenDropId)
        // this refund will also include the .1 algo freed up from opting out !
        const mbrRefund = preMbr - this.app.address.minBalance
        sendPayment({ receiver: dropInfo.DropCreator, amount: mbrRefund, note: 'refund from removing token drop' })
    }

    /**
     * Adds a new token drop by associating the given drop information with the drop ID and asset ID.
     *
     * @param {TokenDropId} tokenDropId - The unique identifier for the token drop.
     * @param {TokenDropInfo} dropInfo - The information about the token drop to be added.
     * @return {void} This method does not return anything.
     */
    private addNewDrop(tokenDropId: TokenDropId, dropInfo: TokenDropInfo): void {
        this.allDrops(tokenDropId).value = dropInfo
        this.dropForToken(dropInfo.Config.Token).value = tokenDropId
    }

    private removeFromDrops(tokenDropId: TokenDropId): void {
        const dropInfo = this.allDrops(tokenDropId).value
        this.dropForToken(dropInfo.Config.Token).delete()
        // we keep mbr in the contract after we delete so that future token claims might be able to get away
        // with free claim.
        this.allDrops(tokenDropId).delete()
    }

    /**
     * This function refunds the remaining tokens created in a specific token drop.
     * The amount of tokens to be refunded is determined by checking the 'AmountRemaining' property
     * of the corresponding TokenDrop object. If this value is greater than zero, the function will call
     * the `sendTokensFromDrop` method with appropriate parameters to transfer these remaining tokens back
     * to the creator of the token drop (identified by 'DropCreator' in the TokenDrop object). The updated
     * AmountRemaining is then checked to ensure that it has been removed from the active drops. If this fails,
     * an assertion error will be thrown indicating that the drop should have been removed.
     * @param tokenDropId - The ID of the TokenDrop for which tokens are being refunded.
     */
    private refundDropCreatorRemainingTokens(tokenDropId: TokenDropId): void {
        const dropInfo = this.allDrops(tokenDropId).value
        if (dropInfo.AmountRemaining > 0) {
            // we may have already received new tokens for the 'next' drop so don't consider
            // the current asset balance.  What is remaining in the drop we're cleaning up is all that matters
            this.sendTokensFromDrop(dropInfo, dropInfo.DropCreator, dropInfo.AmountRemaining)
        }
        if (this.app.address.assetBalance(dropInfo.Config.Token) === 0) {
            // opt-out of the asset
            sendAssetTransfer({
                xferAsset: dropInfo.Config.Token,
                assetReceiver: this.app.address,
                assetCloseTo: this.app.address,
                assetAmount: 0,
                note: 'opt-out of token',
            })
        }
    }

    /**
     * Sends a specified amount of tokens from a token drop to the given receiver
     * and updates the remaining balance of the drop. If the drop is fully claimed,
     * it is removed from the active drops.
     *
     * @param {TokenDropInfo} dropInfo - Information about the token drop, including the token type and remaining balance.
     * @param {Address} receiver - The address of the recipient who will receive the tokens.
     * @param {uint64} amountToSend - The amount of tokens to send to the receiver.
     * @return {uint64} The remaining balance of tokens in the token drop after the transfer.
     */
    private sendTokensFromDrop(dropInfo: TokenDropInfo, receiver: Address, amountToSend: uint64): uint64 {
        sendAssetTransfer({
            xferAsset: dropInfo.Config.Token,
            assetReceiver: receiver,
            assetAmount: amountToSend,
        })

        // make sure we track the latest balance for what was just claimed by user
        const remaining = dropInfo.AmountRemaining - amountToSend
        this.allDrops(dropInfo.DropId).value.AmountRemaining = remaining
        this.allDrops(dropInfo.DropId).value.NumClaims += 1

        return remaining
    }

    /**
     * Checks if the drop is either expired or empty (all tokens distributed) based on the current timestamp.
     *
     * @param {TokenDropInfo} dropInfo - The information about the token drop, including configuration details like the airdrop end time.
     * @return {boolean} Returns true if the airdrop is expired based on the latest timestamp or if it is considered empty; otherwise, false.
     */
    private isDropExpiredOrEmpty(dropInfo: TokenDropInfo): boolean {
        return dropInfo.AmountRemaining === 0 || globals.latestTimestamp > dropInfo.Config.AirdropEndTime
    }

    /**
     * Checks if an account wanting to claim tokens meets the gating requirements specified by the airdrop creator.
     *
     * @param {TokenDropId} tokenDropId - The id of the validator.
     * @param {uint64} valueToVerify - The value to verify against the gating requirements.
     * @returns {void} or asserts if requirements not met.
     */
    private doesClaimAccountMeetGating(tokenDropId: TokenDropId, valueToVerify: uint64): void {
        const type = this.allDrops(tokenDropId).value.Config.entryGatingType
        if (type === GATING_TYPE_NONE) {
            return
        }
        const claimer = this.txn.sender
        const tokenDropInfo = clone(this.allDrops(tokenDropId).value)

        // If an asset gating - check the balance requirement - can handle whether right asset afterward
        if (
            type === GATING_TYPE_ASSETS_CREATED_BY ||
            type === GATING_TYPE_ASSET_ID ||
            type === GATING_TYPE_CREATED_BY_NFD_ADDRESSES
        ) {
            assert(valueToVerify !== 0)
            let balRequired = tokenDropInfo.Config.gatingAssetMinBalance
            if (balRequired === 0) {
                balRequired = 1
            }
            assert(
                claimer.assetBalance(AssetID.fromUint64(valueToVerify)) >= balRequired,
                'must have required minimum balance of validator defined token to add stake',
            )
        }
        if (type === GATING_TYPE_ASSETS_CREATED_BY) {
            assert(
                AssetID.fromUint64(valueToVerify).creator === tokenDropInfo.Config.entryGatingAddress,
                'specified asset must be created by creator that the validator defined as a requirement to stake',
            )
        }
        if (type === GATING_TYPE_ASSET_ID) {
            let found = false
            for (const assetId of tokenDropInfo.Config.entryGatingAssets) {
                if (valueToVerify === assetId) {
                    found = true
                    break
                }
            }
            assert(found, 'specified asset must be identical to the asset id defined as a requirement to stake')
        }
        if (type === GATING_TYPE_CREATED_BY_NFD_ADDRESSES) {
            // Walk all the linked addresses defined by the gating NFD (stored packed in 'v.caAlgo.0.as' as a 'set' of 32-byte PKs)
            // if any are the creator of the specified asset then we pass.
            assert(
                this.isAddressInNFDCAAlgoList(
                    tokenDropInfo.Config.entryGatingAssets[0],
                    AssetID.fromUint64(valueToVerify).creator,
                ),
                'specified asset must be created by creator that is one of the linked addresses in an nfd',
            )
        }
        if (type === GATING_TYPE_SEGMENT_OF_NFD) {
            // verify nfd is real...
            const userOfferedNFDAppId = valueToVerify
            assert(this.isNfdAppIdValid(userOfferedNFDAppId), 'provided NFD must be valid')

            // now see if specified NFDs owner, or any of its caAlgo fields matches the claimers' address
            assert(
                rawBytes(AppID.fromUint64(userOfferedNFDAppId).globalState('i.owner.a') as Address) ===
                    rawBytes(claimer) || this.isAddressInNFDCAAlgoList(userOfferedNFDAppId, claimer),
                "provided nfd for entry isn't owned or linked to the claimer",
            )

            // We at least know it's a real NFD - now... is it a segment of the root NFD the validator defined ?
            assert(
                btoi(AppID.fromUint64(userOfferedNFDAppId).globalState('i.parentAppID') as bytes) ===
                    tokenDropInfo.Config.entryGatingAssets[0],
                'specified nfd must be a segment of the nfd the validator specified as a requirement',
            )
        }
        if (type === GATING_TYPE_NFD_W_VERIFIED_TWITTER) {
            this.checkValidV3NfdAndOwnedByClaimer(valueToVerify, claimer)
            const twitterVal = sendMethodCall<[bytes], bytes>({
                applicationID: AppID.fromUint64(valueToVerify),
                name: 'readField',
                methodArgs: ['v.twitter'],
            })
            assert(twitterVal !== '', 'must have verified twitter')
        }
        if (type === GATING_TYPE_NFD_W_VERIFIED_BLUESKY) {
            this.checkValidV3NfdAndOwnedByClaimer(valueToVerify, claimer)
            const twitterVal = sendMethodCall<[bytes], bytes>({
                applicationID: AppID.fromUint64(valueToVerify),
                name: 'readField',
                methodArgs: ['v.blueskydid'],
            })
            assert(twitterVal !== '', 'must have verified bluesky')
        }
        if (type === GATING_TYPE_NFD_HOLDING_AGE) {
            this.checkValidV3NfdAndOwnedByClaimer(valueToVerify, claimer)
            const timePurchased = btoi(AppID.fromUint64(valueToVerify).globalState('i.timePurchased') as bytes)
            assert(
                timePurchased + tokenDropInfo.Config.gatingAssetMinBalance * 24 * 60 * 60 <= globals.latestTimestamp,
                'nfd must be held for min num of days',
            )
        }
    }

    private checkValidV3NfdAndOwnedByClaimer(valueToVerify: uint64, claimer: Address): void {
        // verify real nfd and it contains a verified twitter field
        const userOfferedNFDAppId = valueToVerify
        assert(this.isNfdAppIdValid(userOfferedNFDAppId), 'provided NFD must be valid')
        // and is a V3 NFD...
        assert(!this.isNfdPreV3(userOfferedNFDAppId), 'NFD must be V3 or later')
        // and is owned, not expired
        assert(!this.isNfdForSale(userOfferedNFDAppId), 'NFD must not be for sale')
        assert(!this.isNfdExpired(userOfferedNFDAppId), 'NFD must not be expired')
        // now see if a specified NFDs owner matches the claimers' address
        assert(
            rawBytes(AppID.fromUint64(userOfferedNFDAppId).globalState('i.owner.a') as Address) === rawBytes(claimer),
            "provided nfd for entry isn't owned by the claimer",
        )
    }

    /**
     * Checks if the given NFD App id is valid.  Using only the App id there's no validation against the name (ie: that nfd X is name Y)
     * So it's assumed for the caller, the app id alone is fine.  The name is fetched from the specified app id and the two
     * together are used for validity check call to the nfd registry.
     *
     * @param {uint64} nfdAppId - The NFD App id to verify.
     *
     * @returns {boolean} - Returns true if the NFD App id is valid, otherwise false.
     */
    private isNfdAppIdValid(nfdAppId: uint64): boolean {
        // verify NFD user wants to offer up for testing is at least 'real' - since we just have app id - fetch its name then do is valid call
        const userOfferedNFDName = AppID.fromUint64(nfdAppId).globalState('i.name') as string

        return sendMethodCall<[string, uint64], boolean>({
            applicationID: this.nfdRegistryAppId.value,
            name: 'isValidNfdAppId',
            methodArgs: [userOfferedNFDName, nfdAppId],
        })
    }

    private isNfdPreV3(nfdAppId: uint64): boolean {
        const majVer = extract3(AppID.fromUint64(nfdAppId).globalState('i.ver') as bytes, 0, 2)
        return majVer === '1.' || majVer === '2.'
    }

    private isNfdForSale(nfdAppId: uint64): boolean {
        return this.safeGlobalIntGet(nfdAppId, 'i.sellamt') !== 0
    }

    // Check if the expiration time of the NFD key has passed.
    private isNfdExpired(nfdAppId: uint64): boolean {
        const expTime = this.safeGlobalIntGet(nfdAppId, 'i.expirationTime')
        if (expTime === 0) {
            // lifetime expiration
            return false
        }
        return globals.latestTimestamp > expTime
    }

    private safeGlobalIntGet(appId: uint64, key: bytes): uint64 {
        if (!AppID.fromUint64(appId).globalStateExists(key)) {
            return 0
        }
        return btoi(AppID.fromUint64(appId).globalState(key) as bytes)
    }

    /**
     * Checks if the specified address is present in an NFDs list of verified addresses.
     * The NFD is assumed to have already been validated as official.
     *
     * @param {uint64} nfdAppId - The NFD application id.
     * @param {Address} addrToFind - The address to find in the v.caAlgo.0.as property
     * @return {boolean} - `true` if the address is present, `false` otherwise.
     */
    private isAddressInNFDCAAlgoList(nfdAppId: uint64, addrToFind: Address): boolean {
        sendAppCall({
            applicationID: AppID.fromUint64(nfdAppId),
            applicationArgs: ['read_property', 'v.caAlgo.0.as'],
        })
        const caAlgoData = this.itxn.lastLog
        for (let i = 0; i < caAlgoData.length; i += 32) {
            const addr = extract3(caAlgoData, i, 32)
            if (addr !== rawBytes(globals.zeroAddress) && addr === rawBytes(addrToFind)) {
                return true
            }
        }
        return false
    }

    private checkGatingInfo(tokenDropInfo: TokenDropConfig) {
        assert(
            tokenDropInfo.entryGatingType >= GATING_TYPE_NONE && tokenDropInfo.entryGatingType <= GATING_TYPE_CONST_MAX,
        )
        if (
            tokenDropInfo.entryGatingType === GATING_TYPE_CREATED_BY_NFD_ADDRESSES ||
            tokenDropInfo.entryGatingType === GATING_TYPE_SEGMENT_OF_NFD
        ) {
            // verify gating NFD is at least 'real' - since we just have app id - fetch its name then do is valid call
            assert(
                this.isNfdAppIdValid(tokenDropInfo.entryGatingAssets[0]),
                'provided NFD App id for gating must be valid NFD',
            )
        }
        if (tokenDropInfo.entryGatingType === GATING_TYPE_NFD_HOLDING_AGE) {
            assert(tokenDropInfo.gatingAssetMinBalance > 0, 'asset min balance - used as nfd holding age - must be >0')
        }
    }

    private costForBoxStorage(totalNumBytes: uint64): uint64 {
        const SCBOX_PERBOX = 2500
        const SCBOX_PERBYTE = 400

        return SCBOX_PERBOX + totalNumBytes * SCBOX_PERBYTE
    }
}

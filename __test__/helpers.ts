/*
 * Copyright (c) 2025. TxnLab Inc.
 * All Rights reserved.
 */

import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { Address, ALGORAND_ZERO_ADDRESS_STRING } from 'algosdk'
import { LogicError } from '@algorandfoundation/algokit-utils/types/logic-error'
import { consoleLogger } from '@algorandfoundation/algokit-utils/types/logging'
import { microAlgo } from '@algorandfoundation/algokit-utils'
import base32Encode from 'base32-encode'
import { TokenDropClient, TokenDropComposer, TokenDropConfig } from '../contracts/clients/TokenDropClient'

export const GATING_TYPE_NONE = 0
export const GATING_TYPE_ASSETS_CREATED_BY = 1
export const GATING_TYPE_ASSET_ID = 2
export const GATING_TYPE_CREATED_BY_NFD_ADDRESSES = 3
export const GATING_TYPE_SEGMENT_OF_NFD = 4
export const GATING_TYPE_NFD_W_VERIFIED_TWITTER = 5
export const GATING_TYPE_NFD_W_VERIFIED_BLUESKY = 6
export const GATING_TYPE_NFD_HOLDING_AGE = 7

const EmptyTokenDropConfig: TokenDropConfig = {
    token: 0n,
    amountPerClaim: 0n,
    airdropEndTime: 0n,
    entryGatingType: 0,
    entryGatingAddress: ALGORAND_ZERO_ADDRESS_STRING,
    entryGatingAssets: [0n, 0n, 0n, 0n],
    gatingAssetMinBalance: 0n,
}

export function convertTxnIdToString(txnIdBytes: number[]): string {
    return base32Encode(new Uint8Array(txnIdBytes), 'RFC4648', { padding: false })
}

export function createTokenDropConfig(inputConfig: Partial<TokenDropConfig>): TokenDropConfig {
    return {
        ...EmptyTokenDropConfig,
        ...inputConfig,
    }
}

/**
 * Helper to create a new token drop with the specified configuration, send the assets, etc.
 *
 * @param {TokenDropClient} dropClient - The client instance used to interact with the token drop system.
 * @param {Address} dropCreator - The address of the creator initiating the token drop.
 * @param {TokenDropConfig} dropConfig - Configuration object that includes details about the token and claim settings.
 * @param {bigint} amountToPutInDrop - The total amount of tokens to allocate for the drop.
 * @return {Promise<bigint>} Returns the tokenDropId value
 * @throws Will throw an exception if there is an error during the drop creation process.
 */
export async function createDrop(
    dropClient: TokenDropClient,
    dropCreator: Address,
    dropConfig: TokenDropConfig,
    amountToPutInDrop: bigint,
) {
    // Add a new token drop
    try {
        const dropCost = await dropClient.getDropCreateCost()
        consoleLogger.info(
            `Creating a new token drop with ${amountToPutInDrop} tokens and ${dropConfig.amountPerClaim} tokens per claim (max ${amountToPutInDrop / dropConfig.amountPerClaim} claimers). Drop cost: ${microAlgo(dropCost).toString()}`,
        )

        const result = await dropClient
            .newGroup()
            .optinAsset({
                args: {
                    mbrPayment: dropClient.algorand.createTransaction.payment({
                        sender: dropCreator,
                        receiver: dropClient.appAddress.toString(),
                        amount: AlgoAmount.Algos(0.1),
                    }),
                    assetId: dropConfig.token,
                },
                maxFee: 3000n.microAlgo(),
            })
            .createDrop({
                args: {
                    // the required MBR payment transaction
                    feeAndMbrPayment: dropClient.algorand.createTransaction.payment({
                        sender: dropCreator,
                        receiver: dropClient.appAddress.toString(),
                        amount: AlgoAmount.MicroAlgo(dropCost),
                    }),
                    assetTxn: dropClient.algorand.createTransaction.assetTransfer({
                        assetId: dropConfig.token,
                        sender: dropCreator,
                        receiver: dropClient.appAddress.toString(),
                        amount: amountToPutInDrop,
                    }),
                    tokenDropConfig: dropConfig,
                },
                maxFee: 5000n.microAlgo(),
                sender: dropCreator,
            })
            .send({ coverAppCallInnerTransactionFees: true, suppressLog: true })

        return result.returns[1]!
    } catch (exception) {
        // console.log(exception)
        console.log((exception as LogicError).message)
        throw exception
    }
}

export async function claimDrop(dropClient: TokenDropClient, claimer: Address, tokenDropId: bigint) {
    const dropInfo = await dropClient.getDropInfo({ args: { tokenDropId } })
    const claimFee = await dropClient.getPerClaimerFee()
    // Add a new token drop
    try {
        const result = await dropClient
            .newGroup()
            .addTransaction(
                await dropClient.algorand.createTransaction.assetOptIn({
                    sender: claimer,
                    assetId: dropInfo.config.token,
                }),
            )
            .claimDrop({
                args: {
                    feeAndMbrPayment: dropClient.algorand.createTransaction.payment({
                        sender: claimer,
                        receiver: dropClient.appAddress.toString(),
                        amount: AlgoAmount.MicroAlgo(claimFee),
                    }),
                    tokenDropId,
                    valueToVerify: 0n,
                },
                maxFee: 5000n.microAlgo(),
                sender: claimer,
            })
            .send({ coverAppCallInnerTransactionFees: true, suppressLog: true })

        return [result.returns[1]!, result.txIds[2]!]
    } catch (exception) {
        // console.log(exception)
        console.log((exception as LogicError).message)
        throw exception
    }
}

export async function getClaimedAddressesForDrop(dropClient: TokenDropClient, dropId: bigint): Promise<Set<string>> {
    const allClaims = await dropClient.state.box.claimedMap.getMap()
    const uniqueClaimers = new Set<string>()
    // eslint-disable-next-line no-restricted-syntax
    for (const key of allClaims.keys()) {
        if (key.tokenDropId === dropId) {
            uniqueClaimers.add(key.address)
        }
    }
    /* manual way of getting
    const allBoxes: BoxName[] = await dropClient.algorand.app.getBoxNames(dropClient.appId)
    for (let i = 0; i < allBoxes.length; i += 1) {
        if (allBoxes[i].nameRaw[0] === 'c'.charCodeAt(0)) {
            const key = getABIDecodedValue(
                allBoxes[i].nameRaw.slice(1),
                'AddressClaimKey',
                dropClient.appSpec.structs,
            ) as AddressClaimKey
            if (key.tokenDropId === dropId) {
                uniqueClaimers.add(key.address)
            }
        }
    }
     */
    return uniqueClaimers
}

export async function batchClaimClaimer(
    dropClient: TokenDropClient,
    dropId: bigint,
    accountsThatClaimed: string[],
    receiver: string,
    batchSize: number = 16,
): Promise<void> {
    // Process in batches of batchSize (default 16)
    for (let i = 0; i < accountsThatClaimed.length; i += batchSize) {
        // Get the current batch (slice up to batchSize elements)
        const batch = accountsThatClaimed.slice(i, i + batchSize)

        // Start a transaction group
        let txnGroup: TokenDropComposer = dropClient.newGroup()

        // Add each transaction to the group
        // eslint-disable-next-line no-restricted-syntax
        for (const claimAddr of batch) {
            txnGroup = txnGroup.claimClaimerBoxCost({
                args: {
                    tokenDropId: dropId,
                    claimerAddress: claimAddr,
                    receiver,
                },
                maxFee: 3000n.microAlgo(),
            }) as unknown as TokenDropComposer
        }

        // Send the transaction group
        await txnGroup.send({ coverAppCallInnerTransactionFees: true, suppressLog: true })
    }
}

/*
 * Copyright (c) 2025. TxnLab Inc.
 * All Rights reserved.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { algoKitLogCaptureFixture, algorandFixture, getTestAccount } from '@algorandfoundation/algokit-utils/testing'
import { AlgorandClient, Config } from '@algorandfoundation/algokit-utils'
import { consoleLogger } from '@algorandfoundation/algokit-utils/types/logging'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { Account, Address } from 'algosdk'
import { AddressClaimKey, TokenDropClient, TokenDropFactory, TokenDropInfo } from '../contracts/clients/TokenDropClient'
import {
    batchClaimClaimer,
    claimDrop,
    convertTxnIdToString,
    createDrop,
    createTokenDropConfig,
    GATING_TYPE_NONE,
    getClaimedAddressesForDrop,
} from './helpers'

const fixture = algorandFixture({ testAccountFunding: AlgoAmount.Algos(1000) })
Config.configure({ populateAppCallResources: true })
const logs = algoKitLogCaptureFixture()

let appClient: TokenDropClient
let algorand: AlgorandClient
let maintainerAccount: Address & TransactionSignerAccount & Account

describe('TokenDrop', () => {
    beforeAll(async () => {
        logs.beforeEach()
        await fixture.newScope()
        const { testAccount } = fixture.context
        algorand = fixture.algorand

        maintainerAccount = await getTestAccount({ initialFunds: (0).algo(), suppressLog: true }, algorand)

        consoleLogger.info(`testAccount: ${testAccount.addr}`)
        const factory = new TokenDropFactory({
            algorand,
            defaultSender: testAccount.addr,
        })

        const createResult = await factory.send.create.createApplication({
            args: { nfdRegistryId: 1, maintainerAddress: maintainerAccount.addr.toString() },
            suppressLog: true,
        })
        appClient = createResult.appClient
        expect(appClient).toBeDefined()
        expect(appClient.appId).toBeGreaterThan(0)
        // fund the contract with .1 for its algo mbr
        algorand.send.payment({
            sender: testAccount,
            receiver: appClient.appAddress,
            amount: (0.1).algo(),
            suppressLog: true,
        })
    })
    afterAll(async () => {
        logs.afterEach()
    })

    async function verifyRemainingInDrop(dropId: bigint): Promise<TokenDropInfo> {
        const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: dropId } })
        expect(dropInfo.amountRemaining).toEqual(
            (dropInfo.maxClaims - dropInfo.numClaims) * dropInfo.config.amountPerClaim,
        )
        return dropInfo
    }

    describe('add new Drop', () => {
        let tokenCreator: TransactionSignerAccount
        let tokenId: bigint
        beforeAll(async () => {
            tokenCreator = await getTestAccount({ initialFunds: (100).algo(), suppressLog: true }, algorand)

            const results = await algorand.send.assetCreate({
                sender: tokenCreator.addr,
                total: 1_000_000n,
                decimals: 0,
                assetName: 'For dropping',
                unitName: 'drop',
                suppressLog: true,
            })
            tokenId = results.assetId
        })
        test('fail on invalid amount sent', async () => {
            const dropConfig = createTokenDropConfig({
                token: tokenId,
                amountPerClaim: 1000n,
                airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
                entryGatingType: GATING_TYPE_NONE,
            })
            await expect(createDrop(appClient, tokenCreator.addr, dropConfig, 3500n)).rejects.toThrowError()
        })
        test('fail on too short length < 1d', async () => {
            const dropConfig = createTokenDropConfig({
                token: tokenId,
                amountPerClaim: 1000n,
                airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 6 * 60 * 60), // 6 hours - will fail
                entryGatingType: GATING_TYPE_NONE,
            })
            await expect(createDrop(appClient, tokenCreator.addr, dropConfig, 4000n)).rejects.toThrowError()
        })
        test('fail on too long of length > 7d', async () => {
            const dropConfig = createTokenDropConfig({
                token: tokenId,
                amountPerClaim: 1000n,
                airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 8 * 24 * 60 * 60), // 6 hours - will fail
                entryGatingType: GATING_TYPE_NONE,
            })
            await expect(createDrop(appClient, tokenCreator.addr, dropConfig, 4000n)).rejects.toThrowError()
        })
        test('add new drop', async () => {
            expect(await appClient.state.global.lastDropId()).toEqual(0n)
            const dropConfig = createTokenDropConfig({
                token: tokenId,
                amountPerClaim: 1000n,
                airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
                entryGatingType: GATING_TYPE_NONE,
            })
            const dropId = await createDrop(appClient, tokenCreator.addr, dropConfig, 4000n)
            expect(dropId).toBeGreaterThan(0n)
            consoleLogger.info(`dropId: ${dropId}`)

            const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: dropId } })
            expect(dropInfo.dropId).toEqual(dropId)
            expect(dropInfo.dropCreator).toEqual(tokenCreator.addr.toString())
            expect(dropInfo.amountRemaining).toEqual(4000n)
            expect(dropInfo.maxClaims).toEqual(4000n / 1000n)
            expect(dropInfo.numClaims).toEqual(0n)
            expect(dropInfo.config.token).toEqual(tokenId)
            expect(dropInfo.config.amountPerClaim).toEqual(1000n)

            expect(await appClient.state.global.lastDropId()).toEqual(dropId)

            expect(await appClient.state.box.dropForToken.value(tokenId)).toEqual(dropId)

            // quick client access check
            const othDropInfo = await appClient.state.box.allDrops.value(dropId)
            expect(othDropInfo!.config.token).toEqual(tokenId)
            expect(othDropInfo!.config.amountPerClaim).toEqual(1000n)

            expect((await appClient.state.box.allDrops.getMap()).get(dropId)?.dropId).toEqual(dropId)
        })
        test('add new drop while other running - should fail', async () => {
            const dropConfig = createTokenDropConfig({
                token: tokenId,
                amountPerClaim: 1000n,
                airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
                entryGatingType: GATING_TYPE_NONE,
            })
            await expect(createDrop(appClient, tokenCreator.addr, dropConfig, 4000n)).rejects.toThrowError()
        })
    })

    describe('add new Drop w/ 5 claims', () => {
        let tokenCreator: TransactionSignerAccount
        let tokenId: bigint
        let dropId: bigint

        const amountToSend = 5000n
        const amountPerDrop = 1000n
        const claimAccounts: TransactionSignerAccount[] = []
        beforeAll(async () => {
            tokenCreator = await getTestAccount({ initialFunds: (100).algo(), suppressLog: true }, algorand)

            const results = await algorand.send.assetCreate({
                sender: tokenCreator.addr,
                total: 1_000_000n,
                decimals: 0,
                assetName: 'For dropping',
                unitName: 'drop 2',
                suppressLog: true,
            })
            tokenId = results.assetId
        })

        test('add new drop', async () => {
            const dropConfig = createTokenDropConfig({
                token: tokenId,
                amountPerClaim: amountPerDrop,
                airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
                entryGatingType: GATING_TYPE_NONE,
            })
            dropId = await createDrop(appClient, tokenCreator.addr, dropConfig, amountToSend)
            expect(dropId).toBeGreaterThan(0n)
            consoleLogger.info(`dropId: ${dropId}`)

            const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: dropId } })
            expect(dropInfo.dropId).toEqual(dropId)
            expect(dropInfo.dropCreator).toEqual(tokenCreator.addr.toString())
            expect(dropInfo.amountRemaining).toEqual(amountToSend)
            expect(dropInfo.maxClaims).toEqual(amountToSend / amountPerDrop)
            expect(dropInfo.numClaims).toEqual(0n)
            expect(dropInfo.config.token).toEqual(tokenId)
            expect(dropInfo.config.amountPerClaim).toEqual(amountPerDrop)
        })

        test('fail on bad drop id', async () => {
            // try to claim bad token drop id - should fail
            await expect(claimDrop(appClient, tokenCreator.addr, 500000n)).rejects.toThrowError(/logic eval error/)
        })

        test('claim single drop', async () => {
            claimAccounts.push(await getTestAccount({ initialFunds: (10).algo(), suppressLog: true }, algorand))
            await expect(algorand.asset.getAccountInformation(claimAccounts[0].addr, tokenId)).rejects.toThrowError(
                /asset info not found/,
            )
            const [, claimTxnId] = (await claimDrop(appClient, claimAccounts[0].addr, dropId))!
            const claimTokInfo = await algorand.asset.getAccountInformation(claimAccounts[0].addr, tokenId)
            expect(claimTokInfo.balance).toEqual(amountPerDrop)

            const dropInfo = await verifyRemainingInDrop(dropId)
            expect(dropInfo.numClaims).toEqual(1n)
            expect(dropInfo.config.token).toEqual(tokenId)
            expect(dropInfo.config.amountPerClaim).toEqual(amountPerDrop)

            const claimedInfo = await appClient.state.box.claimedMap.value({
                tokenDropId: dropId,
                address: claimAccounts[0].addr.toString(),
            } as AddressClaimKey)
            const claimedTxnIdStr = convertTxnIdToString(claimedInfo!.txnId as unknown as number[])
            expect(claimedTxnIdStr).toEqual(claimTxnId)
        })
        test('try to reclaim - fail', async () => {
            await expect(claimDrop(appClient, claimAccounts[0].addr, dropId)).rejects.toThrowError()
        })

        test('claim 4 drops', async () => {
            const origTotalClaims = (await appClient.state.global.totalClaims())!
            for (let i = 1; i < 5; i += 1) {
                claimAccounts.push(await getTestAccount({ initialFunds: (10).algo(), suppressLog: true }, algorand))
                const [, claimTxnId] = (await claimDrop(appClient, claimAccounts[i].addr, dropId))!
                const claimTokInfo = await algorand.asset.getAccountInformation(claimAccounts[i].addr, tokenId)
                expect(claimTokInfo.balance).toEqual(amountPerDrop)

                const dropInfo = await verifyRemainingInDrop(dropId)
                expect(dropInfo.numClaims).toEqual(1n + BigInt(i))
                expect(dropInfo.config.token).toEqual(tokenId)
                expect(dropInfo.config.amountPerClaim).toEqual(amountPerDrop)

                const claimedInfo = await appClient.state.box.claimedMap.value({
                    tokenDropId: dropId,
                    address: claimAccounts[i].addr.toString(),
                } as AddressClaimKey)
                const claimedTxnIdStr = convertTxnIdToString(claimedInfo!.txnId as unknown as number[])
                expect(claimedTxnIdStr).toEqual(claimTxnId)
            }
            // Verify the box claim data is correct
            const addressesInBox = await getClaimedAddressesForDrop(appClient, dropId)
            expect(addressesInBox.size).toEqual(claimAccounts.length)
            for (let i = 0; i < claimAccounts.length; i += 1) {
                expect(addressesInBox.has(claimAccounts[i].addr.toString())).toEqual(true)
            }
            expect(await appClient.state.global.totalClaims()).toEqual(origTotalClaims + 4n)
        })
        test('try to claim again - should fail because all tokens gone', async () => {
            const newClaim = await getTestAccount({ initialFunds: (10).algo(), suppressLog: true }, algorand)
            await expect(claimDrop(appClient, newClaim.addr, dropId)).rejects.toThrowError()

            const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: dropId } })
            expect(dropInfo.amountRemaining).toEqual(0n)
            expect(dropInfo.numClaims).toEqual(5n)
            expect(dropInfo.maxClaims).toEqual(dropInfo.numClaims)
            expect(dropInfo.config.token).toEqual(tokenId)
            expect(dropInfo.config.amountPerClaim).toEqual(amountPerDrop)
        })
        test('new drop - same asset - should remove old drop, create new', async () => {
            const newCreator = await getTestAccount({ initialFunds: (100).algo(), suppressLog: true }, algorand)
            // send some of the prior asset to our new creator account so it can create drop with same asset
            await algorand.send.assetOptIn({ sender: newCreator.addr, assetId: tokenId })
            await algorand.send.assetTransfer({
                sender: tokenCreator.addr,
                receiver: newCreator.addr,
                amount: amountToSend,
                assetId: tokenId,
            })
            // quick sanity check
            expect(tokenCreator.addr.toString()).toEqual(
                (await appClient.getDropInfo({ args: { tokenDropId: dropId } })).dropCreator,
            )

            // capture balance of original drop creator so we can verify if some MBR comes back
            // get drop cost w/ 5 claimers - and with individual cleanup calls we should get it al back other than the
            // base creation 'fee'
            let baseMbrAmount = await appClient.getDropCreateCost()
            // subtract the upfront 'fee' out
            baseMbrAmount -= (await appClient.state.global.creationFeeAmount())!
            consoleLogger.info(`baseMbrAmount: ${baseMbrAmount}`)

            const perClaimerMbr = await appClient.getPerClaimerMbrCost()
            consoleLogger.info(`perClaimerMbr: ${perClaimerMbr} - for 5 claimers:${5n * perClaimerMbr}`)

            const mbrReclaimAmount = baseMbrAmount + 5n * perClaimerMbr
            consoleLogger.info(`mbrReclaimAmount: ${mbrReclaimAmount}`)

            const origCreatorPreBalance = await algorand.account.getInformation(tokenCreator.addr)

            // iterate through all the claimers but not reusing our built up array - fetch from chain again
            // we want to claim their cleanup cost (won't work if not expired or empty!)
            const accountsThatClaimed = await getClaimedAddressesForDrop(appClient, dropId)
            await batchClaimClaimer(
                appClient,
                dropId,
                Array.from(accountsThatClaimed),
                tokenCreator.addr.toString(),
                16,
            )
            // could make call to cleanupDrop here - but we'll instead rely on creating a new drop for same token doing it
            // balance won't match in previous drop's creator if it didn't work

            const dropConfig = createTokenDropConfig({
                token: tokenId,
                amountPerClaim: amountPerDrop,
                airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
                entryGatingType: GATING_TYPE_NONE,
            })
            const newDropId = await createDrop(appClient, newCreator.addr, dropConfig, amountToSend)
            expect(newDropId).toBeGreaterThan(dropId)
            consoleLogger.info(`dropId: ${newDropId}`)

            // old drop should be gone now
            await expect(appClient.getDropInfo({ args: { tokenDropId: dropId } })).rejects.toThrowError()
            // check orig creator balance - should have increased by mbrReclaimAmount
            const origCreatorPostBalance = await algorand.account.getInformation(tokenCreator.addr)
            expect(origCreatorPostBalance.balance.microAlgo).toEqual(
                origCreatorPreBalance.balance.microAlgo + mbrReclaimAmount, // (0.1).algo().microAlgo /* add in opt-in cost we got back if we did 'cleanupDrop' */,
            )

            const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: newDropId } })
            expect(dropInfo.dropId).toEqual(newDropId)
            expect(dropInfo.dropCreator).toEqual(newCreator.addr.toString())
            expect(dropInfo.amountRemaining).toEqual(amountToSend)
            expect(dropInfo.maxClaims).toEqual(amountToSend / amountPerDrop)
            expect(dropInfo.numClaims).toEqual(0n)
            expect(dropInfo.config.token).toEqual(tokenId)
            expect(dropInfo.config.amountPerClaim).toEqual(amountPerDrop)
        })
    }, 60000)

    describe('simple drop w/ 1 claim', () => {
        let tokenCreator: TransactionSignerAccount
        let tokenId: bigint
        let dropId: bigint

        const amountToSend = 1000n
        const amountPerDrop = 1000n
        const claimAccounts: TransactionSignerAccount[] = []
        beforeAll(async () => {
            tokenCreator = await getTestAccount({ initialFunds: (100).algo(), suppressLog: true }, algorand)

            const results = await algorand.send.assetCreate({
                sender: tokenCreator.addr,
                total: 1_000_000n,
                decimals: 0,
                assetName: 'For dropping',
                unitName: 'drop 2',
                suppressLog: true,
            })
            tokenId = results.assetId
        })

        test('add new drop', async () => {
            const dropConfig = createTokenDropConfig({
                token: tokenId,
                amountPerClaim: amountPerDrop,
                airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
                entryGatingType: GATING_TYPE_NONE,
            })
            dropId = await createDrop(appClient, tokenCreator.addr, dropConfig, amountToSend)
            expect(dropId).toBeGreaterThan(0n)
            consoleLogger.info(`dropId: ${dropId}`)

            const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: dropId } })
            expect(dropInfo.dropId).toEqual(dropId)
            expect(dropInfo.dropCreator).toEqual(tokenCreator.addr.toString())
            expect(dropInfo.amountRemaining).toEqual(amountToSend)
            expect(dropInfo.maxClaims).toEqual(amountToSend / amountPerDrop)
            expect(dropInfo.numClaims).toEqual(0n)
            expect(dropInfo.config.token).toEqual(tokenId)
            expect(dropInfo.config.amountPerClaim).toEqual(amountPerDrop)
        })

        test('claim single drop', async () => {
            claimAccounts.push(await getTestAccount({ initialFunds: (10).algo(), suppressLog: true }, algorand))

            const origMaintainerBalance = await algorand.account.getInformation(maintainerAccount.addr)
            const origTotalClaims = (await appClient.state.global.totalClaims())!

            const [, claimTxnId] = (await claimDrop(appClient, claimAccounts[0].addr, dropId))!
            const claimTokInfo = await algorand.asset.getAccountInformation(claimAccounts[0].addr, tokenId)
            expect(claimTokInfo.balance).toEqual(amountPerDrop)

            const dropInfo = await verifyRemainingInDrop(dropId)
            expect(dropInfo.numClaims).toEqual(1n)
            expect(dropInfo.config.token).toEqual(tokenId)
            expect(dropInfo.config.amountPerClaim).toEqual(amountPerDrop)

            const claimedInfo = await appClient.state.box.claimedMap.value({
                tokenDropId: dropId,
                address: claimAccounts[0].addr.toString(),
            } as AddressClaimKey)
            const claimedTxnIdStr = convertTxnIdToString(claimedInfo!.txnId as unknown as number[])
            expect(claimedTxnIdStr).toEqual(claimTxnId)

            const newMaintainerBalance = await algorand.account.getInformation(maintainerAccount.addr)
            // should get 50% of the per-claim fee to maintainer account
            expect(newMaintainerBalance.balance.microAlgo).toEqual(
                origMaintainerBalance.balance.microAlgo + (await appClient.getPerClaimerFee()) / 2n,
            )
            expect(await appClient.state.global.totalClaims()).toEqual(origTotalClaims + 1n)
        })

        test('try to claim again - should fail because all tokens gone', async () => {
            const newClaim = await getTestAccount({ initialFunds: (10).algo(), suppressLog: true }, algorand)
            await expect(claimDrop(appClient, newClaim.addr, dropId)).rejects.toThrowError()

            const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: dropId } })
            expect(dropInfo.amountRemaining).toEqual(0n)
            expect(dropInfo.numClaims).toEqual(1n)
            expect(dropInfo.maxClaims).toEqual(dropInfo.numClaims)
            expect(dropInfo.config.token).toEqual(tokenId)
            expect(dropInfo.config.amountPerClaim).toEqual(amountPerDrop)
        })
    }, 60000)

    describe("drop, claim all, don't cleanup", () => {
        let tokenCreator: TransactionSignerAccount
        let tokenId: bigint
        let dropId: bigint

        const amountToSend = 2000n
        const amountPerDrop = 1000n
        let claimAccount: TransactionSignerAccount
        beforeAll(async () => {
            tokenCreator = await getTestAccount({ initialFunds: (100).algo(), suppressLog: true }, algorand)

            const results = await algorand.send.assetCreate({
                sender: tokenCreator.addr,
                total: amountToSend,
                decimals: 0,
                assetName: 'For dropping',
                unitName: 'drop 2',
                suppressLog: true,
            })
            tokenId = results.assetId
        })

        test('add new drop', async () => {
            // const newAcct = await getTestAccount({ initialFunds: (100).algo(), suppressLog: true }, algorand)
            const dropConfig = createTokenDropConfig({
                token: tokenId,
                amountPerClaim: amountPerDrop,
                airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
                entryGatingType: GATING_TYPE_NONE,
            })
            dropId = await createDrop(appClient, tokenCreator.addr, dropConfig, amountToSend)
            expect(dropId).toBeGreaterThan(0n)
            consoleLogger.info(`dropId: ${dropId}`)

            const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: dropId } })
            expect(dropInfo.dropId).toEqual(dropId)
            expect(dropInfo.dropCreator).toEqual(tokenCreator.addr.toString())
            expect(dropInfo.amountRemaining).toEqual(amountToSend)
            expect(dropInfo.maxClaims).toEqual(amountToSend / amountPerDrop)
            expect(dropInfo.numClaims).toEqual(0n)
            expect(dropInfo.config.token).toEqual(tokenId)
            expect(dropInfo.config.amountPerClaim).toEqual(amountPerDrop)
        })

        test('fail on bad drop id', async () => {
            // try to claim bad token drop id - should fail
            await expect(claimDrop(appClient, tokenCreator.addr, 500000n)).rejects.toThrowError(/logic eval error/)
        })

        test('claim single drop', async () => {
            claimAccount = await getTestAccount({ initialFunds: (10).algo(), suppressLog: true }, algorand)
            await expect(algorand.asset.getAccountInformation(claimAccount.addr, tokenId)).rejects.toThrowError(
                /asset info not found/,
            )
            await claimDrop(appClient, claimAccount.addr, dropId)
            const claimTokInfo = await algorand.asset.getAccountInformation(claimAccount.addr, tokenId)
            expect(claimTokInfo.balance).toEqual(amountPerDrop)

            const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: dropId } })
            expect(dropInfo.numClaims).toEqual(1n)
        })
        test('try to reclaim for same acct - fail', async () => {
            await expect(claimDrop(appClient, claimAccount.addr, dropId)).rejects.toThrowError()
        })

        test('claim w/ second acct', async () => {
            claimAccount = await getTestAccount({ initialFunds: (10).algo(), suppressLog: true }, algorand)
            await expect(algorand.asset.getAccountInformation(claimAccount.addr, tokenId)).rejects.toThrowError(
                /asset info not found/,
            )
            await claimDrop(appClient, claimAccount.addr, dropId)
            const claimTokInfo = await algorand.asset.getAccountInformation(claimAccount.addr, tokenId)
            expect(claimTokInfo.balance).toEqual(amountPerDrop)
            const dropInfo = await verifyRemainingInDrop(dropId)
            expect(dropInfo.numClaims).toEqual(2n)
        })
        test('try to reclaim for same acct - fail again', async () => {
            await expect(claimDrop(appClient, claimAccount.addr, dropId)).rejects.toThrowError()
        })
    }, 60000)

    describe('create drop, 2 claims, finish', () => {
        let tokenCreator: TransactionSignerAccount
        let tokenId: bigint
        let dropId: bigint

        const amountToSend = 4000n // allow for 4 claims - but we cancel after 2
        const amountPerDrop = 1000n
        const claimAccounts: TransactionSignerAccount[] = []
        beforeAll(async () => {
            tokenCreator = await getTestAccount({ initialFunds: (100).algo(), suppressLog: true }, algorand)

            const results = await algorand.send.assetCreate({
                sender: tokenCreator.addr,
                total: 1_000_000n,
                decimals: 0,
                assetName: 'For dropping',
                unitName: 'cncldrop',
                // suppressLog: true,
            })
            tokenId = results.assetId
        })

        test('add new drop', async () => {
            const dropConfig = createTokenDropConfig({
                token: tokenId,
                amountPerClaim: amountPerDrop,
                airdropEndTime: BigInt(Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60),
                entryGatingType: GATING_TYPE_NONE,
            })
            dropId = await createDrop(appClient, tokenCreator.addr, dropConfig, amountToSend)
            expect(dropId).toBeGreaterThan(0n)
            consoleLogger.info(`dropId: ${dropId}`)

            const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: dropId } })
            expect(dropInfo.dropId).toEqual(dropId)
            expect(dropInfo.dropCreator).toEqual(tokenCreator.addr.toString())
            expect(dropInfo.amountRemaining).toEqual(amountToSend)
            expect(dropInfo.maxClaims).toEqual(amountToSend / amountPerDrop)
            expect(dropInfo.config.token).toEqual(tokenId)
        })

        test('claim two drops', async () => {
            claimAccounts.push(await getTestAccount({ initialFunds: (10).algo(), suppressLog: true }, algorand))
            claimAccounts.push(await getTestAccount({ initialFunds: (10).algo(), suppressLog: true }, algorand))

            const origTotalClaims = (await appClient.state.global.totalClaims())!

            await claimDrop(appClient, claimAccounts[0].addr, dropId)
            let claimTokInfo = await algorand.asset.getAccountInformation(claimAccounts[0].addr, tokenId)
            expect(claimTokInfo.balance).toEqual(amountPerDrop)

            await claimDrop(appClient, claimAccounts[1].addr, dropId)
            claimTokInfo = await algorand.asset.getAccountInformation(claimAccounts[1].addr, tokenId)
            expect(claimTokInfo.balance).toEqual(amountPerDrop)

            const dropInfo = await verifyRemainingInDrop(dropId)
            expect(dropInfo.numClaims).toEqual(2n)
            expect(dropInfo.config.token).toEqual(tokenId)
            expect(dropInfo.config.amountPerClaim).toEqual(amountPerDrop)

            expect(await appClient.state.global.totalClaims()).toEqual(origTotalClaims + 2n)
        })

        test('cancel early', async () => {
            // verify drop still there
            const dropInfo = await appClient.getDropInfo({ args: { tokenDropId: dropId } })
            expect(dropInfo.dropCreator).toEqual(tokenCreator.addr.toString())

            const origCreatorPreBalance = await algorand.asset.getAccountInformation(tokenCreator.addr, tokenId)

            // try to cancel drop - should fail because not creator
            await expect(
                appClient.send.cancelDrop({
                    args: { tokenDropId: dropId },
                    maxFee: 5000n.microAlgo(),
                    coverAppCallInnerTransactionFees: true,
                }),
            ).rejects.toThrowError()

            // should work now that we send from drop creator
            await appClient.send.cancelDrop({
                sender: tokenCreator.addr,
                args: { tokenDropId: dropId },
                maxFee: 5000n.microAlgo(),
                coverAppCallInnerTransactionFees: true,
            })
            // drop should be gone (getting info should fail)
            await expect(appClient.getDropInfo({ args: { tokenDropId: dropId } })).rejects.toThrowError()
            // check orig creator balance - should have increased by mbrReclaimAmount
            const origCreatorPostBalance = await algorand.asset.getAccountInformation(tokenCreator.addr, tokenId)
            expect(origCreatorPostBalance.balance).toEqual(origCreatorPreBalance.balance + dropInfo.amountRemaining)
        })
    }, 60000)
})

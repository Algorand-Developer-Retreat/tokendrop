import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { Account, decodeAddress } from 'algosdk'
import yargs from 'yargs'
import prompts from 'prompts'
import { AlgoClientConfig } from '@algorandfoundation/algokit-utils/types/network-client'
import { ClientManager } from '@algorandfoundation/algokit-utils/types/client-manager'
import { configDotenv } from 'dotenv'
import { TokenDropClient, TokenDropFactory } from '../clients/TokenDropClient'

function getNetworkConfig(network: string): [AlgoClientConfig, bigint] {
    let nfdRegistryAppID: bigint
    switch (network) {
        case 'devnet':
        case 'localnet':
            nfdRegistryAppID = 0n
            return [ClientManager.getConfigFromEnvironmentOrLocalNet().algodConfig, nfdRegistryAppID]
        case 'betanet':
            nfdRegistryAppID = 842656530n
            break
        case 'testnet':
            nfdRegistryAppID = 84366825n
            break
        case 'mainnet':
            nfdRegistryAppID = 760937186n
            break
        default:
            throw new Error(`Unsupported network network: ${network}`)
    }
    const config = {
        server: `https://${network}-api.4160.nodely.dev/`,
        port: 443,
    } as AlgoClientConfig

    return [config, nfdRegistryAppID]
}

async function main() {
    configDotenv()
    const args = await yargs
        .option('network', {
            default: 'localnet',
            choices: ['localnet', 'betanet', 'testnet', 'mainnet'],
            demandOption: true,
        })
        .option('maintainer', { type: 'string', default: '' })
        .option('update', { type: 'boolean', default: false })
        .option('id', { type: 'number', default: 0 }).argv

    console.log(`Network:${args.network}`)
    const [algodConfig, registryAppID] = getNetworkConfig(args.network)

    let algorand: AlgorandClient = AlgorandClient.defaultLocalNet()
    if (args.network !== 'localnet') {
        algorand = AlgorandClient.fromConfig({ algodConfig, indexerConfig: undefined, kmdConfig: undefined })
    }
    console.log(`algo config is:${JSON.stringify(algodConfig)}`)

    let creatorAcct: Account
    const creationFee = 10_000_000n // 10 ALGO creation fee
    const perClaimFee = 100_000n // .1 ALGO per-claim fee

    // Confirm the network choice by prompting the user if they want to continue if !localnet
    if (args.network !== 'localnet') {
        // verify an env variable is defined for CREATOR_MNEMONIC !
        if (!process.env.CREATOR_MNEMONIC) {
            console.error('Environment variable CREATOR_MNEMONIC is not defined')
            process.exit(1)
        }
        creatorAcct = (await algorand.account.fromEnvironment('CREATOR')).account
        console.log(`using ${creatorAcct.addr} as TokenDrop creator.  MAKE SURE THIS IS CORRECT!`)

        console.log(`You've specified you want to DEPLOY to ${args.network}!  This is permanent !`)
        const yn = await prompts({
            type: 'confirm',
            name: 'value',
            message: 'Can you confirm?',
            initial: true,
        })
        if (!yn.value) {
            return
        }
    } else {
        if (!process.env.CREATOR_MNEMONIC) {
            console.log('no creator account specified - using dispenser account as creator')
            creatorAcct = (await algorand.account.dispenserFromEnvironment()).account
        } else {
            creatorAcct = (await algorand.account.fromEnvironment('CREATOR')).account
            console.log(`using ${creatorAcct.addr} as TokenDrop creator.  MAKE SURE THIS IS CORRECT!`)
        }

        console.log(`Primary CREATOR (or DISPENSER) account is: ${creatorAcct.addr}`)
    }

    // Now determine which account will receive payments (the maintainer acct)
    let maintainerAcct: string = args.maintainer

    if (maintainerAcct === '') {
        maintainerAcct = creatorAcct.addr.toString()
    }
    decodeAddress(maintainerAcct) // just verify maintainer is valid algorand address

    // Generate staking pool template instance that we load into the validator registry instance's box storage
    if (!args.update) {
        console.log(`creating application`)
        const tokenDropFactory = new TokenDropFactory({
            algorand,
            defaultSender: creatorAcct.addr,
        })

        const dropApp = await tokenDropFactory.send.create.createApplication({
            args: { nfdRegistryId: registryAppID, maintainerAddress: maintainerAcct },
            extraProgramPages: 3, // go ahead and buy up max
            suppressLog: true,
        })

        console.log(`TokenDrop app id is:${dropApp.appClient.appId}`)
        console.log(`TokenDrop Contract HASH is:${dropApp.result.compiledApproval!.compiledHash}`)
    } else {
        if (args.id === 0) {
            // error -  id must be defined!
            console.error('Error: id must be defined!')
            process.exit(1)
        }
        console.log(`updating application ${args.id}`)
        const tokenClient = new TokenDropClient({
            algorand,
            defaultSender: creatorAcct.addr,
            appId: BigInt(args.id),
        })
        const dropApp = await tokenClient.send.update.updateApplication()
        console.log(`application ${args.id} updated`)
        console.log(`TokenDrop Contract HASH is:${dropApp.compiledApproval!.compiledHash}`)

        const curMaintainer = await tokenClient.state.global.maintainerAddress()
        if (curMaintainer !== maintainerAcct) {
            console.log(
                `The maintainer address is:${curMaintainer} - do you really want to change it to:${maintainerAcct} ?`,
            )
            const yn = await prompts({
                type: 'confirm',
                name: 'value',
                message: 'Can you confirm?',
                initial: true,
            })
            if (!yn.value) {
                return
            }
            console.log(`changing maintainer to ${maintainerAcct}`)
            await tokenClient.send.changeMaintainer({ args: { newMaintainer: maintainerAcct } })
        }
        const curCreationFee = await tokenClient.state.global.creationFeeAmount()
        const curPerClaimFee = await tokenClient.state.global.perClaimFeeAmount()
        if (curCreationFee !== creationFee || curPerClaimFee !== perClaimFee) {
            console.log(`The per claim fee is:${curPerClaimFee} - do you really want to change it to:${perClaimFee} ?`)
            const yn = await prompts({
                type: 'confirm',
                name: 'value',
                message: 'Can you confirm?',
                initial: true,
            })
            if (!yn.value) {
                return
            }
            console.log(`changing per claim fee to ${perClaimFee}`)
            await tokenClient.send.changeFees({ args: { creationFee, perClaimFee } })
        }
    }
}

main()

import { run } from '@subsquid/batch-processor'
import { augmentBlock } from '@subsquid/fuel-objects'
import { DataSourceBuilder } from '@subsquid/fuel-stream'
import { TypeormDatabase } from '@subsquid/typeorm-store'
import { arrayify, hexlify, randomBytes } from 'fuels'

import { LogEntry } from './model'

const LOG_TYPES = new Set([6732614218709939873n, 12195664052085097644n])

// First we create a DataSource - the component that
// defines what data we need and where to get it
const dataSource = new DataSourceBuilder()
  // Provide a Subsquid Network Gateway URL
  .setGateway('https://v2.archive.subsquid.io/network/fuel-mainnet')
  // Subsquid Network is always about 10000 blocks behind the head.
  // We must use a regular GraphQL endpoint to get through
  // the last mile and stay on top of the chain.
  // This is a limitation, and we promise to lift it in the future!
  .setGraphql({
    // url: 'https://fuel-mainnet.arcana.network/v1/graphql',
    url: 'https://mainnet.fuel.network/v1/graphql',
    strideConcurrency: 3,
    strideSize: 30
  })
  // Block data returned by the data source has the following structure:
  //
  // interface Block {
  //     header: BlockHeader
  //     receipts: Receipt[]
  //     transactions: Transaction[]
  //     inputs: Input[]
  //     outputs: Output[]
  // }
  //
  // For each block item we can specify a set of fields
  //  we want to fetch via the `.setFields()` method.
  // Think about it as of an SQL projection.
  //
  // Accurate selection of only the required fields
  // can have a notable positive impact on performance
  // when the data is sourced from Subsquid Network.
  //
  // We do it below only for illustration as all fields we've
  // selected are fetched by default.
  //
  // It is possible to override default selection by setting
  // the flags for undesirable fields to `false`.
  .setFields({
    receipt: {
      contract: true,
      receiptType: true,
      rb: true,
      data: true,
    }
  })
  // We request items via `.addXxx()` methods.
  //
  // Each `.addXxx()` method accepts item selection criteria
  // and also allows to request related items.
  .addReceipt({
    type: ['LOG_DATA'],
    transaction: true,
  })
  .build()

// Once we've prepared a data source we can start fetching the data right away:
//
// for await (let batch of dataSource.getBlockStream()) {
//     for (let block of batch) {
//         console.log(block)
//     }
// }
//
// However, Subsquid SDK can also help to transform and persist the data.

// Data processing in Subsquid SDK is defined by four components:
//
//  1. Data source (such as we've created above)
//  2. Database
//  3. Data handler
//  4. Processor
//
// Database is responsible for persisting the work progress (last processed block)
// and for providing storage API to the data handler.
//
// Data handler is a user defined function which accepts consecutive block batches,
// storage API and is responsible for entire data transformation.
//
// Processor connects and executes above three components.

// Below we create a `TypeormDatabase`.
//
// It provides restricted subset of [TypeORM EntityManager API](https://typeorm.io/working-with-entity-manager)
// as a persistent storage interface and works with any Postgres-compatible database.
//
// Note, that we don't pass any database connection parameters.
// That's because `TypeormDatabase` expects a certain project structure
// and environment variables to pick everything it needs by convention.
// Companion `@subsquid/typeorm-migration` tool works in the same way.
//
// For full configuration details please consult
// https://github.com/subsquid/squid-sdk/blob/278195bd5a5ed0a9e24bfb99ee7bbb86ff94ccb3/typeorm/typeorm-config/src/config.ts#L21
const database = new TypeormDatabase()

// Now we are ready to start processing the data
run(dataSource, database, async ctx => {
  console.log(`Got ${ctx.blocks.length} blocks`)
  const blocks = ctx.blocks.map(augmentBlock)
  const entries: LogEntry[] = []

  for (const block of blocks) {
    for (const receipt of block.receipts) {
      if (receipt.receiptType !== 'LOG_DATA' || receipt.contract == null || receipt.rb == null || receipt.data == null || receipt.transaction == null) {
        continue
      }
      if (!LOG_TYPES.has(receipt.rb)) {
        continue
      }
      entries.push(new LogEntry({
        id: hexlify(randomBytes(8)),
        txHash: arrayify(receipt.getTransaction().hash),
        foundAt: block.header.height,
        contract: arrayify(receipt.contract),
        rb: receipt.rb,
        data: arrayify(receipt.data)
      }))
    }
  }

  await ctx.store.insert(entries)
})

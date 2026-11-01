import 'dotenv/config'
import pg from 'pg'

import { resolveDatabaseConfig, toPgSsl } from '../config/database.js'

const { host, port, user, password, database: dbName, ssl } = resolveDatabaseConfig()
const connectionDefaults = { host, port, user, password, ssl: toPgSsl(ssl) }

async function createDatabase(): Promise<void> {
    const adminClient = new pg.Client({
        ...connectionDefaults,
        database: 'postgres',
    })
    await adminClient.connect()

    const result = await adminClient.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName])

    if (result.rowCount === 0) {
        await adminClient.query(`CREATE DATABASE "${dbName}"`)
        console.log(`Database "${dbName}" created successfully.`)
    } else {
        console.log(`Database "${dbName}" already exists.`)
    }

    await adminClient.end()

    const dbClient = new pg.Client({
        ...connectionDefaults,
        database: dbName,
    })
    await dbClient.connect()
    await dbClient.query('CREATE EXTENSION IF NOT EXISTS vector')
    console.log(`Extension "vector" ensured in database "${dbName}".`)
    await dbClient.end()
}

createDatabase().catch((err: unknown) => {
    console.error('Failed to create database:', err)
    process.exit(1)
})

import {
    pgTable,
    bigserial,
    bigint,
    varchar,
    boolean,
    timestamp,
    text,
    pgEnum,
    integer,
    index,
    unique,
    uniqueIndex,
    real,
    jsonb,
    customType,
} from 'drizzle-orm/pg-core'

import { EMBEDDING_COLUMN_DIMENSIONS } from './embedding-dimensions.js'
import { sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'

export const userRoleEnum = pgEnum('user_role', ['user', 'admin'])
export const pushNotificationStatusEnum = pgEnum('push_notification_status', [
    'SENT',
    'FAILED',
    'PENDING',
])
export const smsAuthChallengeFlowEnum = pgEnum('sms_auth_challenge_flow', [
    'register_phone',
    'reset_phone',
    'link_phone',
])
export const chatRoleEnum = pgEnum('chat_role', ['user', 'assistant'])
export const llmPromptTypeEnum = pgEnum('llm_prompt_type', [
    'SUPPORT_SYSTEM',
    'SUPPORT_FIRST_CHAT',
    'SUPPORT_QUERY_TRANSLATION',
])
export const llmTextFeatureEnum = pgEnum('llm_text_feature', [
    'PROMPT_TEST',
    'SUPPORT_CHAT',
    'SUPPORT_QUERY_TRANSLATION',
    'SUPPORT_EMBEDDING',
])
export const userAppTypeEnum = pgEnum('user_app_type', ['web', 'pwa'])
// feat-118: how a started provider call ended (ADR 0003, «Аудит викликів»).
export const llmTextUsageStatusEnum = pgEnum('llm_text_usage_status', [
    'completed',
    'aborted',
    'failed',
])

const vector1536 = customType<{ data: string | null; driverData: string | null }>({
    dataType() {
        return `vector(${String(EMBEDDING_COLUMN_DIMENSIONS)})`
    },
})

export const users = pgTable(
    'users',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        name: varchar('name', { length: 100 }).notNull(),
        email: varchar('email', { length: 255 }),
        emailVerifiedAt: timestamp('email_verified_at'),
        password: varchar('password', { length: 255 }),
        phone: varchar('phone', { length: 20 }).unique(),
        avatar: varchar('avatar', { length: 500 }),
        role: userRoleEnum('role').notNull().default('user'),
        sessionToken: varchar('session_token', { length: 24 })
            .notNull()
            .unique()
            .$defaultFn(() => nanoid()),
        createdAt: timestamp('created_at').notNull().defaultNow(),
        updatedAt: timestamp('updated_at')
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        uniqueIndex('users_email_unique_non_null_idx')
            .on(sql`LOWER(${table.email})`)
            .where(sql`${table.email} IS NOT NULL`),
    ],
)

export const userOnline = pgTable(
    'user_online',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        sessionId: varchar('session_id', { length: 255 }),
        socketUuid: varchar('socket_uuid', { length: 64 }).notNull().unique(),
        role: userRoleEnum('role'),
        ipAddress: varchar('ip_address', { length: 45 }),
        userAgent: text('user_agent'),
        typeApp: userAppTypeEnum('type_app'),
        connectedAt: timestamp('connected_at').notNull(),
        disconnectedAt: timestamp('disconnected_at'),
        connectionDurationMs: bigint('connection_duration_ms', { mode: 'number' }),
        closeCode: integer('close_code'),
        isFirstConnection: boolean('is_first_connection').notNull().default(false),
        isLastConnection: boolean('is_last_connection'),
        createdAt: timestamp('created_at').notNull().defaultNow(),
        updatedAt: timestamp('updated_at')
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index('user_online_user_id_idx').on(table.userId),
        index('user_online_user_id_connected_at_idx').on(table.userId, table.connectedAt),
        index('user_online_connected_at_idx').on(table.connectedAt),
        index('user_online_disconnected_at_idx').on(table.disconnectedAt),
    ],
)

export const pushSubscriptions = pgTable(
    'push_subscriptions',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        endpoint: varchar('endpoint', { length: 500 }).notNull().unique(),
        p256dhKey: text('p256dh_key').notNull(),
        authKey: text('auth_key').notNull(),
        userAgent: text('user_agent'),
        ipAddress: varchar('ip_address', { length: 45 }),
        isActive: boolean('is_active').notNull().default(true),
        createdAt: timestamp('created_at').notNull().defaultNow(),
        updatedAt: timestamp('updated_at')
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
        lastUsedAt: timestamp('last_used_at'),
        deviceType: varchar('device_type', { length: 50 }),
        browserName: varchar('browser_name', { length: 100 }),
        browserVersion: varchar('browser_version', { length: 50 }),
        osName: varchar('os_name', { length: 100 }),
        osVersion: varchar('os_version', { length: 50 }),
        // Validated on input as ('mention' | 'system')[] (shared/schemas/push-subscription).
        notificationTypes: jsonb('notification_types').$type<('mention' | 'system')[]>(),
        timezone: varchar('timezone', { length: 50 }),
    },
    (table) => [index('push_subscriptions_user_id_fkey').on(table.userId)],
)

export const pushNotificationLogs = pgTable(
    'push_notifications_log',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' }).references(() => users.id, {
            onDelete: 'set null',
        }),
        subscriptionId: bigint('subscription_id', { mode: 'bigint' }).references(
            () => pushSubscriptions.id,
            { onDelete: 'set null' },
        ),
        messageTitle: varchar('message_title', { length: 255 }),
        messageBody: text('message_body'),
        messageData: jsonb('message_data'),
        sentAt: timestamp('sent_at').notNull().defaultNow(),
        status: pushNotificationStatusEnum('status'),
        errorMessage: text('error_message'),
        // Written by push-notification-sender-service.ts.
        responseData: jsonb('response_data').$type<{ statusCode?: number | null } | null>(),
    },
    (table) => [
        index('push_notifications_log_user_id_fkey').on(table.userId),
        index('push_notifications_log_subscription_id_fkey').on(table.subscriptionId),
    ],
)

export const emailVerifications = pgTable(
    'email_verifications',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        tokenHash: varchar('token_hash', { length: 64 }).notNull(),
        expiresAt: timestamp('expires_at').notNull(),
        usedAt: timestamp('used_at'),
        createdAt: timestamp('created_at').notNull().defaultNow(),
    },
    (table) => [
        unique('email_verifications_token_hash_key').on(table.tokenHash),
        index('email_verifications_user_id_idx').on(table.userId),
    ],
)

export const emailLinkVerifications = pgTable(
    'email_link_verifications',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        targetEmail: varchar('target_email', { length: 255 }).notNull(),
        tokenHash: varchar('token_hash', { length: 64 }).notNull(),
        expiresAt: timestamp('expires_at').notNull(),
        usedAt: timestamp('used_at'),
        createdAt: timestamp('created_at').notNull().defaultNow(),
    },
    (table) => [
        unique('email_link_verifications_token_hash_key').on(table.tokenHash),
        index('email_link_verifications_user_id_idx').on(table.userId),
    ],
)

export const passwordResetTokens = pgTable(
    'password_reset_tokens',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        // The address the link was mailed to (feat-097): a reset that claims an unverified
        // account proves this address, and only while it is still the account's one.
        targetEmail: varchar('target_email', { length: 255 }),
        tokenHash: varchar('token_hash', { length: 64 }).notNull(),
        expiresAt: timestamp('expires_at').notNull(),
        usedAt: timestamp('used_at'),
        createdAt: timestamp('created_at').notNull().defaultNow(),
    },
    (table) => [
        unique('password_reset_tokens_token_hash_key').on(table.tokenHash),
        index('password_reset_tokens_user_id_idx').on(table.userId),
    ],
)

export const smsAuthChallenges = pgTable(
    'sms_auth_challenges',
    {
        id: varchar('id', { length: 24 })
            .primaryKey()
            .$defaultFn(() => nanoid()),
        flow: smsAuthChallengeFlowEnum('flow').notNull(),
        phone: varchar('phone', { length: 20 }).notNull(),
        codeHash: varchar('code_hash', { length: 255 }).notNull(),
        providerRequestId: varchar('provider_request_id', { length: 100 }),
        metadata: jsonb('metadata').$type<Record<string, unknown> | null>().default(null),
        attemptCount: integer('attempt_count').notNull().default(0),
        resendAvailableAt: timestamp('resend_available_at').notNull(),
        expiresAt: timestamp('expires_at').notNull(),
        confirmedAt: timestamp('confirmed_at'),
        invalidatedAt: timestamp('invalidated_at'),
        createdAt: timestamp('created_at').notNull().defaultNow(),
        updatedAt: timestamp('updated_at')
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index('sms_auth_challenges_phone_flow_idx').on(table.phone, table.flow),
        index('sms_auth_challenges_expires_at_idx').on(table.expiresAt),
    ],
)

export const oauthAccounts = pgTable(
    'oauth_accounts',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        provider: varchar('provider', { length: 50 }).notNull(),
        providerUserId: varchar('provider_user_id', { length: 255 }).notNull(),
        providerEmail: varchar('provider_email', { length: 255 }),
        providerName: varchar('provider_name', { length: 255 }),
        providerAvatar: varchar('provider_avatar', { length: 500 }),
        createdAt: timestamp('created_at').notNull().defaultNow(),
        updatedAt: timestamp('updated_at')
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        unique('oauth_accounts_provider_provider_user_id_key').on(
            table.provider,
            table.providerUserId,
        ),
        index('oauth_accounts_user_id_fkey').on(table.userId),
    ],
)

/**
 * feat-097: a pending link of an OAuth identity to an existing account, confirmed by a
 * mailed one-time link. The provider's profile is kept so the link can be created on
 * confirmation; the provider's tokens are not. The confirmation must come from the browser
 * session that started the sign-in (`session_binding_hash`).
 */
export const oauthLinkVerifications = pgTable(
    'oauth_link_verifications',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        provider: varchar('provider', { length: 50 }).notNull(),
        providerUserId: varchar('provider_user_id', { length: 255 }).notNull(),
        providerEmail: varchar('provider_email', { length: 255 }).notNull(),
        providerName: varchar('provider_name', { length: 255 }),
        providerAvatar: varchar('provider_avatar', { length: 500 }),
        // The account's address when the link was issued: confirmed only while it is unchanged.
        targetEmail: varchar('target_email', { length: 255 }).notNull(),
        sessionBindingHash: varchar('session_binding_hash', { length: 64 }).notNull(),
        tokenHash: varchar('token_hash', { length: 64 }).notNull(),
        expiresAt: timestamp('expires_at').notNull(),
        usedAt: timestamp('used_at'),
        createdAt: timestamp('created_at').notNull().defaultNow(),
    },
    (table) => [
        unique('oauth_link_verifications_token_hash_key').on(table.tokenHash),
        index('oauth_link_verifications_user_id_provider_idx').on(table.userId, table.provider),
    ],
)

export const llmSystemPrompts = pgTable('llm_system_prompts', {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    type: llmPromptTypeEnum('type').notNull().unique(),
    topic: varchar('topic', { length: 100 }),
    content: text('content').notNull(),
    model: varchar('model', { length: 100 }),
    temperature: real('temperature'),
    maxTokens: integer('max_tokens'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at')
        .notNull()
        .defaultNow()
        .$onUpdate(() => new Date()),
})

export const llmTextUsage = pgTable(
    'llm_text_usage',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        // NULL for system calls without a user (knowledge-base indexing), and for the rows of a
        // deleted user: the usage log is an audit of tokens and cost, which outlives the account
        // (owner decision, feat-081). The row then has no link to a person; what is left of a
        // prompt is removed by `llm:purge-prompts` by age, user or not.
        userId: bigint('user_id', { mode: 'bigint' }).references(() => users.id, {
            onDelete: 'set null',
        }),
        llmSystemPromptId: bigint('llm_system_prompt_id', { mode: 'bigint' }).references(
            () => llmSystemPrompts.id,
            { onDelete: 'set null' },
        ),
        model: varchar('model', { length: 100 }).notNull(),
        feature: llmTextFeatureEnum('feature').notNull(),
        // The prompt text: empty unless AI_USAGE_STORE_PROMPTS=true (feat-065), and emptied
        // again by `llm:purge-prompts`. The hash and the length survive either way.
        finalPrompt: text('final_prompt').notNull().default(''),
        // SHA-256 (hex) of the prompt and its length in characters. NULL for rows written
        // before they existed whose text has not been purged yet.
        promptSha256: varchar('prompt_sha256', { length: 64 }),
        promptChars: integer('prompt_chars'),
        // NULL = unknown; 0 is a real zero. Since feat-118 a call without reported usage gets an
        // estimate with tokens_estimated = true; NULL stays for rows written before.
        promptTokens: integer('prompt_tokens'),
        completionTokens: integer('completion_tokens'),
        totalTokens: integer('total_tokens'),
        // feat-118: every started call has a row, however it ended. The status and the origin of
        // the tokens are independent: an aborted call can have real tokens (reported before the
        // abort), and a completed one an estimate (the provider reported nothing).
        status: llmTextUsageStatusEnum('status').notNull().default('completed'),
        tokensEstimated: boolean('tokens_estimated').notNull().default(false),
        createdAt: timestamp('created_at').notNull().defaultNow(),
    },
    (table) => [
        index('llm_text_usage_user_id_fkey').on(table.userId),
        index('llm_text_usage_prompt_id_idx').on(table.llmSystemPromptId),
        index('llm_text_usage_created_at_idx').on(table.createdAt),
    ],
)

export const supportKnowledgeBase = pgTable(
    'support_knowledge_base',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        title: varchar('title', { length: 255 }).notNull(),
        content: text('content').notNull(),
        category: varchar('category', { length: 100 }),
        embedding: vector1536('embedding'),
        screenshotKey: varchar('screenshot_key', { length: 500 }),
        screenshotMime: varchar('screenshot_mime', { length: 50 }),
        // feat-114 (R11b): the version of title + content. The UPDATE that changes the text bumps
        // it and clears the embedding; a vector is stored only for the version it was made from.
        contentVersion: integer('content_version').notNull().default(1),
        isActive: boolean('is_active').notNull().default(true),
        createdAt: timestamp('created_at').notNull().defaultNow(),
        updatedAt: timestamp('updated_at')
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [index('support_kb_category_idx').on(table.category)],
)

export const supportChatHistory = pgTable(
    'support_chat_history',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        role: chatRoleEnum('role').notNull(),
        content: text('content').notNull(),
        screenshots: jsonb('screenshots'),
        // The id the client gave a user message. A resend of the same message carries the
        // same id, so one message is stored once. Null for assistant rows and for messages
        // from a client that sends no id (several NULLs do not collide in a unique index).
        clientMessageId: varchar('client_message_id', { length: 64 }),
        createdAt: timestamp('created_at').notNull().defaultNow(),
    },
    (table) => [
        // The history of one user, newest first (the chat loads the tail); the leading user_id
        // also serves every lookup by user alone.
        index('support_chat_history_user_created_idx').on(table.userId, table.createdAt),
        uniqueIndex('support_chat_history_client_message_uidx').on(
            table.userId,
            table.clientMessageId,
        ),
    ],
)

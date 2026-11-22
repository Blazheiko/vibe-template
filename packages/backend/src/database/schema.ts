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
    smallint,
    check,
    uuid,
    primaryKey,
    bytea,
} from 'drizzle-orm/pg-core'

import { EMBEDDING_COLUMN_DIMENSIONS } from './embedding-dimensions.js'
import { sql, type SQL } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { COLOR_THEMES, FONT_SIZE_MAX, FONT_SIZE_MIN, THEMES } from 'shared/enums'
import { AUDIT_ACTOR_KINDS } from 'shared/audit'
import { ROLES } from 'shared/access'
import {
    NOTIFICATION_CATEGORIES,
    NOTIFICATION_CHANNELS,
    NOTIFICATION_KIND_NAMES,
} from 'shared/notifications'

// feat-240 (Р3): the roles of the catalog in shared/access, in its order.
export const userRoleEnum = pgEnum('user_role', ROLES)
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
export const auditActorKindEnum = pgEnum('audit_actor_kind', AUDIT_ACTOR_KINDS)
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
        // feat-246 (Р6): the WebAuthn user.id of the account's passkeys: 32 random bytes made with
        // the first passkey, never the user id or the email. NULL until then.
        webauthnUserHandle: bytea('webauthn_user_handle').unique(),
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
        // feat-240 (Р3, Р6 rule 3): a staff role only on an account with a verified email. An
        // unverified account can be claimed by the owner of its address (claimLocked keeps the
        // role), so a role given before the verification would move with the account.
        check(
            'users_staff_role_verified_email',
            sql`${table.role} = 'user' OR ${table.emailVerifiedAt} IS NOT NULL`,
        ),
    ],
)

const sqlStringList = (values: readonly string[]): SQL =>
    sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', '))

/**
 * The interface preferences of a user (feat-232, Р1): one row per user, created by the first
 * PATCH /account/profile. A NULL preference is "no choice": the client shows its default (Р2).
 * Kept out of `users`, whose row every session check reads. `revision` grows by one with every
 * profile change, the name included (Р12); it has no default, the upsert always sets it.
 */
export const userPreferences = pgTable(
    'user_preferences',
    {
        userId: bigint('user_id', { mode: 'bigint' })
            .primaryKey()
            .references(() => users.id, { onDelete: 'cascade' }),
        locale: varchar('locale', { length: 8 }),
        timeZone: varchar('time_zone', { length: 64 }),
        theme: varchar('theme', { length: 16 }),
        colorTheme: varchar('color_theme', { length: 32 }),
        fontSize: smallint('font_size'),
        revision: bigint('revision', { mode: 'bigint' }).notNull(),
        updatedAt: timestamp('updated_at').notNull().defaultNow(),
    },
    (table) => [
        check('user_preferences_theme_check', sql`${table.theme} IN (${sqlStringList(THEMES)})`),
        check(
            'user_preferences_color_theme_check',
            sql`${table.colorTheme} IN (${sqlStringList(COLOR_THEMES)})`,
        ),
        check(
            'user_preferences_font_size_check',
            sql`${table.fontSize} BETWEEN ${sql.raw(String(FONT_SIZE_MIN))} AND ${sql.raw(String(FONT_SIZE_MAX))}`,
        ),
        check('user_preferences_revision_check', sql`${table.revision} >= 1`),
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

// feat-236 (Р1): the notifications of a user, stored before any push. The text is built by the
// client from `kind` and `params`; `link` is a relative path of the application (Р7).
export const notifications = pgTable(
    'notifications',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        category: varchar('category', { length: 32 }).notNull(),
        kind: varchar('kind', { length: 64 }).notNull(),
        params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
        link: varchar('link', { length: 512 }),
        createdAt: timestamp('created_at').notNull().defaultNow(),
        readAt: timestamp('read_at'),
    },
    (table) => [
        index('notifications_user_id_id_idx').on(table.userId, table.id.desc()),
        index('notifications_user_unread_idx')
            .on(table.userId, table.id.desc())
            .where(sql`${table.readAt} IS NULL`),
        index('notifications_created_at_idx').on(table.createdAt),
        check(
            'notifications_category_check',
            sql`${table.category} IN (${sqlStringList(NOTIFICATION_CATEGORIES)})`,
        ),
        check(
            'notifications_kind_check',
            sql`${table.kind} IN (${sqlStringList(NOTIFICATION_KIND_NAMES)})`,
        ),
        check('notifications_link_check', sql`${table.link} IS NULL OR ${table.link} LIKE '/%'`),
    ],
)

// feat-236 (Р4): a channel of a category the user changed. No row: the default of the catalog.
export const notificationPreferences = pgTable(
    'notification_preferences',
    {
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        category: varchar('category', { length: 32 }).notNull(),
        channel: varchar('channel', { length: 16 }).notNull(),
        enabled: boolean('enabled').notNull(),
        updatedAt: timestamp('updated_at').notNull().defaultNow(),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.category, table.channel] }),
        check(
            'notification_preferences_category_check',
            sql`${table.category} IN (${sqlStringList(NOTIFICATION_CATEGORIES)})`,
        ),
        check(
            'notification_preferences_channel_check',
            sql`${table.channel} IN (${sqlStringList(NOTIFICATION_CHANNELS)})`,
        ),
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
        index('email_verifications_expires_at_idx').on(table.expiresAt),
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
        index('email_link_verifications_expires_at_idx').on(table.expiresAt),
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
        index('password_reset_tokens_expires_at_idx').on(table.expiresAt),
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
        index('oauth_link_verifications_expires_at_idx').on(table.expiresAt),
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
    // feat-235 (review): the version of the row, raised by every UPDATE under its row lock. The
    // prompt cache of each instance keeps the row of the highest revision it has seen, whether it
    // came from its own edit or from a reload: an answer that comes back late cannot replace a
    // newer row (another instance's edit included).
    revision: bigint('revision', { mode: 'number' }).notNull().default(1),
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
        // feat-224: the rows that still hold prompt text, by age then id: the retention job walks
        // it with a keyset cursor, so a batch reads only the next entries.
        index('llm_text_usage_prompt_text_created_at_idx')
            .on(table.createdAt, table.id)
            .where(sql`${table.finalPrompt} <> ''`),
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

// feat-235 (Р1, Р2, Р8): the audit log. Rows are only inserted (a trigger of the migration refuses
// UPDATE) and deleted by the retention job. The user ids have no foreign key: an entry outlives
// the account it names. `occurred_at` has no default: every event is stamped with
// clock_timestamp() taken after the row lock of its change, so a forgotten stamp fails the insert
// instead of falling back to the start of the transaction. No IP, e-mail, phone or session id.
export const auditEvents = pgTable(
    'audit_events',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        occurredAt: timestamp('occurred_at', { precision: 6 }).notNull(),
        actorKind: auditActorKindEnum('actor_kind').notNull(),
        actorUserId: bigint('actor_user_id', { mode: 'bigint' }),
        actorRole: userRoleEnum('actor_role'),
        action: varchar('action', { length: 64 }).notNull(),
        targetType: varchar('target_type', { length: 32 }).notNull(),
        targetId: varchar('target_id', { length: 64 }).notNull(),
        targetUserId: bigint('target_user_id', { mode: 'bigint' }),
        requestId: uuid('request_id'),
        changes: jsonb('changes'),
        metadata: jsonb('metadata'),
    },
    // DESC NULLS FIRST is what a plain `ORDER BY occurred_at DESC, id DESC` asks for, so the list
    // reads an index in its order; the retention job reads the first one backwards.
    (table) => [
        // The feed, the cursor and the retention job.
        index('audit_events_occurred_at_idx').on(
            table.occurredAt.desc().nullsFirst(),
            table.id.desc().nullsFirst(),
        ),
        index('audit_events_target_user_idx').on(
            table.targetUserId,
            table.occurredAt.desc().nullsFirst(),
            table.id.desc().nullsFirst(),
        ),
        index('audit_events_actor_user_idx').on(
            table.actorUserId,
            table.occurredAt.desc().nullsFirst(),
            table.id.desc().nullsFirst(),
        ),
        index('audit_events_target_idx').on(
            table.targetType,
            table.targetId,
            table.occurredAt.desc().nullsFirst(),
            table.id.desc().nullsFirst(),
        ),
        index('audit_events_action_idx').on(
            table.action,
            table.occurredAt.desc().nullsFirst(),
            table.id.desc().nullsFirst(),
        ),
        index('audit_events_request_id_idx')
            .on(table.requestId)
            .where(sql`${table.requestId} IS NOT NULL`),
    ],
)

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7, Р9): the TOTP factor of a user. One per user; a
// replacement is a new row (a new `id`, the version the second step and the recovery session
// name), written in the same transaction that deletes the previous one. `enrollment_id` makes the
// confirmation idempotent. The secret is sealed by app/services/shared/secret-box.ts with the user
// id as associated data.
export const totpFactors = pgTable(
    'totp_factors',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        enrollmentId: varchar('enrollment_id', { length: 32 }).notNull(),
        secretCiphertext: bytea('secret_ciphertext').notNull(),
        keyId: varchar('key_id', { length: 16 }).notNull(),
        /** The last 30-second step a code of this version was accepted for (replay guard). */
        lastUsedStep: bigint('last_used_step', { mode: 'bigint' }).notNull(),
        confirmedAt: timestamp('confirmed_at').notNull(),
        createdAt: timestamp('created_at').notNull().defaultNow(),
    },
    (table) => [
        unique('totp_factors_user_id_unique').on(table.userId),
        unique('totp_factors_enrollment_id_unique').on(table.enrollmentId),
    ],
)

// feat-245 (Р8): the one-time recovery codes of a user, as HMAC-SHA256 with AUTH_OTP_HMAC_KEY.
// A regeneration voids the whole previous batch.
export const mfaRecoveryCodes = pgTable(
    'mfa_recovery_codes',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        codeHash: varchar('code_hash', { length: 64 }).notNull(),
        batchId: varchar('batch_id', { length: 21 }).notNull(),
        usedAt: timestamp('used_at'),
        createdAt: timestamp('created_at').notNull().defaultNow(),
    },
    (table) => [
        unique('mfa_recovery_codes_user_code_unique').on(table.userId, table.codeHash),
        index('mfa_recovery_codes_unused_idx')
            .on(table.userId)
            .where(sql`${table.usedAt} IS NULL`),
    ],
)

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6, Р9): the passkeys of a user. `enrollment_id` makes
// the registration idempotent (a repeat after the commit returns the same key); `sign_count` only
// grows (0 means the authenticator keeps no counter).
export const webauthnCredentials = pgTable(
    'webauthn_credentials',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        userId: bigint('user_id', { mode: 'bigint' })
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        credentialId: bytea('credential_id').notNull(),
        publicKey: bytea('public_key').notNull(),
        signCount: bigint('sign_count', { mode: 'bigint' })
            .notNull()
            .default(sql`0`),
        transports: text('transports').array(),
        aaguid: uuid('aaguid'),
        deviceType: varchar('device_type', { length: 16 }).notNull(),
        backedUp: boolean('backed_up').notNull(),
        name: varchar('name', { length: 64 }).notNull(),
        enrollmentId: varchar('enrollment_id', { length: 32 }).notNull(),
        createdAt: timestamp('created_at').notNull().defaultNow(),
        lastUsedAt: timestamp('last_used_at'),
    },
    (table) => [
        unique('webauthn_credentials_credential_id_unique').on(table.credentialId),
        unique('webauthn_credentials_enrollment_id_unique').on(table.enrollmentId),
        index('webauthn_credentials_user_id_idx').on(table.userId),
    ],
)

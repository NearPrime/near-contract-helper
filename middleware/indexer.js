const { Pool } = require('pg');
const Cache = require('node-cache');

const BRIDGE_TOKEN_FACTORY_ACCOUNT_ID = process.env.BRIDGE_TOKEN_FACTORY_ACCOUNT_ID || 'factory.bridge.near';
const WALLET_URL = process.env.WALLET_URL;

// TODO: Replace with `NETWORK_ID` environment var check when we have one
const IS_MAINNET = WALLET_URL.includes('wallet.near.org');

const pool = new Pool({ connectionString: process.env.INDEXER_DB_CONNECTION, });

let poolMatch;

if (IS_MAINNET) {
    poolMatch = JSON.stringify(['%.poolv1.near', '%.pool.near']).replace(/"/g, '\'');
} else {
    poolMatch = JSON.stringify(['%.pool.%.m0', '%.factory01.littlefarm.testnet', '%.factory.colorpalette.testnet']).replace(/"/g, '\'');
}

const findStakingDeposits = async (ctx) => {
    const { accountId } = ctx.params;

    const { rows } = await pool.query(`
        with deposit_in as (
            select SUM(to_number(args ->> 'deposit', '99999999999999999999999999999999999999')) deposit,
                receipt_receiver_account_id validator_id
            from action_receipt_actions
            where
                action_kind = 'FUNCTION_CALL' and
                args ->> 'method_name' like 'deposit%' and
                receipt_predecessor_account_id = $1 and
                receipt_receiver_account_id like ANY(ARRAY${poolMatch})
            group by receipt_receiver_account_id
        ), deposit_out as (
            select SUM(to_number(args ->> 'deposit', '99999999999999999999999999999999999999')) deposit,
                receipt_predecessor_account_id validator_id
            from action_receipt_actions
            where
                action_kind = 'TRANSFER' and
                receipt_receiver_account_id = $1 and
                receipt_predecessor_account_id like ANY(ARRAY${poolMatch})
            group by receipt_predecessor_account_id
        )
        select sum(deposit_in.deposit - coalesce(deposit_out.deposit, 0)) deposit, deposit_in.validator_id
        from deposit_in
        left join deposit_out on deposit_in.validator_id = deposit_out.validator_id
        group by deposit_in.validator_id;
    `, [accountId]);

    ctx.body = rows;
};

const findAccountActivity = async (ctx) => {
    const { accountId } = ctx.params;

    let { limit = 10 } = ctx.request.query;
    if (limit > 100) {
        limit = 100;
    }

    const { rows } = await pool.query(
        `
        with predecessor_receipts as (
            select  receipt_id
                ,   index_in_action_receipt as action_index
                ,   receipt_included_in_block_timestamp
                ,   action_kind
                ,   args
            from action_receipt_actions
            where receipt_predecessor_account_id = $1
            order by receipt_included_in_block_timestamp desc
            limit $2
        ), receiver_receipts as (
            select  receipt_id
                ,   index_in_action_receipt
                ,   receipt_included_in_block_timestamp
                ,   action_kind
                ,   args
            from action_receipt_actions
            where receipt_receiver_account_id = $1
                and receipt_predecessor_account_id != 'system'
            order by receipt_included_in_block_timestamp desc
            limit $2
        ), account_receipts as (
            select *
            from predecessor_receipts

            union

            select *
            from receiver_receipts
        )
        select  r.included_in_block_hash as block_hash
            ,   r.included_in_block_timestamp as block_timestamp
            ,   r.originated_from_transaction_hash as hash
            ,   ar.action_index
            ,   r.predecessor_account_id as signer_id
            ,   r.receiver_account_id as receiver_id
            ,   ar.action_kind
            ,   ar.args
        from account_receipts as ar
        join receipts as r
            on r.receipt_id = ar.receipt_id
        order by ar.receipt_included_in_block_timestamp desc
        limit $2
        ;
    `, [accountId, limit]);

    ctx.body = rows;
};

const findAccountsByPublicKey = async (ctx) => {
    const { publicKey } = ctx.params;
    const { rows } = await pool.query(`
        SELECT DISTINCT account_id
        FROM access_keys
        JOIN accounts USING (account_id)
        WHERE public_key = $1
            AND accounts.deleted_by_receipt_id IS NULL
            AND access_keys.deleted_by_receipt_id IS NULL
    `, [publicKey]);
    ctx.body = rows.map(({ account_id }) => account_id);
};

const findReceivers = async (ctx) => {
    const { accountId } = ctx.params;

    const { rows } = await pool.query(`
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where receipt_predecessor_account_id = $1
            and action_kind = 'FUNCTION_CALL'
    `, [accountId]);
    ctx.body = rows.map(({ receiver_account_id }) => receiver_account_id);
};

const findLikelyTokens = async (ctx) => {
    const { accountId } = ctx.params;

    const received = `
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where args->'args_json'->>'receiver_id' = $1
            and action_kind = 'FUNCTION_CALL'
            and args->>'args_json' is not null
            and args->>'method_name' in ('ft_transfer', 'ft_transfer_call','ft_mint')
    `;

    const mintedWithBridge = `
        select distinct receipt_receiver_account_id as receiver_account_id from (
            select args->'args_json'->>'account_id' as account_id, receipt_receiver_account_id
            from action_receipt_actions
            where action_kind = 'FUNCTION_CALL' and
                receipt_predecessor_account_id = $2 and
                args->>'method_name' = 'mint'
        ) minted_with_bridge
        where account_id = $1
    `;

    const calledByUser = `
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where receipt_predecessor_account_id = $1
            and action_kind = 'FUNCTION_CALL'
            and (args->>'method_name' like 'ft_%' or args->>'method_name' = 'storage_deposit')
    `;

    const ownershipChangeEvents = `
        select distinct emitted_by_contract_account_id as receiver_account_id 
        from assets__fungible_token_events
        where token_new_owner_account_id = $1
    `;

    const { rows } = await pool.query([received, mintedWithBridge, calledByUser, ownershipChangeEvents].join(' union '), [accountId, BRIDGE_TOKEN_FACTORY_ACCOUNT_ID]);
    ctx.body = rows.map(({ receiver_account_id }) => receiver_account_id);
};


const findLikelyNFTs = async (ctx) => {
    const { accountId } = ctx.params;

    const ownershipChangeFunctionCalls = `
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where args->'args_json'->>'receiver_id' = $1
            and action_kind = 'FUNCTION_CALL'
            and args->>'args_json' is not null
            and args->>'method_name' like 'nft_%'
    `;

    const ownershipChangeEvents = `
        select distinct emitted_by_contract_account_id as receiver_account_id 
        from assets__non_fungible_token_events
        where token_new_owner_account_id = $1
    `;

    const { rows } = await pool.query([ownershipChangeFunctionCalls, ownershipChangeEvents].join(' union '), [accountId]);
    ctx.body = rows.map(({ receiver_account_id }) => receiver_account_id);
};


// One hour cache window since validators do not change often
const validatorCache = new Cache({ stdTTL: 60, checkperiod: 0, useClones: false });

async function fetchAndCacheValidators(cache) {
    const { rows: validatorDetails } = await pool.query(`SELECT account_id FROM accounts WHERE account_id LIKE ANY(ARRAY${poolMatch})`);

    const validators = validatorDetails.map((v) => v.account_id);
    cache.set('validators', validators);

    return validators;
}

async function findStakingPools(ctx) {
    ctx.body = validatorCache.get('validators') || await fetchAndCacheValidators(validatorCache);
}

module.exports = {
    findStakingDeposits,
    findAccountActivity,
    findAccountsByPublicKey,
    findReceivers,
    findLikelyTokens,
    findLikelyNFTs,
    findStakingPools
};

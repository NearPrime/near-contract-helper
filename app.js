const Koa = require('koa');
const app = new Koa();

const body = require('koa-json-body');
const cors = require('@koa/cors');
const httpErrors = require('http-errors');

app.use(require('koa-logger')());
app.use(body({ limit: '500kb', fallback: true }));
app.use(cors({ credentials: true }));

// Middleware to passthrough HTTP errors from node
app.use(async function(ctx, next) {
    try {
        await next();
    } catch(e) {
        if (e.response) {
            ctx.throw(e.response.status, e.response.text);
        }

        if (
            e instanceof httpErrors.Forbidden ||
            e instanceof httpErrors.NotFound ||
            e instanceof httpErrors.BadRequest
        ) {
            ctx.throw(e);
        }

        // TODO: Figure out which errors should be exposed to user
        console.error('Error: ', e, JSON.stringify(e));
        ctx.throw(400, e.toString());
    }
});

const Router = require('koa-router');
const router = new Router();

const creatorKeyJson = JSON.parse(process.env.ACCOUNT_CREATOR_KEY);
const recoveryKeyJson = JSON.parse(process.env.ACCOUNT_RECOVERY_KEY);
const keyStore = {
    async getKey(networkId, accountId) {
        if (accountId === creatorKeyJson.account_id) {
            return KeyPair.fromString(creatorKeyJson.secret_key || creatorKeyJson.private_key);
        }
        // For account recovery purposes use recovery key when updating any account
        return KeyPair.fromString(recoveryKeyJson.secret_key || creatorKeyJson.private_key);
    }
};
const { connect, KeyPair } = require('nearlib');
const nearPromise = (async () => {
    const near = await connect({
        deps: { keyStore },
        masterAccount: creatorKeyJson.account_id,
        nodeUrl: process.env.NODE_URL
    });
    return near;
})();
app.use(async (ctx, next) => {
    ctx.near = await nearPromise;
    await next();
});

async function checkAccountOwnership(ctx, next) {
    const { accountId, blockNumber, blockNumberSigned } = ctx.request.body;
    const currentBlock = (await ctx.near.connection.provider.status()).sync_info.latest_block_height;
    const givenBlock = Number(blockNumber);

    if (givenBlock > currentBlock - 100 && givenBlock <= currentBlock) {
        const nearAccount = await ctx.near.account(accountId);
        if (await verifySignature(nearAccount, blockNumber, blockNumberSigned)) {
            await next();
            return;
        }
    }
    ctx.throw(403);
}

const NEW_ACCOUNT_AMOUNT = process.env.NEW_ACCOUNT_AMOUNT;

router.post('/account', async ctx => {
    const { newAccountId, newAccountPublicKey } = ctx.request.body;
    const masterAccount = await ctx.near.account(creatorKeyJson.account_id);
    ctx.body = await masterAccount.createAccount(newAccountId, newAccountPublicKey, NEW_ACCOUNT_AMOUNT);
});

const password = require('secure-random-password');
const models = require('./models');
const FROM_PHONE = process.env.TWILIO_FROM_PHONE;
const SECURITY_CODE_DIGITS = 6;

const sendSms = async ({ to, text }) => {
    if (process.env.NODE_ENV == 'production') {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const client = require('twilio')(accountSid, authToken);
        await client.messages
            .create({
                body: text,
                from: FROM_PHONE,
                to
            });
    } else {
        console.log('sendSms:', { to, text });
    }
};

const sendSecurityCode = async ({ phoneNumber, securityCode }) => {
    return sendSms({
        text: `Your NEAR Wallet security code is: ${securityCode}`,
        to: phoneNumber
    });
};

router.post('/account/:phoneNumber/:accountId/requestCode', async ctx => {
    const accountId = ctx.params.accountId;
    const phoneNumber = ctx.params.phoneNumber;

    const securityCode = password.randomPassword({ length: SECURITY_CODE_DIGITS, characters: password.digits });
    const [account] = await models.Account.findOrCreate({ where: { accountId, phoneNumber } });
    await account.update({ securityCode });
    // TODO: Add code expiration for improved security
    await sendSecurityCode(account);

    ctx.body = {};
});

const nacl = require('tweetnacl');
const crypto = require('crypto');
const bs58 = require('bs58');
const verifySignature = async (nearAccount, data, signedData) => {
    try {
        const hash = crypto.createHash('sha256').update(data).digest();
        const accessKeys = await nearAccount.getAccessKeys();
        return accessKeys.some(it => {
            const publicKey = it.public_key.replace('ed25519:', '');
            return nacl.sign.detached.verify(hash, Buffer.from(signedData, 'base64'), bs58.decode(publicKey));
        });
    } catch (e) {
        console.error(e);
        return false;
    }
};

// TODO: Different endpoints for setup and recovery
router.post('/account/:phoneNumber/:accountId/validateCode', async ctx => {
    const { phoneNumber, accountId } = ctx.params;
    const { securityCode, signature, publicKey } = ctx.request.body;

    const account = await models.Account.findOne({ where: { accountId, phoneNumber } });
    if (!account || !account.securityCode || account.securityCode != securityCode) {
        ctx.throw(401);
    }
    if (!account.confirmed) {
        const nearAccount = await ctx.near.account(accountId);
        const isSignatureValid = await verifySignature(nearAccount, securityCode, signature);
        if (!isSignatureValid) {
            ctx.throw(401);
        }
        await account.update({ securityCode: null, confirmed: true });
    } else {
        await (await ctx.near.account(accountId)).addKey(publicKey);
        await account.update({ securityCode: null });
    }

    ctx.body = {};
});

function recoveryMethodsFor(account) {
    return {
        email: account.email || null,
        emailAddedAt: account.emailAddedAt || null,
        phoneAddedAt: account.phoneAddedAt || null,
        phoneNumber: account.phoneNumber || null,
        phraseAddedAt: account.phraseAddedAt || null,
    };
}

router.post('/account/recoveryMethods', checkAccountOwnership, async ctx => {
    const { accountId } = ctx.request.body;
    const account = await models.Account.findOne({ where: { accountId } });
    ctx.body = recoveryMethodsFor(account || {});
});

const recoveryMethodUpdaters = {
    phone: account => account.update({ phoneNumber: null, phoneAddedAt: null }),
    email: account => account.update({ email: null, emailAddedAt: null }),
    phrase: account => account.update({ phraseAddedAt: null })
};

async function checkRecoveryMethod(ctx, next) {
    const { recoveryMethod } = ctx.request.body;
    const allRecoveryMethods = Object.keys(recoveryMethodUpdaters);
    if (allRecoveryMethods.includes(recoveryMethod)) {
        await next();
        return;
    }
    ctx.throw(400, `Given recoveryMethod '${recoveryMethod}' invalid; must be one of: ${allRecoveryMethods.join(', ')}`);
}

async function checkAccountInDB(ctx, next) {
    const { accountId } = ctx.request.body;
    const account = await models.Account.findOne({ where: { accountId } });
    if (account) {
        await next();
        return;
    }
    ctx.throw(404, `Could not find account with accountId: '${accountId}'`);
}

router.post('/account/deleteRecoveryMethod', checkRecoveryMethod, checkAccountInDB, checkAccountOwnership, async ctx => {
    const { accountId, recoveryMethod } = ctx.request.body;
    const account = await models.Account.findOne({ where: { accountId } });
    await recoveryMethodUpdaters[recoveryMethod](account);
    ctx.body = recoveryMethodsFor(account);
});

const sendMail = async (options) => {
    if (process.env.NODE_ENV == 'production') {
        const nodemailer = require('nodemailer');
        const transport = nodemailer.createTransport({
            host: process.env.MAIL_HOST,
            port: process.env.MAIL_PORT,
            auth: {
                user: process.env.MAIL_USER,
                pass: process.env.MAIL_PASSWORD
            }
        });
        return transport.sendMail({
            from: 'wallet@nearprotocol.com',
            ...options
        });
    } else {
        console.log('sendMail:', options);
    }
};

const WALLET_URL = process.env.WALLET_URL;
const sendRecoveryMessage = async ({ accountId, phoneNumber, email, seedPhrase }) => {
    const recoverUrl = `${WALLET_URL}/recover-with-link/${encodeURIComponent(accountId)}/${encodeURIComponent(seedPhrase)}`;
    if (phoneNumber) {
        await sendSms({
            text: `Your NEAR Wallet (${accountId}) recovery link is: ${recoverUrl}\nSave this message in a secure place to allow you to recover account.`,
            to: phoneNumber
        });
    } else if (email) {
        await sendMail({
            to: email,
            subject: `Important: Near Wallet Recovery Email for ${accountId}`,
            text:
`Hi ${accountId},

This email contains your NEAR Wallet account recovery link.

Keep this email safe, and DO NOT SHARE IT! We cannot resend this email.

Click below to recover your account.

${recoverUrl}
`,
            html:
`<p>Hi ${accountId},</p>

<p>This email contains your NEAR Wallet account recovery link.</p>

<p>Keep this email safe, and DO NOT SHARE IT! We cannot resend this email.</p>

<p>Click below to recover your account.</p>

<a href="${recoverUrl}">Recover Account</a>
`

        });
    } else {
        throw new Error(`Account ${accountId} has no contact information`);
    }
};

const { parseSeedPhrase } = require('near-seed-phrase');

router.post('/account/seedPhraseAdded', checkAccountOwnership, async ctx => {
    const { accountId } = ctx.request.body;
    const [ account ] = await models.Account.findOrCreate({ where: { accountId } });
    await account.update({ phraseAddedAt: new Date() });
    ctx.body = recoveryMethodsFor(account);
});

router.post('/account/sendRecoveryMessage', async ctx => {
    const { accountId, phoneNumber, email, seedPhrase } = ctx.request.body;

    // TODO: Validate phone or email

    // Verify that seed phrase is added to the account
    const { publicKey } = parseSeedPhrase(seedPhrase);
    const nearAccount = await ctx.near.account(accountId);
    const keys = await nearAccount.getAccessKeys();
    if (!keys.some(key => key.public_key === publicKey)) {
        ctx.throw(403, 'seed phrase doesn\'t match any access keys');
    }

    const [account] = await models.Account.findOrCreate({ where: { accountId } });

    if (phoneNumber) {
        await account.update({ phoneNumber, phoneAddedAt: new Date() });
    }

    if (email) {
        await account.update({ email, emailAddedAt: new Date() });
    }

    await sendRecoveryMessage({ ...account.dataValues, seedPhrase });

    ctx.body = {};
});

app
    .use(router.routes())
    .use(router.allowedMethods());

if (!module.parent) {
    app.listen(process.env.PORT);
} else {
    module.exports = app;
}

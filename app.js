
const Koa = require('koa');
const app = new Koa();

const body = require('koa-json-body');
const cors = require('@koa/cors');

app.use(require('koa-logger')());
// TODO: Check what limit means and set appropriate limit
app.use(body({ limit: '500kb', fallback: true }));
// TODO: Don't use CORS in production on studio.nearprotocol.com
app.use(cors({ credentials: true }));

// Middleware to passthrough HTTP errors from node
app.use(async function(ctx, next) {
    try {
        await next();
    } catch(e) {
        if (e.response) {
            console.log("e", e, "e.response", e. response);
            ctx.throw(e.response.status, e.response.text);
        }
        throw e;
    }
});

const Router = require('koa-router');
const router = new Router();

const superagent = require('superagent');

const { KeyPair, InMemoryKeyStore, SimpleKeyStoreSigner, LocalNodeConnection, NearClient, Near, Account } = require('nearlib');
const defaultSender = 'alice.near';
const rawKey = JSON.parse(require('fs').readFileSync(`./${defaultSender}.json`));
const defaultKey = new KeyPair(rawKey.public_key, rawKey.secret_key);
const keyStore = new InMemoryKeyStore();
keyStore.setKey(defaultSender, defaultKey);
const localNodeConnection = new LocalNodeConnection('http://localhost:3030');
const nearClient = new NearClient(new SimpleKeyStoreSigner(keyStore), localNodeConnection);
const near = new Near(nearClient);

const account = new Account(nearClient);
const NEW_ACCOUNT_AMOUNT = 100;

const base64ToIntArray = base64Str => {
    let data = Buffer.from(base64Str, 'base64');
    return Array.prototype.slice.call(data, 0);
};

const request = async (methodName, params) => {
    const response = await superagent
        .post(`http://localhost:3030/${methodName}`)
        .use(require('superagent-logger'))
        .send(params);
    return JSON.parse(response.text);
};

const viewAccount = async senderHash => {
    return await request('view_account', {
        account_id: senderHash,
    });
};

async function submitTransaction() {
    const response = await nearClient.submitTransaction.apply(nearClient, arguments);
    return near.waitForTransactionResult(response.hash);
}

router.post('/contract', async ctx => {
    const body = ctx.request.body;
    const sender = body.sender || defaultSender;
    ctx.body = await submitTransaction('deploy_contract', {
        originator: sender,
        contract_account_id: body.receiver,
        wasm_byte_array: base64ToIntArray(body.contract),
        public_key: defaultKey.publicKey
    });
});

router.post('/contract/:name/:methodName', async ctx => {
    const body = ctx.request.body;
    const sender = body.sender || defaultSender;
    const args = body.args || {};
    const serializedArgs =  Array.from(Buffer.from(JSON.stringify(args)));
    ctx.body = await submitTransaction('schedule_function_call', {
        // TODO(#5): Need to make sure that big ints are supported later
        amount: parseInt(body.amount) || 0,
        originator: sender,
        contract_account_id: ctx.params.name,
        method_name: ctx.params.methodName,
        args: serializedArgs
    });
});

router.post('/contract/view/:name/:methodName', async ctx => {
    const body = ctx.request.body;
    const args = body.args || {};
    const serializedArgs =  Array.from(Buffer.from(JSON.stringify(args)));
    const response = await request('call_view_function', {
        originator: defaultSender,
        contract_account_id: ctx.params.name,
        method_name: ctx.params.methodName,
        args: serializedArgs
    });
    ctx.body = JSON.parse(Buffer.from(response.result).toString());
});

router.get('/account/:name', async ctx => {
    ctx.body = await viewAccount(ctx.params.name);
});

/**
 * Create a new account. Generate a throw away account id (UUID).
 * Returns account name and public/private key.
 */
router.post('/account', async ctx => {
    // TODO: this is using alice account to create all accounts. We may want to change that.
    const body = ctx.request.body;
    const newAccountId = body.newAccountId;
    const newAccountPublicKey = body.newAccountPublicKey;
    const createAccountResponse =
        await account.createAccount(newAccountId, newAccountPublicKey, NEW_ACCOUNT_AMOUNT, defaultSender);
    const response = {
        account_id: newAccountId
    };
    ctx.body = response;
});

app
    .use(router.routes())
    .use(router.allowedMethods());

if (!module.parent) {
    app.listen(process.env.PORT || 3000);
} else {
    module.exports = app;
}

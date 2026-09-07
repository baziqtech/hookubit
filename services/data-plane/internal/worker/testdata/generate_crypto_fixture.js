// Generates a cross-language crypto interop fixture using the ACTUAL compiled
// control-plane CryptoService (apps/control-api/dist/common/crypto.service.js).
const path = require('path');
// Resolve the control plane relative to this file so the fixture can be
// regenerated from any checkout:
//   node services/data-plane/internal/worker/testdata/generate_crypto_fixture.js \
//     > services/data-plane/internal/worker/testdata/crypto_interop.json
const root = path.resolve(__dirname, '../../../../../apps/control-api');
const { CryptoService } = require(path.join(root, 'dist/common/crypto.service.js'));

const PRIMARY_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'); // 32 bytes
const RETIRED_KEY = Buffer.from('fedcba9876543210fedcba9876543210').toString('base64');

const config = {
  getOrThrow: (k) => ({ ENCRYPTION_KEY: PRIMARY_KEY }[k]),
  get: (k) => ({ ENCRYPTION_KEY_ID: 'k1', ENCRYPTION_KEYS_RETIRED: `k0:${RETIRED_KEY}` }[k]),
};

const svc = new CryptoService(config);

const ctx = { table: 'endpoint_secrets', id: 'eps_01J9ZQKX5T7WQ2N4M8B6C3D1EF', owner: 'ep_01J9ZQKX5T7WQ2N4M8B6C3D1AB' };
const plaintext = 'whsec_9f2c0a7e5b1d4c3f8a6e2b0d7c9f1a3e';
const envelope = svc.encrypt(plaintext, ctx);

// A second vector encrypted under the RETIRED key id, to prove keyring lookup.
const retiredSvc = new CryptoService({
  getOrThrow: () => RETIRED_KEY,
  get: (k) => ({ ENCRYPTION_KEY_ID: 'k0', ENCRYPTION_KEYS_RETIRED: '' }[k]),
});
const ctx2 = { table: 'endpoint_secrets', id: 'eps_01J9ZQKX5T7WQ2N4M8B6C3D1GH', owner: ctx.owner };
const plaintext2 = 'whsec_0011223344556677889900aabbccddeeff';
const envelope2 = retiredSvc.encrypt(plaintext2, ctx2);

// Round-trip check on the TS side so the fixture is self-consistent.
if (svc.decrypt(envelope, ctx) !== plaintext) throw new Error('TS round trip failed');
if (retiredSvc.decrypt(envelope2, ctx2) !== plaintext2) throw new Error('TS round trip 2 failed');

// A third vector for a DIFFERENT endpoint, so tests can exercise two endpoints
// with real, correctly-bound secrets.
const ctx3 = { table: 'endpoint_secrets', id: 'eps_01J9ZQKX5T7WQ2N4M8B6C3D1IJ', owner: 'ep_01J9ZQKX5T7WQ2N4M8B6C3D1CD' };
const plaintext3 = 'whsec_aabbccddeeff00112233445566778899';
const envelope3 = svc.encrypt(plaintext3, ctx3);
if (svc.decrypt(envelope3, ctx3) !== plaintext3) throw new Error('TS round trip 3 failed');

console.log(JSON.stringify({
  primary_key_b64: PRIMARY_KEY,
  retired_key_b64: RETIRED_KEY,
  vectors: [
    { kid: 'k1', context: ctx, plaintext, envelope },
    { kid: 'k0', context: ctx2, plaintext: plaintext2, envelope: envelope2 },
    { kid: 'k1', context: ctx3, plaintext: plaintext3, envelope: envelope3 },
  ],
}, null, 2));

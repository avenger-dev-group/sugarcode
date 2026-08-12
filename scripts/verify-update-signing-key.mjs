import { createPublicKey } from 'node:crypto';

export const decodeUpdatePublicKey = (encoded) => {
  if (!encoded) {
    throw new Error('SUGARCODE_UPDATE_PUBLIC_KEY_B64 is required.');
  }
  const pem = Buffer.from(encoded, 'base64').toString('utf8');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('The update public key must be an Ed25519 key.');
  }
  return pem;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  decodeUpdatePublicKey(process.env.SUGARCODE_UPDATE_PUBLIC_KEY_B64);
  console.log('Verified the SugarCode update public key.');
}

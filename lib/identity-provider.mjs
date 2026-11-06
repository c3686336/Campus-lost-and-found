import { randomInt, timingSafeEqual } from 'node:crypto';

/** Replace this provider with an institutional identity/email service without changing signup flows. */
export class IdentityVerifier {
  issueEmailChallenge(_email) { throw new Error('Not implemented'); }
  verifyEmailChallenge(_challenge, _code) { throw new Error('Not implemented'); }
  reviewDocument(_document, _approved) { throw new Error('Not implemented'); }
}

/** Demo only: exposes a one-time code in the response; document approval remains an administrator decision. */
export class DemoIdentityProvider extends IdentityVerifier {
  issueEmailChallenge(email) { return { email, code: String(randomInt(100000, 1000000)) }; }
  verifyEmailChallenge(challenge, code) {
    const a = Buffer.from(String(challenge.code));
    const b = Buffer.from(String(code));
    return a.length === b.length && timingSafeEqual(a, b);
  }
  reviewDocument(document, approved) { return Boolean(document && approved); }
}

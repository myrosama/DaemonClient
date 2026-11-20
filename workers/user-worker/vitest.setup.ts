import { webcrypto } from 'crypto';

if (typeof global !== 'undefined' && !('crypto' in global)) {
  (global as any).crypto = webcrypto;
}

if (typeof globalThis !== 'undefined' && !('crypto' in globalThis)) {
  (globalThis as any).crypto = webcrypto;
}

import { cloudflareSandbox } from '@flue/runtime/cloudflare';

// One kind of sandbox, run by FlueSandbox. The export name identifies its
// sandboxes, so keep it stable.
export const workspace = cloudflareSandbox();

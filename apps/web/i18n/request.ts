import { getRequestConfig } from 'next-intl/server';

// Single locale for v1 (MASTER_PLAN decision D10): English strings via next-intl, with the
// catalog already split so `ro`/`hu` can be added later without touching this wiring.
export const locale = 'en';

export default getRequestConfig(async () => ({
  locale,
  messages: (await import(`../messages/${locale}.json`)).default,
}));

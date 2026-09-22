import type { RelayType } from '@smartrelay/shared';

/**
 * Mirrors each module's `sampleInput()` in packages/engine (webhook_sms, email_api's default
 * output shape isn't a trigger sample the same way, chat_relay, calendar_bridge). Duplicated here
 * rather than imported because the real module objects pull in Node-only code (SafeHttpClient)
 * that cannot ship to the browser — see packages/engine/src/browser.ts.
 */
export const SAMPLE_PAYLOADS: Record<RelayType, unknown> = {
  webhook_sms: { customer: { name: 'Ana', phone: '0722123456' } },
  email_api: { fields: { Name: 'Ana', Order: '1042' }, meta: { subject: 'New order' } },
  chat_relay: { customer: { name: 'Ana' }, order: { id: 1042 } },
  calendar_bridge: {
    customer: { name: 'Ana' },
    booking: { start: '2026-03-01T10:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
  },
};

import type { RelayType } from '@smartrelay/shared';

export const RELAY_TYPE_LABELS: Record<RelayType, string> = {
  webhook_sms: 'Webhook → SMS',
  email_api: 'Email → API',
  chat_relay: 'Telegram / Discord',
  calendar_bridge: 'Calendar Bridge',
};

export const RELAY_TYPE_DESCRIPTIONS: Record<RelayType, string> = {
  webhook_sms: 'Turn a webhook into an SMS to your customer.',
  email_api: 'Turn an inbound email into a JSON POST to your API.',
  chat_relay: 'Post a message to a Telegram bot or Discord channel.',
  calendar_bridge: 'Create a Google Calendar event from a booking.',
};

/** Seeded, fixed prices (MASTER_PLAN section 6) — there is no admin UI to change them in v1. */
export const RELAY_TYPE_PRICE: Record<RelayType, string> = {
  webhook_sms: '€0.025',
  email_api: '€0.005',
  chat_relay: '€0.005',
  calendar_bridge: '€0.01',
};

export interface RelaySummary {
  id: string;
  name: string;
  type: RelayType;
  status: 'active' | 'inactive';
  ingestToken: string;
  configPublic: Record<string, unknown>;
  hasSecret: boolean;
  lastTriggeredAt: string | null;
  createdAt: string;
}

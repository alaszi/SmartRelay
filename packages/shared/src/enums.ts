import { z } from 'zod';

export const RELAY_TYPES = ['webhook_sms', 'email_api', 'chat_relay', 'calendar_bridge'] as const;
export type RelayType = (typeof RELAY_TYPES)[number];
export const relayTypeSchema = z.enum(RELAY_TYPES);

export const RELAY_STATUSES = ['active', 'inactive'] as const;
export type RelayStatus = (typeof RELAY_STATUSES)[number];
export const relayStatusSchema = z.enum(RELAY_STATUSES);

export const SMS_MODES = ['byo', 'managed'] as const;
export type SmsMode = (typeof SMS_MODES)[number];
export const smsModeSchema = z.enum(SMS_MODES);

export const PRICING_KINDS = ['relay_http', 'calendar_event', 'sms_dispatch'] as const;
export type PricingKind = (typeof PRICING_KINDS)[number];
export const pricingKindSchema = z.enum(PRICING_KINDS);

export const LEDGER_KINDS = ['topup', 'charge', 'adjustment', 'refund'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export const ledgerKindSchema = z.enum(LEDGER_KINDS);

export const EVENT_SOURCES = ['http', 'email', 'telegram_callback', 'test'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];
export const eventSourceSchema = z.enum(EVENT_SOURCES);

export const EVENT_STATUSES = [
  'RECEIVED',
  'QUEUED',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
  'HELD_NO_CREDIT',
  'EXPIRED',
  'DROPPED_LOOP',
  'REJECTED',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const eventStatusSchema = z.enum(EVENT_STATUSES);

export const PAYMENT_PROVIDERS = ['stripe'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];
export const paymentProviderSchema = z.enum(PAYMENT_PROVIDERS);

export const TOPUP_STATUSES = ['pending', 'paid', 'failed', 'expired'] as const;
export type TopupStatus = (typeof TOPUP_STATUSES)[number];
export const topupStatusSchema = z.enum(TOPUP_STATUSES);

export const OAUTH_PROVIDERS = ['google'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export const oauthProviderSchema = z.enum(OAUTH_PROVIDERS);

export const REMINDER_STATUSES = ['pending', 'sent', 'failed', 'cancelled'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
export const reminderStatusSchema = z.enum(REMINDER_STATUSES);

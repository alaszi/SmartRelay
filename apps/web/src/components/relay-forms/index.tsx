import type { RelayType } from '@smartrelay/shared';
import { CalendarBridgeForm } from './calendar-bridge-form';
import { ChatRelayForm } from './chat-relay-form';
import { EmailApiForm } from './email-api-form';
import type { RelayFormProps } from './shared';
import { WebhookSmsForm } from './webhook-sms-form';

export const RELAY_FORMS: Record<RelayType, (props: RelayFormProps) => React.JSX.Element> = {
  webhook_sms: WebhookSmsForm,
  email_api: EmailApiForm,
  chat_relay: ChatRelayForm,
  calendar_bridge: CalendarBridgeForm,
};

export type { RelayFormProps } from './shared';

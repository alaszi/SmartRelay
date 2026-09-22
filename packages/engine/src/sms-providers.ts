import type { SafeHttpClient } from './safe-http';

export interface SmsSendInput {
  /** E.164, already normalized (see phone.ts). */
  to: string;
  text: string;
  http: SafeHttpClient;
}

export type SmsSendResult =
  | {
      ok: true;
      statusCode: number;
      providerMessageId: string | undefined;
      request: unknown;
      response: unknown;
    }
  | {
      ok: false;
      retryable: boolean;
      errorCode: string;
      message: string;
      statusCode?: number;
      request?: unknown;
      response?: unknown;
    };

export interface SmsProvider<TCredentials> {
  name: string;
  send: (credentials: TCredentials, input: SmsSendInput) => Promise<SmsSendResult>;
}

// ---------------------------------------------------------------------------------------------
// SMSLink (smslink.ro): verified against smslink.ro's SMS Gateway (HTTP) documentation.
// Endpoint, required params (connection_id, password, to, message) and the "ERROR;<code>;<msg>"
// error format are confirmed there. The exact shape of a *successful* response is not published
// in the reachable docs (TODO(verify-docs)): any response that does not start with "ERROR;" is
// treated as success, and the raw text is kept as the response excerpt for evidence.
// ---------------------------------------------------------------------------------------------

export interface SmsLinkCredentials {
  connectionId: string;
  password: string;
}

// Error code 16 ("An error has occured during sending") reads as a generic transient failure;
// every other documented code is an account/config/input problem and will not fix itself on retry.
const SMSLINK_RETRYABLE_CODES = new Set(['16']);

export const smsLinkProvider: SmsProvider<SmsLinkCredentials> = {
  name: 'smslink',
  async send(credentials, input) {
    const url = new URL('https://secure.smslink.ro/sms/gateway/communicate/index.php');
    url.searchParams.set('connection_id', credentials.connectionId);
    url.searchParams.set('password', credentials.password);
    url.searchParams.set('to', input.to);
    url.searchParams.set('message', input.text);

    const response = await input.http.request({ url: url.toString(), method: 'GET' });
    const body = response.body.trim();

    if (body.startsWith('ERROR;')) {
      const [, code, message] = body.split(';');
      return {
        ok: false,
        retryable: SMSLINK_RETRYABLE_CODES.has(code ?? ''),
        errorCode: `SMSLINK_${code ?? 'UNKNOWN'}`,
        message: message ?? 'SMSLink returned an error',
        statusCode: response.status,
        response: body,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        retryable: response.status >= 500 || response.status === 429,
        errorCode: 'SMSLINK_HTTP_ERROR',
        message: `SMSLink answered HTTP ${response.status}`,
        statusCode: response.status,
        response: body,
      };
    }

    return {
      ok: true,
      statusCode: response.status,
      providerMessageId: undefined,
      request: undefined,
      response: body,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Twilio: verified against twilio.com/docs/sms/api/message-resource.
// ---------------------------------------------------------------------------------------------

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  from: string;
}

interface TwilioErrorBody {
  code?: number;
  message?: string;
}

export const twilioProvider: SmsProvider<TwilioCredentials> = {
  name: 'twilio',
  async send(credentials, input) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/Messages.json`;
    const body = new URLSearchParams({
      From: credentials.from,
      To: input.to,
      Body: input.text,
    }).toString();
    const auth = Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString(
      'base64',
    );

    const response = await input.http.request({
      url,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${auth}`,
      },
      body,
    });

    if (response.status >= 200 && response.status < 300) {
      let providerMessageId: string | undefined;
      try {
        providerMessageId = (JSON.parse(response.body) as { sid?: string }).sid;
      } catch {
        // Body isn't JSON as documented; the send still succeeded per the HTTP status.
      }
      return {
        ok: true,
        statusCode: response.status,
        providerMessageId,
        request: { to: input.to, from: credentials.from },
        response: response.body,
      };
    }

    let errorMessage = `Twilio answered HTTP ${response.status}`;
    let errorCode = 'TWILIO_HTTP_ERROR';
    try {
      const parsed = JSON.parse(response.body) as TwilioErrorBody;
      if (parsed.message) errorMessage = parsed.message;
      if (parsed.code !== undefined) errorCode = `TWILIO_${parsed.code}`;
    } catch {
      // Non-JSON error body; fall back to the generic message above.
    }

    return {
      ok: false,
      retryable: response.status >= 500 || response.status === 429,
      errorCode,
      message: errorMessage,
      statusCode: response.status,
      response: response.body,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Infobip: typed stub only (decision D2). No live docs were consulted and no network call is
// ever made; this exists so the config schema and UI can offer the option ahead of a real
// integration.
// ---------------------------------------------------------------------------------------------

export interface InfobipCredentials {
  apiKey: string;
  baseUrl: string;
}

export const infobipProvider: SmsProvider<InfobipCredentials> = {
  name: 'infobip',
  // eslint-disable-next-line @typescript-eslint/require-await
  async send() {
    return {
      ok: false,
      retryable: false,
      errorCode: 'PROVIDER_NOT_IMPLEMENTED',
      message: 'The Infobip SMS provider is not implemented yet',
    };
  },
};

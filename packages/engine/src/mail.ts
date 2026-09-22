import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Outbound email interface (MASTER_PLAN section 2 / D7). Postmark is a later swap-in. */
export interface Mailer {
  send: (message: MailMessage) => Promise<void>;
}

export function createSmtpMailer(options: { url: string; from: string }): Mailer {
  const transport: Transporter = nodemailer.createTransport(options.url);
  return {
    async send(message) {
      await transport.sendMail({ from: options.from, ...message });
    },
  };
}

export interface RecordingMailer extends Mailer {
  readonly sent: MailMessage[];
}

/** In-memory mailer for tests: records what would have been sent instead of sending it. */
export function createRecordingMailer(): RecordingMailer {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

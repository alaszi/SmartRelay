const MAILPIT_URL = process.env['PLAYWRIGHT_MAILPIT_URL'] ?? 'http://localhost:8025';

interface MailpitMessageSummary {
  ID: string;
}

interface MailpitMessage {
  Text: string;
}

/** Polls Mailpit (docker-compose.yml's dev SMTP catcher) for the newest email to `to`, and
 * returns its plain-text body. Verification/reset links are the only thing e2e tests need from
 * outbound mail, so this is the one helper both flows share. */
export async function latestEmailTextTo(to: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = (await fetch(`${MAILPIT_URL}/api/v1/messages`).then((r) => r.json())) as {
      messages: (MailpitMessageSummary & { To: { Address: string }[] })[];
    };
    const match = list.messages.find((m) => m.To.some((addr) => addr.Address === to));
    if (match) {
      const message = (await fetch(`${MAILPIT_URL}/api/v1/message/${match.ID}`).then((r) =>
        r.json(),
      )) as MailpitMessage;
      return message.Text;
    }
    if (Date.now() > deadline) {
      throw new Error(`No email to ${to} arrived in Mailpit within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Extracts the first http(s) URL from an email body (verify-email / reset-password links). */
export function firstLinkIn(text: string): string {
  const match = /https?:\/\/\S+/.exec(text);
  if (!match) throw new Error(`No URL found in email body: ${text}`);
  return match[0];
}

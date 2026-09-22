import { describe, expect, it } from 'vitest';
import { createRecordingMailer } from './mail';

describe('createRecordingMailer', () => {
  it('records every message sent through it, in order', async () => {
    const mailer = createRecordingMailer();

    await mailer.send({ to: 'a@example.com', subject: 'Hi', text: 'first' });
    await mailer.send({
      to: 'b@example.com',
      subject: 'Hi',
      text: 'second',
      html: '<p>second</p>',
    });

    expect(mailer.sent).toEqual([
      { to: 'a@example.com', subject: 'Hi', text: 'first' },
      { to: 'b@example.com', subject: 'Hi', text: 'second', html: '<p>second</p>' },
    ]);
  });
});

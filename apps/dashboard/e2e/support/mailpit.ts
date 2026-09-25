import { expect } from '@playwright/test';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

interface MailpitSummary {
  ID: string;
  To: { Address: string }[];
  Subject: string;
  Created: string;
}

/** The newest message to `address` whose subject contains `subjectIncludes`. */
export async function latestMailTo(
  address: string,
  subjectIncludes: string,
): Promise<{ id: string; subject: string; text: string }> {
  let found: MailpitSummary | undefined;
  await expect
    .poll(
      async () => {
        const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=20`);
        const data = (await res.json()) as { messages: MailpitSummary[] };
        found = data.messages.find((m) => m.Subject.includes(subjectIncludes));
        return found?.ID ?? null;
      },
      { message: `mail to ${address} with subject containing "${subjectIncludes}"`, timeout: 20_000 },
    )
    .not.toBeNull();
  const res = await fetch(`${MAILPIT}/api/v1/message/${found!.ID}`);
  const message = (await res.json()) as { Text: string; Subject: string };
  return { id: found!.ID, subject: message.Subject, text: message.Text };
}

/** The first link in a mail's text body whose path starts with `path`. */
export function linkInMail(text: string, path: string): string {
  const match = text.match(new RegExp(`https?://[^\\s)]+${path.replace('/', '\\/')}[^\\s)]*`));
  if (!match) throw new Error(`no link with path ${path} in mail:\n${text}`);
  return match[0];
}

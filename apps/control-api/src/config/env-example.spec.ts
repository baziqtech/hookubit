import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { validateEnv } from './env.schema';

/**
 * THE ENV EXAMPLES ARE PARSED BY TWO DIFFERENT LANGUAGES.
 *
 * Each `.env.example` is copied to `.env` on the first deploy and from then on
 * read by dotenv (the Node control plane, via @nestjs/config) AND by systemd's
 * `EnvironmentFile=` (both units, and the Go data plane gets its entire
 * environment that way). dotenv and systemd are NOT the same format:
 *
 *   - systemd ignores `export`; dotenv strips it and keeps the assignment.
 *   - systemd treats a leading `;` as a comment; dotenv sees a broken line.
 *   - dotenv strips a trailing `# comment` from an unquoted value; systemd
 *     keeps it, so `KEY=value  # note` becomes the literal `value  # note`.
 *   - quoting and escaping rules differ inside quotes.
 *   - dotenv-expand would substitute `$VAR`; systemd never does.
 *
 * A line that means two different things in the two parsers hands the control
 * plane and the data plane DIFFERENT configuration out of one file, and both
 * processes then validate their own view happily. The two that matter most are
 * ENCRYPTION_KEY (the control API would write endpoint signing secrets the Go
 * worker cannot decrypt) and DATABASE_URL (ingest would write events the router
 * never reads).
 *
 * So every line is held to the intersection of the two formats - plain
 * `KEY=value` - and this spec proves it by parsing each file BOTH ways and
 * diffing the results. `MAIL_FROM=HookuBit <no-reply@example.com>` is the
 * interesting case: it is safe in both and must keep working UNQUOTED, which is
 * why the rule is "no quotes at all" rather than "quote values with spaces".
 */

/**
 * The EXACT dotenv @nestjs/config loads env files with, resolved through its
 * own module paths rather than imported as a dependency of this package.
 * dotenv is not a direct dependency here - it arrives under @nestjs/config -
 * and this is deliberately not "a dotenv": a transcription of dotenv's parser
 * would only prove that two of our own transcriptions agree with each other.
 */
const loadFromHere = createRequire(__filename);
const dotenvParse: (src: string) => Record<string, string> = (
  loadFromHere(
    loadFromHere.resolve('dotenv', { paths: [loadFromHere.resolve('@nestjs/config')] }),
  ) as { parse: (src: string) => Record<string, string> }
).parse;

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const EXAMPLES = {
  'common (.env.example)': join(REPO_ROOT, '.env.example'),
  'control plane (apps/control-api/.env.example)': join(
    REPO_ROOT,
    'apps',
    'control-api',
    '.env.example',
  ),
  'data plane (services/data-plane/.env.example)': join(
    REPO_ROOT,
    'services',
    'data-plane',
    '.env.example',
  ),
} as const;

/**
 * A faithful transcription of systemd's `EnvironmentFile=` parser, from the
 * rules in systemd.exec(5):
 *
 *   - a line ending in a backslash is concatenated with the next one;
 *   - empty lines, lines beginning with `;` or `#`, and lines with no `=` are
 *     ignored;
 *   - leading and trailing whitespace is stripped from the value, UNLESS it is
 *     wrapped in single or double quotes, in which case the quotes are removed
 *     and the inside is taken literally (double quotes additionally process
 *     C-style escapes - not modelled here, because a `\` inside a value is
 *     itself banned by the format rules this spec enforces);
 *   - there is NO variable expansion, so `$FOO` is four literal characters;
 *   - `export KEY=value` assigns a variable literally named `export KEY`,
 *     which systemd rejects as an invalid name.
 */
function parseSystemdEnvironmentFile(contents: string): Record<string, string> {
  const joined: string[] = [];
  let pending = '';
  for (const raw of contents.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.endsWith('\\') && !line.endsWith('\\\\')) {
      pending += line.slice(0, -1);
      continue;
    }
    joined.push(pending + line);
    pending = '';
  }
  if (pending !== '') joined.push(pending);

  const out: Record<string, string> = {};
  for (const line of joined) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Keys systemd will accept. Anything else is dropped with a warning. */
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

describe.each(Object.entries(EXAMPLES))('%s', (_label, path) => {
  const contents = readFileSync(path, 'utf8');
  const assignments = contents
    .split('\n')
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return trimmed !== '' && !trimmed.startsWith('#') && trimmed.includes('=');
    });

  it('parses IDENTICALLY under dotenv and under systemd EnvironmentFile rules', () => {
    const fromDotenv = dotenvParse(contents);
    const fromSystemd = parseSystemdEnvironmentFile(contents);

    // Compared as a single object so a failure prints the whole diff rather
    // than the first key that happens to differ.
    expect(fromSystemd).toEqual(fromDotenv);
  });

  it('declares at least one variable, so an empty file cannot pass vacuously', () => {
    expect(Object.keys(dotenvParse(contents)).length).toBeGreaterThan(0);
  });

  // The rules below are what MAKES the two parsers agree. Checking them line by
  // line means a future edit is told which line is wrong and why, instead of
  // being handed an object diff.
  it.each([
    ['a quote (the two disagree about escapes inside quotes)', /["'`]/],
    ['a $ (dotenv-expand would substitute it; systemd never does)', /\$/],
    ['a backslash (systemd joins a continued line; dotenv does not)', /\\/],
  ] as const)('contains no assignment with %s', (_what, pattern) => {
    const offenders = assignments.filter(({ text }) => pattern.test(text));
    expect(offenders.map(({ line, text }) => `${line}: ${text}`)).toEqual([]);
  });

  it('contains no `export` prefix - systemd would read it as part of the key', () => {
    const offenders = assignments.filter(({ text }) => /^\s*export\s/.test(text));
    expect(offenders.map(({ line, text }) => `${line}: ${text}`)).toEqual([]);
  });

  it('contains no trailing comment - dotenv strips it and systemd keeps it', () => {
    const offenders = assignments.filter(({ text }) => text.includes('#'));
    expect(offenders.map(({ line, text }) => `${line}: ${text}`)).toEqual([]);
  });

  it('uses only variable names systemd will accept', () => {
    const offenders = Object.keys(dotenvParse(contents)).filter((k) => !VALID_ENV_NAME.test(k));
    expect(offenders).toEqual([]);
  });

  it('has no duplicate assignment, which the two parsers could resolve differently', () => {
    const keys = assignments.map(({ text }) => text.trim().split('=')[0].trim());
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});

/**
 * `MAIL_FROM` is the one value in the product that naturally contains a space
 * and angle brackets, and the temptation is to quote it. It does not need
 * quoting and must not be quoted: unquoted, both parsers return the same
 * string, which is the whole reason the format rule above can be an absolute.
 */
describe('MAIL_FROM survives both parsers unquoted', () => {
  const line = 'MAIL_FROM=HookuBit <no-reply@example.com>';

  it('is the same string either way', () => {
    expect(dotenvParse(line).MAIL_FROM).toBe('HookuBit <no-reply@example.com>');
    expect(parseSystemdEnvironmentFile(line).MAIL_FROM).toBe('HookuBit <no-reply@example.com>');
  });

  it('and the schema accepts it', () => {
    const env = validateEnv({
      APP_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@db.example.com:5432/hookubit',
      JWT_SECRET: 'x'.repeat(32),
      SESSION_SECRET: 'x'.repeat(32),
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      SMTP_URL: 'smtp://mail.example.com:587',
      ...dotenvParse(line),
    });
    expect(env.MAIL_FROM).toBe('HookuBit <no-reply@example.com>');
  });
});

/**
 * The example is a TEMPLATE, and the hazard is asymmetric: whatever is present
 * in it and absent from the operator's own file is silently what they run. So
 * nothing the schema REQUIRES may carry a value here - it must be present and
 * empty, which makes `cp .env.example .env` on a server refuse to boot by name
 * instead of starting against somebody's laptop.
 */
describe('the examples are safe to copy verbatim onto a server', () => {
  const common = dotenvParse(readFileSync(EXAMPLES['common (.env.example)'], 'utf8'));
  const controlPlane = dotenvParse(
    readFileSync(EXAMPLES['control plane (apps/control-api/.env.example)'], 'utf8'),
  );
  const merged = { ...common, ...controlPlane };

  it.each([
    ['APP_ENV', common],
    ['DATABASE_URL', common],
    ['ENCRYPTION_KEY', common],
    ['JWT_SECRET', controlPlane],
    ['SESSION_SECRET', controlPlane],
  ] as const)('%s is present but EMPTY, so validation refuses loudly', (key, file) => {
    expect(Object.keys(file)).toContain(key);
    expect(file[key]).toBe('');
  });

  it('REFUSES to validate - a verbatim copy cannot boot', () => {
    expect(() => validateEnv(merged)).toThrow(/Invalid environment configuration/);
  });

  it('names every missing secret at once, rather than one per restart', () => {
    let message = '';
    try {
      validateEnv(merged);
    } catch (e) {
      message = (e as Error).message;
    }
    for (const key of ['APP_ENV', 'DATABASE_URL', 'JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY'])
      expect(message).toContain(key);
  });

  /**
   * The specific trap this rework closed. Every one of these used to be an
   * ACTIVE line with a value: APP_ENV=development turned the session cookie's
   * Secure flag off, TRUST_PROXY_HOPS=0 collapsed per-IP rate limiting into one
   * bucket, and DATABASE_URL/REDIS_URL/CORS_ORIGINS pointed a server at
   * localhost. DASHBOARD_URL is the same hazard aimed at end users: a value
   * here would be the base of every link the box mails, so a copied
   * http://localhost:5173 sends real password-reset mail with dead links.
   */
  it.each([
    'APP_ENV',
    'TRUST_PROXY_HOPS',
    'DASHBOARD_URL',
    'DATABASE_URL',
    'REDIS_URL',
    'CORS_ORIGINS',
  ])(
    '%s carries no value that could ship itself to production',
    (key) => {
      expect(merged[key] ?? '').toBe('');
    },
  );

  /**
   * The common file is the single source of truth for the variables BOTH planes
   * read. Duplicating one into a per-service file is the drift this split
   * exists to prevent: two ENCRYPTION_KEYs that disagree means the control API
   * encrypts endpoint secrets the Go worker cannot decrypt, and each process
   * validates its own configuration happily.
   */
  const SHARED = [
    'APP_ENV',
    'DATABASE_URL',
    'LOG_LEVEL',
    'REDIS_URL',
    'ENCRYPTION_KEY',
    'ENCRYPTION_KEY_ID',
    'ENCRYPTION_KEYS_RETIRED',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_SERVICE_NAMESPACE',
  ] as const;

  it.each(Object.entries(EXAMPLES).filter(([label]) => !label.startsWith('common')))(
    '%s redeclares none of the variables both planes read',
    (_label, path) => {
      const own = Object.keys(dotenvParse(readFileSync(path, 'utf8')));
      expect(own.filter((k) => (SHARED as readonly string[]).includes(k))).toEqual([]);
    },
  );
});

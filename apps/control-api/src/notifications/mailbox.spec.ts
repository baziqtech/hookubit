import { parseMailbox } from './mailbox';

describe('parseMailbox', () => {
  it('parses a display name plus address', () => {
    expect(parseMailbox('Hookubit <no-reply@hookubit.io>')).toEqual({
      name: 'Hookubit',
      address: 'no-reply@hookubit.io',
    });
  });

  it('strips quotes from a quoted display name', () => {
    expect(parseMailbox('"ShaQ Express" <ops@shaqexpress.com>')).toEqual({
      name: 'ShaQ Express',
      address: 'ops@shaqexpress.com',
    });
  });

  it('accepts a bare address, including a dotless local catcher host', () => {
    expect(parseMailbox('no-reply@localhost')).toEqual({ name: null, address: 'no-reply@localhost' });
    expect(parseMailbox('  no-reply@example.com  ')).toEqual({
      name: null,
      address: 'no-reply@example.com',
    });
  });

  it('treats empty angle-bracket names as no name', () => {
    expect(parseMailbox('<no-reply@example.com>')).toEqual({ name: null, address: 'no-reply@example.com' });
  });

  it.each(['', 'no-reply', 'Hookubit <not an address>', 'Hookubit <a@b@c>', 'a@b, c@d', '<>'])(
    'rejects %j',
    (value) => {
      expect(parseMailbox(value)).toBeNull();
    },
  );
});

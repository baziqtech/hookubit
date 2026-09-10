import { parseMailbox } from './mailbox';

describe('parseMailbox', () => {
  it('parses a display name plus address', () => {
    expect(parseMailbox('HookuBit <no-reply@hookubit.io>')).toEqual({
      name: 'HookuBit',
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

  it.each(['', 'no-reply', 'HookuBit <not an address>', 'HookuBit <a@b@c>', 'a@b, c@d', '<>'])(
    'rejects %j',
    (value) => {
      expect(parseMailbox(value)).toBeNull();
    },
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MailService } from '../src/mailer.js';

test('生产环境始终禁止开发验证码回显', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const mailer = new MailService({
      smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpPassword: '',
      smtpFrom: 'noreply@example.com', mailDevExposeCode: true, authCodeMinutes: 10,
    });
    assert.equal(mailer.available, false);
    await assert.rejects(
      mailer.sendCode({ email: 'user@example.com', code: '123456', purpose: 'passwordReset', siteName: 'Arenode' }),
      error => error.status === 503 && error.message === '邮件服务未配置',
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('SMTP transport verifies and sends codes and messages through a local server', { timeout: 10_000 }, async t => {
  const messages = []; const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8'); socket.write('220 fixture ESMTP\r\n');
    let buffer = ''; let data = null;
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data !== null) {
          if (line === '.') { messages.push(data.join('\r\n')); data = null; socket.write('250 accepted\r\n'); }
          else data.push(line);
        } else if (/^(EHLO|HELO|MAIL FROM:|RCPT TO:|RSET|NOOP)/i.test(line)) socket.write('250 OK\r\n');
        else if (line === 'DATA') { data = []; socket.write('354 End with a dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('500 Unsupported fixture command\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const mailer = new MailService({ smtpHost: '127.0.0.1', smtpPort: server.address().port, smtpSecure: false,
    smtpFrom: 'noreply@example.com', authCodeMinutes: 10 });
  assert.equal(await mailer.verify(), true);
  assert.deepEqual(await mailer.sendCode({ email: 'user@example.com', code: '246810', purpose: 'registration', siteName: 'Arenode' }), {});
  assert.deepEqual(await mailer.sendText({ email: 'user@example.com', subject: 'Local fixture', text: 'Deployment ready', siteName: 'Arenode' }), {});
  assert.equal(messages.length, 2);
  const encodedBody = messages[0].split('\r\n\r\n').slice(1).join('\r\n\r\n');
  const codeBody = /Content-Transfer-Encoding: base64/i.test(messages[0]) ? Buffer.from(encodedBody, 'base64').toString('utf8') : encodedBody;
  assert.match(codeBody, /验证码：246810/); assert.match(messages[0], /To: user@example\.com/);
  assert.match(messages[1], /Deployment ready/);
});

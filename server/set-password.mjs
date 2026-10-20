/* Set or change the admin password:  node server/set-password.mjs
   The password itself is never written anywhere — only a scrypt hash. */
import readline from 'readline';
import { hashPassword, saveCredentials } from './auth.mjs';

const ask = (q, hidden = false) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const onData = (char) => {
      if (['\n', '\r', '\u0004'].includes(String(char))) process.stdin.removeListener('data', onData);
      else readline.clearLine(process.stdout, 0), readline.cursorTo(process.stdout, 0), process.stdout.write(q + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
  }
  rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
});

const WEAK = ['password', 'qwerty', '123456', 'admin', 'bestobmin', 'пароль'];

const pass = await ask('Новий пароль: ', true);
if (pass.length < 12) {
  console.error('\nПароль закороткий — потрібно щонайменше 12 символів.');
  process.exit(1);
}
if (WEAK.some(w => pass.toLowerCase().includes(w))) {
  console.error('\nПароль містить надто очевидне слово. Візьміть інший.');
  process.exit(1);
}
const again = await ask('Повторіть пароль: ', true);
if (pass !== again) {
  console.error('\nПаролі не збігаються.');
  process.exit(1);
}

saveCredentials(hashPassword(pass));
console.log('\nГотово. Хеш збережено у data/auth.json (права 600, у git не потрапляє).');
console.log('Щоб тримати пароль поза диском, перенесіть salt і hash у змінні');
console.log('середовища ADMIN_PASSWORD_SALT та ADMIN_PASSWORD_HASH.');

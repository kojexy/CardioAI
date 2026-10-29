// Copy the CardioAI icon into the generated Android project (run after `npx cap add android`).
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const res = 'android/app/src/main/res';
if (!existsSync(res)) throw Error('Run `npx cap add android` first');
for (const dir of readdirSync(res).filter(d => d.startsWith('mipmap-') && d !== 'mipmap-anydpi-v26')) {
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png'])
    copyFileSync('app/icons/icon-192.png', join(res, dir, name));
}
// Without the adaptive-icon XML Android uses the PNGs above.
rmSync(join(res, 'mipmap-anydpi-v26'), { recursive: true, force: true });
console.log('Android icons updated');

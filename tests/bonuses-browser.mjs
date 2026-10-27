import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { installOnlineFixture } from './online-fixture.mjs';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4189', '--strictPort'], {stdio:'ignore'});
try {
  for (let i=0; i<80; i++) {
    try { if ((await fetch('http://127.0.0.1:4189')).ok) break; } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await mkdir('test-results', {recursive:true});
  for (const engine of process.argv.includes('--webkit') ? ['webkit'] : ['chromium']) {
    const browser = await (engine === 'chromium' ? chromium.launch({executablePath:'/usr/bin/chromium', args:['--no-sandbox','--enable-unsafe-swiftshader']}) : webkit.launch());
    try {
      const page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
      const errors=[];
      page.on('pageerror', e=>errors.push(e.message));
      page.on('console', m=>{if(m.type()==='error' && /WebGLProgram|INVALID_OPERATION/.test(m.text())) errors.push(m.text());});
      await installOnlineFixture(page);
      await page.addInitScript(()=>localStorage.setItem('dinorun-help-seen-v1','1'));
      await page.goto('http://127.0.0.1:4189/?debug&time=9');
      await page.waitForFunction(()=>window.__runner && document.querySelector('#app').dataset.phase==='ready');
      await page.tap('#action');
      const active = await page.evaluate(()=>{
        const r=window.__runner, g=r.game;
        r.pause();
        document.querySelector('#overlay').hidden=true;
        document.querySelector('#app').dataset.phase='running';
        g.landscape.enabled=false;
        g.world.active.fill(0);
        g.world.update=()=>{};
        g.phase='running';
        g.bonuses.activate(0);
        for(let i=0;i<120;i++) {g.step(1/120); if(i%4===0) r.render();}
        r.render();
        return r.stats();
      });
      assert.equal(active.bonusBackpackVisible,true);
      assert.ok(active.bonusSmokeCount>0);
      await page.screenshot({path:`test-results/${engine}-jetpack.png`});
      const hidden=await page.evaluate(()=>{
        const r=window.__runner,g=r.game;
        g.bonuses.activate(1);g.bonuses.activate(3);g.bonuses.activate(6);
        for(let i=0;i<60;i++)g.step(1/120);
        r.render();return r.stats();
      });
      assert.ok(hidden.playerOpacity<1);
      assert.ok(hidden.bonusFogStrength>0);
      await page.screenshot({path:`test-results/${engine}-blindness.png`});
      const restored=await page.evaluate(()=>{const r=window.__runner;r.game.reset(123);r.render();return r.stats();});
      assert.equal(restored.bonusBackpackVisible,false);
      assert.equal(restored.playerOpacity,1);
      assert.equal(restored.bonusFogStrength,0);
      assert.deepEqual(errors,[]);
      console.log(`${engine}: jetpack attachment/smoke, invisibility, blindness, reset and GPU shader checks passed`);
    } finally {await browser.close();}
  }
} finally {server.kill();}

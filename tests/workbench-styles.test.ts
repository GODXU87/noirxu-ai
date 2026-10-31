import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';

it('preserves the global custom select arrow when applying workbench field colors',()=>{
 const css=readFileSync('src/app/globals.css','utf8');
 const fields=css.match(/\.workbench :is\(input,textarea,select\)\s*\{([^}]+)\}/)?.[1];
 expect(fields).toBeDefined();
 // The global select suppresses native appearance and draws its own arrow.
 // A background shorthand here would erase that image and its positioning.
 expect(fields).not.toMatch(/(?:^|;)\s*background\s*:/);
 expect(fields).toMatch(/background-color\s*:/);
});
it('explicitly removes HUD panel decoration only within the editorial workbench',()=>{
 const css=readFileSync('src/app/hud.css','utf8');
 expect(css).toMatch(/\.ui-sasuke\.hud \.workbench > :is\(\.card,\.panel\)::after\s*\{\s*display:\s*none;/);
 expect(css).toMatch(/\.ui-sasuke\.hud \.workbench > :is\(\.card,\.panel\)\s*\{[^}]*background:\s*none;/);
});

import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const outDir = path.join(root, 'dist');
const fontDir = path.join(outDir, 'assets', 'fonts');

// Preserve every existing static route and asset. Only build/config files stay out of dist.
const skip = new Set(['.git', '.vercel', 'dist', 'node_modules', 'scripts', 'package.json', 'package-lock.json', 'vercel.json']);
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (skip.has(entry.name)) continue;
  await cp(path.join(root, entry.name), path.join(outDir, entry.name), { recursive: true });
}

await mkdir(fontDir, { recursive: true });
let html = await readFile(path.join(root, 'index.html'), 'utf8');

// Progressive enhancement: content is visible unless JavaScript has definitely initialized.
html = html.replace(
  '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <script>document.documentElement.classList.add("js")</script>'
);
html = html.replace(/(^|\n)(\s*)\[data-reveal\] \{/g, '$1$2html.js [data-reveal] {');
html = html.replace(/(^|\n)(\s*)\[data-reveal="left"\]/g, '$1$2html.js [data-reveal="left"]');
html = html.replace(/(^|\n)(\s*)\[data-reveal="right"\]/g, '$1$2html.js [data-reveal="right"]');
html = html.replace(/(^|\n)(\s*)\[data-reveal\]\.revealed/g, '$1$2html.js [data-reveal].revealed');

// Pause only motion that is safely outside the viewport. Visible elements retain identical animation.
html = html.replace(
  '    @keyframes orbit { to { transform: rotate(360deg); } }',
  `    .motion-paused *,\n    .motion-paused *::before,\n    .motion-paused *::after { animation-play-state: paused !important; }\n\n    @keyframes orbit { to { transform: rotate(360deg); } }`
);

const observerPatch = `
      // Keep all visible motion unchanged, but stop spending CPU/GPU on sections well off-screen.
      const motionSections = document.querySelectorAll('.hero, .built-section, .security-section, .footer');
      const motionObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          entry.target.classList.toggle('motion-paused', !entry.isIntersecting);
        });
      }, { rootMargin: '220px 0px 220px 0px', threshold: 0 });
      motionSections.forEach(section => motionObserver.observe(section));
`;
html = html.replace(
  '      const gridObserver = new IntersectionObserver(entries => {',
  observerPatch + '\n      const gridObserver = new IntersectionObserver(entries => {'
);

// Make the animated sample conversation sleep while the hero is off-screen or the tab is hidden.
html = html.replace(
  '      async function playConversation() {',
  `      let heroActive = true;\n      const heroSection = document.querySelector('.hero');\n      const heroActivityObserver = new IntersectionObserver(([entry]) => {\n        heroActive = entry.isIntersecting;\n      }, { rootMargin: '160px 0px 160px 0px', threshold: 0 });\n      if (heroSection) heroActivityObserver.observe(heroSection);\n\n      async function waitUntilHeroActive() {\n        while (!heroActive || document.hidden) await wait(300);\n      }\n\n      async function playConversation() {`
);
html = html.replace(
  '          for (const message of conversation) {\n            const typing = addTyping();',
  '          for (const message of conversation) {\n            await waitUntilHeroActive();\n            const typing = addTyping();'
);
html = html.replace(
  '          await wait(2600);\n          const bubbles = [...chatBody.children];',
  '          await wait(2600);\n          await waitUntilHeroActive();\n          const bubbles = [...chatBody.children];'
);

// Pause the canvas itself rather than only its CSS when off-screen.
html = html.replace(
  '        let frame = 0;\n        let nodes = [];',
  '        let frame = 0;\n        let canvasVisible = true;\n        let nodes = [];'
);
html = html.replace(
  '        function draw() {\n          frame = requestAnimationFrame(draw);',
  `        function draw() {\n          if (!canvasVisible || document.hidden) { frame = 0; return; }\n          frame = requestAnimationFrame(draw);`
);
html = html.replace(
  `        const resizeObserver = new ResizeObserver(resize);\n        resizeObserver.observe(canvas);\n        resize();\n        draw();\n\n        document.addEventListener('visibilitychange', () => {\n          if (document.hidden) cancelAnimationFrame(frame);\n          else draw();\n        });`,
  `        const resizeObserver = new ResizeObserver(resize);\n        resizeObserver.observe(canvas);\n        const canvasObserver = new IntersectionObserver(([entry]) => {\n          canvasVisible = entry.isIntersecting;\n          if (!canvasVisible && frame) { cancelAnimationFrame(frame); frame = 0; }\n          if (canvasVisible && !document.hidden && !frame) draw();\n        }, { rootMargin: '180px 0px 180px 0px', threshold: 0 });\n        canvasObserver.observe(canvas);\n        resize();\n        draw();\n\n        document.addEventListener('visibilitychange', () => {\n          if (document.hidden && frame) { cancelAnimationFrame(frame); frame = 0; }\n          else if (canvasVisible && !frame) draw();\n        });`
);

// Self-host the exact Google Fonts CSS and WOFF2 files. If the font service is unavailable
// during a build, retain the existing Google-hosted links instead of failing deployment.
const googleCssUrl = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=Public+Sans:wght@400;500;600;700&display=swap';
try {
  const cssResponse = await fetch(googleCssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/124 Safari/537.36' }
  });
  if (!cssResponse.ok) throw new Error(`Google Fonts CSS returned ${cssResponse.status}`);
  let fontCss = await cssResponse.text();
  const urls = [...fontCss.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(match => match[1]);
  const uniqueUrls = [...new Set(urls)];
  for (const url of uniqueUrls) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Font file returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
    const extension = new URL(url).pathname.split('.').pop() || 'woff2';
    const filename = `font-${hash}.${extension}`;
    await writeFile(path.join(fontDir, filename), bytes);
    fontCss = fontCss.split(url).join(`/assets/fonts/${filename}`);
  }
  await writeFile(path.join(fontDir, 'fonts.css'), fontCss, 'utf8');
  html = html
    .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com" \/>/, '')
    .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin \/>/, '')
    .replace(/\s*<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^\"]+" rel="stylesheet" \/>/, '\n  <link rel="preload" href="/assets/fonts/fonts.css" as="style" />\n  <link rel="stylesheet" href="/assets/fonts/fonts.css" />');
  console.log(`Self-hosted ${uniqueUrls.length} font files.`);
} catch (error) {
  console.warn(`Font self-hosting skipped safely: ${error.message}`);
}

await writeFile(path.join(outDir, 'index.html'), html, 'utf8');
console.log('Built optimized static site in dist/.');

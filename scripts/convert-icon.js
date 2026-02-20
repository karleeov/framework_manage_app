import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const svgPath = join(rootDir, 'resources', 'icon.svg');
const pngPath = join(rootDir, 'resources', 'icon.png');
const icoPath = join(rootDir, 'resources', 'icon.ico');

async function convertIcon() {
  // SVG to PNG (256x256)
  await sharp(svgPath)
    .resize(256, 256)
    .png()
    .toFile(pngPath);
  console.log('Created icon.png');

  // PNG to ICO (multiple sizes)
  const pngBuffer = await sharp(svgPath)
    .resize(256, 256)
    .png()
    .toBuffer();

  const icoBuffer = await pngToIco([pngBuffer]);
  writeFileSync(icoPath, icoBuffer);
  console.log('Created icon.ico');
}

convertIcon().catch(console.error);

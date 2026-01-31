const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const target = args[0] || 'chrome';
const isWatch = args.includes('--watch');

const srcDir = path.join(__dirname, '..', 'src');
const distDir = path.join(__dirname, '..', 'dist', target);

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Copy files to dist
function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
  console.log(`Copied: ${path.basename(src)}`);
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

function build() {
  console.log(`Building for ${target}...`);

  // Copy manifest
  const manifestSrc = path.join(__dirname, '..', `manifest.${target}.json`);
  const manifestDest = path.join(distDir, 'manifest.json');
  copyFile(manifestSrc, manifestDest);

  // Copy HTML files
  const htmlFiles = ['newtab.html'];
  htmlFiles.forEach(file => {
    const src = path.join(srcDir, file);
    if (fs.existsSync(src)) {
      copyFile(src, path.join(distDir, file));
    }
  });

  // Copy JS directory
  const jsSrc = path.join(srcDir, 'js');
  if (fs.existsSync(jsSrc)) {
    copyDir(jsSrc, path.join(distDir, 'js'));
  }

  // Copy CSS directory
  const cssSrc = path.join(srcDir, 'css');
  if (fs.existsSync(cssSrc)) {
    copyDir(cssSrc, path.join(distDir, 'css'));
  }

  // Copy icons directory
  const iconsSrc = path.join(srcDir, 'icons');
  if (fs.existsSync(iconsSrc)) {
    copyDir(iconsSrc, path.join(distDir, 'icons'));
  }

  // Copy locales directory
  const localesSrc = path.join(srcDir, 'locales');
  if (fs.existsSync(localesSrc)) {
    copyDir(localesSrc, path.join(distDir, '_locales'));
  }

  console.log(`Build complete: dist/${target}/`);
}

build();

if (isWatch) {
  console.log('Watching for changes...');
  fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
    console.log(`\nFile changed: ${filename}`);
    build();
  });
}

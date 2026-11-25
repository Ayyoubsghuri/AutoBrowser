// Browser identity helpers: make every profile look like the stock Chrome build
// that Electron is based on (same major version, consistent UA + client hints).
const os = require('os');

function chromeMajor() {
  return String(process.versions.chrome || '140.0.0.0').split('.')[0];
}

function platformToken() {
  switch (process.platform) {
    case 'win32': return { ua: 'Windows NT 10.0; Win64; x64', ch: 'Windows', chVersion: '"15.0.0"' };
    case 'darwin': return { ua: 'Macintosh; Intel Mac OS X 10_15_7', ch: 'macOS', chVersion: '"14.5.0"' };
    default: return { ua: 'X11; Linux x86_64', ch: 'Linux', chVersion: '"6.5.0"' };
  }
}

function identity(locale = 'en-US') {
  const major = chromeMajor();
  const full = process.versions.chrome || `${major}.0.0.0`;
  const p = platformToken();
  // Chrome's GREASE brand rotates per major; this shape matches current stable.
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not_A Brand', version: '99' },
  ];
  const fullVersionList = [
    { brand: 'Chromium', version: full },
    { brand: 'Google Chrome', version: full },
    { brand: 'Not_A Brand', version: '99.0.0.0' },
  ];
  const lang = locale.split('-')[0];
  return {
    userAgent: `Mozilla/5.0 (${p.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    brands,
    fullVersionList,
    secChUa: brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
    secChUaFull: fullVersionList.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
    platform: p.ch,
    platformVersion: p.chVersion,
    languages: lang === locale ? [locale] : [locale, lang],
    acceptLanguage: lang === locale ? locale : `${locale},${lang};q=0.9`,
    hardwareConcurrency: Math.min(os.cpus().length || 8, 16),
  };
}

module.exports = { identity };

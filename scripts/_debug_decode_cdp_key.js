const s = '76RTcrYRgRc/Cp2s2giR7oqc0oC8jXKdcgCz3nJ6Gj3Kqi1+Wxbi6XSTVW4SPdBQmMoQRmvXMpehYK2+qhXHaQ==';
const b = Buffer.from(s, 'base64');
console.log('length:', b.length);
console.log('hex:', b.toString('hex').slice(0,200));
console.log('utf8 prefix:', b.toString('utf8').slice(0,200));
console.log('is likely PEM?', b.toString('utf8').includes('-----BEGIN'));

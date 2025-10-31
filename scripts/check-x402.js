const functions = ['resource','mint','mint_hood','mint5','lucky','agent'];

(async ()=>{
  for (const name of functions) {
    try {
      const fn = require(`../netlify/functions/${name}.js`);
  const res = await fn.handler({ httpMethod: 'GET', headers: { host: 'example.test' }, path: `/${name}` });
      console.log('\n== ' + name + ' ==');
      console.log('statusCode:', res.statusCode);
      try {
        const body = JSON.parse(res.body);
        console.log('body.x402Version:', body.x402Version);
        console.log('accepts[0].resource:', body.accepts?.[0]?.resource);
      } catch (e) {
        console.log('body (raw):', res.body);
      }
    } catch (e) {
      console.error('Error calling', name, e);
    }
  }
})();

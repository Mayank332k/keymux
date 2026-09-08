const fs = require('fs');
let code = fs.readFileSync('src/proxy/server.ts', 'utf8');

code = code.replace(
    /let targetModel = config\.strictMode \? config\.defaultModel : \(anthropicReq\.model \|\| ep\.model \|\| config\.defaultModel \|\| MODEL_NAME\);/g,
    `let targetModel = config.strictMode ? config.defaultModel : (anthropicReq.model || ep.model || MODEL_NAME);`
);

fs.writeFileSync('src/proxy/server.ts', code);
